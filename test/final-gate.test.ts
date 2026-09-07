/**
 * The final gate.
 *
 * One objective, stated as a property rather than a list of cases:
 *
 *   **The action Binance receives must never differ, in any respect, from the
 *   action the policy engine judged.**
 *
 * Every defect this project has shipped and fixed — GW-02, GW-08, GW-09, GW-03,
 * SEC-03, SEC-04 — was a violation of exactly that sentence. Individual
 * regression tests pin the specific bugs; this file attacks the property itself
 * by sweeping the input space and inspecting what actually reached the wire.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aegis } from '../src/aegis.js';
import { ExecutionGateway, type FillReport, type OrderExecutor } from '../src/gateway/executor.js';
import { loadPolicyFromString } from '../src/policy/schema.js';
import type { NormalizedAction, PositionSnapshot, ProposedAction } from '../src/types.js';

const MARK = 100_000;
let dir: string;

interface WireOrder {
  venue: string;
  symbol: string | null;
  side: string | null;
  orderType: string | null;
  executionQuantity: number | null;
  sizingReference: number | null;
  notionalUsd: number;
  reduceOnly: boolean;
}

/** Captures exactly what would go on the wire. */
class Wire implements OrderExecutor {
  readonly orders: WireOrder[] = [];
  readonly cancelled: string[] = [];
  status = 'FILLED';

  async placeOrder(a: NormalizedAction): Promise<FillReport> {
    this.orders.push({
      venue: a.venue, symbol: a.symbol, side: a.side, orderType: a.orderType,
      executionQuantity: a.executionQuantity, sizingReference: a.sizingReference,
      notionalUsd: a.notionalUsd, reduceOnly: a.reduceOnly,
    });
    return {
      ok: true, orderId: `o-${this.orders.length}`, clientOrderId: a.id,
      symbol: a.symbol ?? '', status: this.status,
      filledNotionalUsd: this.status === 'FILLED' ? a.notionalUsd : 0,
      filledQuantity: this.status === 'FILLED' ? (a.executionQuantity ?? 0) : 0,
      realizedPnlUsd: 0, raw: {},
    };
  }

  async cancelAllOpenOrders(symbol: string): Promise<unknown> {
    this.cancelled.push(symbol);
    return { ok: true };
  }
}

const LONG: PositionSnapshot = {
  symbol: 'BTCUSDT', quantity: 0.02, entryPrice: MARK, markPrice: MARK,
  notionalUsd: 2_000, leverage: 2, unrealizedPnlUsd: 0,
};

function build(policy: string, positions: PositionSnapshot[] = []) {
  const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(policy) });
  aegis.updateAccount({ equityUsd: 10_000_000, positions, marks: { BTCUSDT: MARK, ETHUSDT: 4_000 } });
  const wire = new Wire();
  return { aegis, wire, gw: new ExecutionGateway(aegis, wire, { dataDir: dir, canceller: wire }) };
}

const OPEN = [
  'version: 1', 'name: gate', 'mode: enforce', 'default: allow',
  'limits:', '  maxNotionalUsdPerOrder: 1000',
].join('\n');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aegis-gate-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FINAL GATE — judged action === wire action', () => {
  test('sweeping the sizing input space produces no divergence on the wire', async () => {
    const { gw, wire } = build(OPEN);
    const types = ['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP_LOSS_LIMIT', 'OCO'] as const;
    let attempts = 0;

    for (const venue of ['spot', 'futures-usds'] as const) {
      for (const orderType of types) {
        for (const quantity of [undefined, 0.002, 0.5]) {
          for (const quoteQuantity of [undefined, 150, 900]) {
            for (const price of [undefined, 1, MARK, 150_000]) {
              attempts += 1;
              await gw.execute({
                id: `sweep-${attempts}`, category: 'trade', venue, symbol: 'BTCUSDT',
                side: 'BUY', orderType,
                ...(quantity !== undefined ? { quantity } : {}),
                ...(quoteQuantity !== undefined ? { quoteQuantity } : {}),
                ...(price !== undefined ? { price } : {}),
              } as ProposedAction);
            }
          }
        }
      }
    }

    assert.ok(attempts > 200, `expected a broad sweep, ran ${attempts}`);
    assert.ok(wire.orders.length > 0, 'the sweep must actually execute something, or it proves nothing');

    const divergent = wire.orders.filter((o) => {
      if (o.executionQuantity === null || o.sizingReference === null) return false;
      const implied = o.executionQuantity * o.sizingReference;
      return Math.abs(implied - o.notionalUsd) > Math.max(0.01, o.notionalUsd * 1e-6);
    });
    assert.deepEqual(divergent, [], 'every wire order must multiply back to the judged notional');
  });

  test('only authorised venues ever reach the wire', async () => {
    const { gw, wire } = build(OPEN);
    for (const venue of ['spot', 'futures-usds', 'margin', 'futures-coin', 'convert', 'wallet', 'market-data'] as const) {
      await gw.execute({
        id: `v-${venue}`, category: 'trade', venue, symbol: 'BTCUSDT',
        side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
      } as ProposedAction);
    }
    const seen = [...new Set(wire.orders.map((o) => o.venue))].sort();
    assert.deepEqual(seen, ['futures-usds', 'spot']);
  });

  test('the protective stop mirrors the entry it protects', async () => {
    const { gw, wire } = build(OPEN, [LONG]);
    await gw.execute({
      id: 'bracket', category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT',
      side: 'BUY', orderType: 'MARKET', quoteQuantity: 500, stopPrice: 95_000,
    });
    const entry = wire.orders.find((o) => o.orderType === 'MARKET' && !o.reduceOnly);
    const stop = wire.orders.find((o) => o.orderType === 'STOP_MARKET');
    assert.ok(entry && stop);
    assert.equal(stop.side, 'SELL');
    assert.equal(stop.reduceOnly, true);
    assert.equal(stop.executionQuantity, entry.executionQuantity);
  });

  test('denied, parked and out-of-capability actions all reach the wire zero times', async () => {
    const policy = [
      'version: 1', 'name: strict', 'mode: enforce', 'default: deny',
      'limits:', '  maxNotionalUsdPerOrder: 200',
      'allow:', '  categories: ["trade"]', '  venues: ["spot"]',
      'guards:', '  reviewAboveNotionalUsd: 100',
    ].join('\n');
    const { gw, wire } = build(policy);
    await gw.execute({ id: 'x1', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 5_000 });
    await gw.execute({ id: 'x2', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 150 });
    await gw.execute({ id: 'x3', category: 'withdraw', venue: 'wallet', asset: 'USDT', quantity: 1_000 });
    await gw.execute({ id: 'x4', category: 'trade', venue: 'margin', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 50 });
    assert.equal(wire.orders.length, 0);
  });

  test('a tampered approval ticket cannot amplify the order', async () => {
    const policy = [
      'version: 1', 'name: appr', 'mode: enforce', 'default: deny',
      'allow:', '  categories: ["trade"]', '  venues: ["spot"]',
      'guards:', '  reviewAboveNotionalUsd: 50',
    ].join('\n');
    const { gw, wire } = build(policy);
    const r = await gw.execute({
      id: 'ap', category: 'trade', venue: 'spot', symbol: 'BTCUSDT',
      side: 'BUY', orderType: 'MARKET', quoteQuantity: 120,
    });

    const file = join(dir, 'approvals.json');
    const store = JSON.parse(readFileSync(file, 'utf8')) as { tickets: Array<{ proposal: ProposedAction }> };
    (store.tickets[0] as { proposal: ProposedAction }).proposal.quoteQuantity = 999_999;
    writeFileSync(file, JSON.stringify(store));

    const out = await gw.approve(r.ticketId as string, 'attacker');
    assert.notEqual(out.status, 'executed');
    assert.equal(wire.orders.length, 0);
  });

  test('concurrency cannot produce a second wire order', async () => {
    const { aegis, gw, wire } = build(OPEN);
    const p: ProposedAction = {
      id: 'race', category: 'trade', venue: 'spot', symbol: 'BTCUSDT',
      side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
    };
    await Promise.all([gw.execute(p), gw.execute(p), gw.execute(p), gw.execute(p)]);
    assert.equal(wire.orders.length, 1);

    const sibling = new ExecutionGateway(aegis, wire, { dataDir: dir, canceller: wire });
    const before = wire.orders.length;
    const q = { ...p, id: 'race-2' };
    await Promise.all([sibling.execute(q), sibling.execute(q)]);
    assert.equal(wire.orders.length, before + 1, 'two gateways sharing a data dir still execute once');
  });

  test('with every breaker tripped and the halt engaged, the exit still reaches the wire', async () => {
    const policy = [
      'version: 1', 'name: locked', 'mode: enforce', 'default: deny',
      'limits:',
      '  maxNotionalUsdPerOrder: 10', '  maxDailyLossUsd: 1',
      '  maxOrdersPerMinute: 1', '  maxDrawdownPct: 1',
      'allow:', '  categories: ["trade", "cancel"]', '  venues: ["futures-usds"]',
      'guards:',
      '  requireStopLoss: true', '  cooldownSecondsAfterLoss: 99999', '  reviewAboveNotionalUsd: 1',
    ].join('\n');
    const { aegis, gw, wire } = build(policy, [LONG]);
    aegis.recordExecution({
      actionId: 'loss', category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT',
      notionalUsd: 500, realizedPnlUsd: -500,
    });
    aegis.halt('everything is on fire');

    const out = await gw.execute({
      id: 'exit', category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT',
      side: 'SELL', orderType: 'MARKET', quoteQuantity: 2_000, reduceOnly: true,
    });
    assert.equal(out.status, 'executed');
    assert.ok(wire.orders.some((o) => o.reduceOnly));
  });

  test('an unfilled order moves no counter; a filled one moves it exactly', async () => {
    const { aegis, gw, wire } = build(OPEN);
    wire.status = 'NEW';
    await gw.execute({ id: 'n', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 900 });
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 0);

    wire.status = 'FILLED';
    await gw.execute({ id: 'f', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 900 });
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 900);
  });
});
