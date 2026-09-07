/**
 * Execution gateway tests.
 *
 * The gateway is the answer to the sharpest criticism of v1.0.0: two sibling MCP
 * servers plus a system-prompt instruction is *advice*, not enforcement — the
 * agent could always call Binance directly and skip the firewall.
 *
 * In gateway mode Aegis is the only component that holds execution credentials.
 * The agent has no Binance write tool at all, so "no Binance write without an
 * Aegis decision" becomes a property of the deployment rather than a promise.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aegis } from '../src/aegis.js';
import { ExecutionGateway, type FillReport, type OrderExecutor } from '../src/gateway/executor.js';
import { loadPolicyFromString } from '../src/policy/schema.js';
import type { NormalizedAction, ProposedAction } from '../src/types.js';

const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);
let dir: string;

const POLICY = [
  'version: 1',
  'name: gateway-test',
  'mode: enforce',
  'default: deny',
  'limits:',
  '  maxNotionalUsdPerOrder: 500',
  'allow:',
  '  categories: ["read", "trade", "cancel"]',
  '  venues: ["spot", "futures-usds", "market-data"]',
  'guards:',
  '  reviewAboveNotionalUsd: 200',
].join('\n');

/** Records every order it is asked to place, so we can assert on side effects. */
class SpyExecutor implements OrderExecutor {
  public readonly placed: NormalizedAction[] = [];
  public failNext = false;
  public slippageFactor = 1;

  async placeOrder(action: NormalizedAction): Promise<FillReport> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('venue rejected the order');
    }
    this.placed.push(action);
    return {
      ok: true,
      orderId: `ord-${this.placed.length}`,
      clientOrderId: action.id,
      symbol: action.symbol ?? '',
      status: 'FILLED',
      filledNotionalUsd: action.notionalUsd * this.slippageFactor,
      filledQuantity: action.executionQuantity ?? 0,
      realizedPnlUsd: 0,
      raw: { simulated: true },
    };
  }
}

function makeGateway(over: { policy?: string } = {}): { aegis: Aegis; gw: ExecutionGateway; spy: SpyExecutor } {
  const aegis = new Aegis({
    dataDir: dir,
    policy: loadPolicyFromString(over.policy ?? POLICY),
    clock: () => NOON,
  });
  aegis.updateAccount({
    equityUsd: 10_000,
    positions: [{
      symbol: 'BTCUSDT', quantity: 0.02, entryPrice: 100_000, markPrice: 100_000,
      notionalUsd: 2_000, leverage: 1, unrealizedPnlUsd: 0,
    }],
    marks: { BTCUSDT: 100_000, ETHUSDT: 4_000 },
  });
  const spy = new SpyExecutor();
  const gw = new ExecutionGateway(aegis, spy);
  return { aegis, gw, spy };
}

const smallBuy: ProposedAction = {
  category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aegis-gw-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gateway — allow path', () => {
  test('an allowed order is evaluated then actually executed', async () => {
    const { gw, spy } = makeGateway();
    const r = await gw.execute(smallBuy);
    assert.equal(r.status, 'executed');
    assert.equal(r.verdict, 'allow');
    assert.equal(spy.placed.length, 1);
    assert.equal(spy.placed[0]?.symbol, 'BTCUSDT');
    assert.ok(r.fill?.orderId);
  });

  test('counters advance from the REAL fill, not the requested size', async () => {
    const { aegis, gw, spy } = makeGateway();
    spy.slippageFactor = 1.5;              // venue filled 50% larger than asked
    await gw.execute(smallBuy);
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 150);
  });

  test('the decision and the execution are both in the ledger', async () => {
    const { aegis, gw } = makeGateway();
    await gw.execute(smallBuy);
    assert.equal(aegis.ledger.byType('decision').length, 1);
    assert.equal(aegis.ledger.byType('execution').length, 1);
    assert.equal(aegis.verifyLedger().ok, true);
  });
});

describe('gateway — deny path', () => {
  test('a denied order is NEVER passed to the venue', async () => {
    const { gw, spy } = makeGateway();
    const r = await gw.execute({ ...smallBuy, quoteQuantity: 5_000 });
    assert.equal(r.status, 'blocked');
    assert.equal(r.verdict, 'deny');
    assert.equal(spy.placed.length, 0, 'the gateway must not reach the venue on a deny');
    assert.equal(r.fill, null);
  });

  test('a denied order does not move the counters', async () => {
    const { aegis, gw } = makeGateway();
    await gw.execute({ ...smallBuy, quoteQuantity: 5_000 });
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 0);
  });

  test('an order blocked by the kill-switch never reaches the venue', async () => {
    const { aegis, gw, spy } = makeGateway();
    aegis.halt('test');
    const r = await gw.execute(smallBuy);
    assert.equal(r.status, 'blocked');
    assert.equal(spy.placed.length, 0);
  });
});

describe('gateway — review path requires a human', () => {
  test('a review verdict parks the order instead of executing it', async () => {
    const { gw, spy } = makeGateway();
    const r = await gw.execute({ ...smallBuy, quoteQuantity: 300 });
    assert.equal(r.status, 'pending-approval');
    assert.ok(r.ticketId);
    assert.equal(spy.placed.length, 0, 'nothing may execute before a human approves');
  });

  test('the pending order appears in the approval queue', async () => {
    const { gw } = makeGateway();
    await gw.execute({ ...smallBuy, quoteQuantity: 300 });
    const pending = gw.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.notionalUsd, 300);
  });

  test('approving the ticket executes it exactly once', async () => {
    const { gw, spy } = makeGateway();
    const r = await gw.execute({ ...smallBuy, quoteQuantity: 300 });
    const approved = await gw.approve(r.ticketId as string, 'operator');
    assert.equal(approved.status, 'executed');
    assert.equal(spy.placed.length, 1);

    // Replaying the same approval must not double-execute.
    const again = await gw.approve(r.ticketId as string, 'operator');
    assert.equal(again.status, 'failed');
    assert.equal(spy.placed.length, 1, 'a ticket is single-use');
  });

  test('rejecting a ticket removes it without executing', async () => {
    const { gw, spy } = makeGateway();
    const r = await gw.execute({ ...smallBuy, quoteQuantity: 300 });
    gw.reject(r.ticketId as string, 'operator said no');
    assert.equal(gw.listPending().length, 0);
    assert.equal(spy.placed.length, 0);
  });

  test('approving an unknown ticket fails safely', async () => {
    const { gw, spy } = makeGateway();
    const r = await gw.approve('no-such-ticket', 'operator');
    assert.equal(r.status, 'failed');
    assert.equal(spy.placed.length, 0);
  });

  test('an approved ticket is re-evaluated, so a later halt still blocks it', async () => {
    const { aegis, gw, spy } = makeGateway();
    const r = await gw.execute({ ...smallBuy, quoteQuantity: 300 });
    aegis.halt('conditions changed while awaiting approval');
    const approved = await gw.approve(r.ticketId as string, 'operator');
    assert.equal(approved.status, 'blocked');
    assert.equal(spy.placed.length, 0, 'approval is consent, not a bypass');
  });

  test('a ticket cannot be swapped for a different action', async () => {
    const { gw } = makeGateway();
    const r = await gw.execute({ ...smallBuy, quoteQuantity: 300 });
    const ticket = gw.listPending()[0];
    assert.ok(ticket);
    // The digest binds the approval to the exact action a human saw.
    assert.match(ticket.actionDigest, /^[0-9a-f]{64}$/);
    assert.equal(ticket.id, r.ticketId);
  });
});

describe('gateway — venue failures', () => {
  test('a venue rejection is reported and does not move the counters', async () => {
    const { aegis, gw, spy } = makeGateway();
    spy.failNext = true;
    const r = await gw.execute(smallBuy);
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /venue rejected/);
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 0, 'an unfilled order consumes no budget');
  });

  test('the ledger records the attempt even when the venue fails', async () => {
    const { aegis, gw, spy } = makeGateway();
    spy.failNext = true;
    await gw.execute(smallBuy);
    assert.ok(aegis.ledger.size() >= 2);
    assert.equal(aegis.verifyLedger().ok, true);
  });
});

describe('gateway — dry run', () => {
  test('dry run evaluates and reports but never touches the venue', async () => {
    const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
    aegis.updateAccount({ equityUsd: 10_000, positions: [], marks: { BTCUSDT: 100_000 } });
    const spy = new SpyExecutor();
    const gw = new ExecutionGateway(aegis, spy, { dryRun: true });

    const r = await gw.execute(smallBuy);
    assert.equal(r.status, 'dry-run');
    assert.equal(r.verdict, 'allow');
    assert.equal(spy.placed.length, 0);
  });
});
