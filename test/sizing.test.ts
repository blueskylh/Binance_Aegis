/**
 * Sizing canonicalization and execution-boundary regressions — GW-08 … GW-13.
 *
 * A third adversarial review found that GW-02 was fixed only along the path it
 * was discovered on. The underlying problem was never "the adapter re-derives
 * quantity"; it was that **an action could carry more than one description of
 * its own size**, and different layers believed different ones.
 *
 * Three live bypasses, all 100,000x:
 *
 *   { quoteQuantity: 100, quantity: 100 }  → judged $100, sends 100 BTC
 *   { quantity: 1, price: 1, MARKET }      → judged $1,   sends 1 BTC
 *   spot, same conflict                    → judged $100, sends 100 BTC
 *
 * The fix is not smarter precedence. It is refusing ambiguity outright, then
 * asserting after the fact that the resolved quantity and the judged notional
 * still describe the same trade.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aegis, DEFAULT_POLICY_YAML } from '../src/aegis.js';
import { ExecutionGateway, type FillReport, type OrderExecutor } from '../src/gateway/executor.js';
import { GATEWAY_CAPABILITIES, isExecutable } from '../src/gateway/capabilities.js';
import { normalizeAction, NormalizationError } from '../src/core/normalize.js';
import { loadPolicyFromString } from '../src/policy/schema.js';
import type { NormalizedAction, ProposedAction, RiskContext } from '../src/types.js';

const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);
const MARK = 100_000;
let dir: string;

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOON,
    equityUsd: 1_000_000,
    positions: [],
    marks: { BTCUSDT: MARK, ETHUSDT: 4_000 },
    counters: {
      dailyNotionalUsd: 0, dailyRealizedPnlUsd: 0, ordersLastMinute: 0,
      ordersLastHour: 0, lastLossAt: null, peakEquityUsd: 1_000_000,
    },
    recentActionIds: [],
    killSwitch: false,
    snapshotAgeMs: 0,
    ...over,
  };
}

const POLICY = [
  'version: 1', 'name: sizing', 'mode: enforce', 'default: deny',
  'limits:', '  maxNotionalUsdPerOrder: 500',
  'allow:',
  '  categories: ["read", "trade", "cancel"]',
  '  venues: ["spot", "futures-usds", "market-data"]',
  'guards:', '  reviewAboveNotionalUsd: 250',
].join('\n');

class Spy implements OrderExecutor {
  readonly placed: NormalizedAction[] = [];
  readonly cancelled: string[] = [];
  status = 'FILLED';

  async cancelAllOpenOrders(symbol: string): Promise<unknown> {
    this.cancelled.push(symbol);
    return { ok: true };
  }

  async placeOrder(action: NormalizedAction): Promise<FillReport> {
    this.placed.push(action);
    await new Promise((r) => setTimeout(r, 10));
    return {
      ok: true, orderId: `o-${this.placed.length}`, clientOrderId: action.id,
      symbol: action.symbol ?? '', status: this.status,
      filledNotionalUsd: action.notionalUsd,
      filledQuantity: action.executionQuantity ?? 0,
      realizedPnlUsd: 0, raw: {},
    };
  }
}

function makeGw(policy = POLICY) {
  const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(policy), clock: () => NOON });
  aegis.updateAccount({ equityUsd: 1_000_000, positions: [], marks: { BTCUSDT: MARK } });
  const spy = new Spy();
  return { aegis, spy, gw: new ExecutionGateway(aegis, spy, { dataDir: dir, canceller: spy }) };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aegis-sz-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// GW-08 — an action may describe its size exactly once
// ---------------------------------------------------------------------------

describe('GW-08 — conflicting sizing representations are refused', () => {
  test('quantity AND quoteQuantity together is malformed', () => {
    assert.throws(
      () => normalizeAction(
        { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100, quantity: 100 },
        ctx(),
      ),
      NormalizationError,
    );
  });

  test('the same conflict on spot is equally refused', () => {
    assert.throws(
      () => normalizeAction(
        { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100, quantity: 100 },
        ctx(),
      ),
      NormalizationError,
    );
  });

  test('the engine denies rather than throwing at the caller', () => {
    const { gw } = makeGw();
    const d = gw['aegis'].guard({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, quantity: 100,
    });
    assert.equal(d.verdict, 'deny');
  });

  test('the gateway never reaches the venue on a conflicted order', async () => {
    const { gw, spy } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, quantity: 100,
    });
    assert.equal(r.status, 'blocked');
    assert.equal(spy.placed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// GW-09 — a MARKET order is priced by the mark, never by a caller-supplied price
// ---------------------------------------------------------------------------

describe('GW-09 — MARKET orders cannot be under-priced by a supplied price', () => {
  test('quantity 1 with a fake price of 1 is judged at the real mark', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 1, price: 1 },
      ctx(),
    );
    assert.equal(a.notionalUsd, MARK, 'a MARKET order executes at the market, not at a number the caller invented');
    assert.equal(a.executionQuantity, 1);
  });

  test('such an order is then blocked by the notional cap', async () => {
    const { gw, spy } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quantity: 1, price: 1,
    });
    assert.equal(r.status, 'blocked');
    assert.equal(spy.placed.length, 0);
  });

  test('a LIMIT order still prices off its limit price', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quantity: 0.01, price: 90_000 },
      ctx(),
    );
    assert.equal(a.notionalUsd, 900);
  });

  test('a LIMIT price wildly away from the mark is caught by price-deviation', async () => {
    const { gw, spy } = makeGw(POLICY + '\n  priceDeviationPct: 5');
    const r = await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'LIMIT', quantity: 1, price: 1,
    });
    assert.equal(r.status, 'blocked');
    assert.equal(spy.placed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// GW-10 — the judged notional and the wire quantity must agree, always
// ---------------------------------------------------------------------------

describe('GW-10 — judged size equals wire size', () => {
  const cases: Array<{ name: string; action: ProposedAction; reference: number }> = [
    {
      name: 'futures, quote-sized',
      action: { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 400 },
      reference: MARK,
    },
    {
      name: 'futures, base-sized market',
      action: { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 0.004 },
      reference: MARK,
    },
    {
      name: 'futures, base-sized limit',
      action: { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quantity: 0.004, price: 99_000 },
      reference: 99_000,
    },
  ];

  for (const c of cases) {
    test(`${c.name}: quantity × reference === notional`, () => {
      const a = normalizeAction(c.action, ctx());
      assert.ok(a.executionQuantity !== null, 'derivatives always resolve a quantity');
      const implied = (a.executionQuantity as number) * c.reference;
      assert.ok(
        Math.abs(implied - a.notionalUsd) < 0.01,
        `judged $${a.notionalUsd} but would send ${a.executionQuantity} @ ${c.reference} = $${implied}`,
      );
    });
  }

  test('spot quote-sized keeps a null quantity so quoteOrderQty is used', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
      ctx(),
    );
    assert.equal(a.executionQuantity, null);
  });

  test('the normalized action records which reference priced it', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 400 },
      ctx(),
    );
    assert.equal(a.sizingReference, MARK);
  });
});

// ---------------------------------------------------------------------------
// GW-11 — resting leveraged entries would escape reconciliation, so refuse them
// ---------------------------------------------------------------------------

describe('GW-11 — leveraged entries must be synchronously reconcilable', () => {
  test('a LIMIT futures entry is refused by the gateway', async () => {
    const { gw, spy } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'LIMIT', quantity: 0.004, price: 99_000, stopPrice: 95_000,
    });
    assert.equal(r.status, 'blocked');
    assert.ok(r.decision.findings.some((f) => f.ruleId === 'unreconcilable-entry'));
    assert.equal(spy.placed.length, 0);
  });

  test('a MARKET futures entry is fine', async () => {
    const { gw, spy } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    assert.equal(r.status, 'executed');
    assert.ok(spy.placed.length >= 1);
  });

  test('a LIMIT futures EXIT is still permitted — exits are never blocked', async () => {
    const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
    aegis.updateAccount({
      equityUsd: 1_000_000,
      positions: [{
        symbol: 'BTCUSDT', quantity: 0.02, entryPrice: MARK, markPrice: MARK,
        notionalUsd: 2_000, leverage: 1, unrealizedPnlUsd: 0,
      }],
      marks: { BTCUSDT: MARK },
    });
    const spy = new Spy();
    const gw = new ExecutionGateway(aegis, spy, { dataDir: dir });
    const r = await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL',
      orderType: 'LIMIT', quantity: 0.01, price: 101_000, reduceOnly: true,
    });
    assert.equal(r.status, 'executed');
  });

  test('a spot LIMIT is permitted — no leverage, no liquidation risk', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'LIMIT', quantity: 0.004, price: 99_000,
    });
    assert.notEqual(r.status, 'blocked');
  });

  test('a partial fill cancels the remainder rather than leaving it unreconciled', async () => {
    const { aegis, gw, spy } = makeGw();
    spy.status = 'PARTIALLY_FILLED';
    const r = await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    assert.equal(r.status, 'executed');
    assert.equal(r.remainderCancelled, true, 'an unreconciled remainder is exposure Aegis cannot see');
    assert.deepEqual(spy.cancelled, ['BTCUSDT']);
    assert.ok(Number(aegis.status()['dailyNotionalUsd']) > 0);
  });
});

// ---------------------------------------------------------------------------
// GW-12 — one pending ticket per action id, and approval takes the reservation
// ---------------------------------------------------------------------------

describe('GW-12 — approval concurrency at the action level', () => {
  const parked: ProposedAction = {
    id: 'trade-001', category: 'trade', venue: 'spot', symbol: 'BTCUSDT',
    side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
  };

  test('a second execute of the same id does not mint a second ticket', async () => {
    const { gw } = makeGw();
    const r1 = await gw.execute(parked);
    const r2 = await gw.execute(parked);
    assert.equal(r1.status, 'pending-approval');
    assert.equal(r2.status, 'blocked', 'one action id, one pending decision');
    assert.equal(gw.listPending().length, 1);
  });

  test('the duplicate is explained, not silently dropped', async () => {
    const { gw } = makeGw();
    await gw.execute(parked);
    const r2 = await gw.execute(parked);
    assert.ok(r2.decision.findings.some((f) => f.ruleId === 'already-awaiting-approval'));
  });

  test('two tickets for one action can never both execute', async () => {
    // Even if two tickets somehow exist, approving both must place one order.
    const { aegis, gw, spy } = makeGw();
    const r1 = await gw.execute(parked);
    const gw2 = new ExecutionGateway(aegis, spy, { dataDir: dir });
    const outs = await Promise.all([
      gw.approve(r1.ticketId as string, 'op'),
      gw2.approve(r1.ticketId as string, 'op'),
    ]);
    assert.equal(outs.filter((o) => o.status === 'executed').length, 1);
    assert.equal(spy.placed.length, 1);
  });

  test('a dry-run approval does NOT consume the ticket', async () => {
    const { aegis, spy } = makeGw();
    const dryGw = new ExecutionGateway(aegis, spy, { dataDir: dir, dryRun: true });
    const r = await dryGw.execute(parked);
    const preview = await dryGw.approve(r.ticketId as string, 'op');
    assert.equal(preview.status, 'dry-run');
    assert.equal(dryGw.listPending().length, 1, 'a preview must not burn the ticket');

    const liveGw = new ExecutionGateway(aegis, spy, { dataDir: dir });
    const done = await liveGw.approve(r.ticketId as string, 'op');
    assert.equal(done.status, 'executed');
  });
});

// ---------------------------------------------------------------------------
// GW-13 — honest capabilities, honest defaults
// ---------------------------------------------------------------------------

describe('GW-13 — capabilities match what dispatch can actually do', () => {
  test('the gateway claims only what placeOrder implements', () => {
    assert.ok(isExecutable('trade', 'spot'));
    assert.ok(isExecutable('trade', 'futures-usds'));
    assert.ok(!isExecutable('cancel', 'spot'), 'dispatch has no cancel path; claiming it is a lie');
    assert.ok(!isExecutable('read', 'spot'));
    assert.equal(GATEWAY_CAPABILITIES.length, 2);
  });

  test('the built-in default policy enables every mandatory guard', () => {
    const p = loadPolicyFromString(DEFAULT_POLICY_YAML);
    assert.notEqual(p.limits.maxPositionSnapshotAgeSec, null, 'running with no policy file must not silently disable it');
    assert.notEqual(p.guards.maxStopDistancePct, null);
    assert.ok(p.deny.categories?.includes('withdraw'));
  });

  test('the built-in default policy parses and is deny-by-default', () => {
    const p = loadPolicyFromString(DEFAULT_POLICY_YAML);
    assert.equal(p.default, 'deny');
    assert.equal(p.mode, 'enforce');
  });
});

// ---------------------------------------------------------------------------
// GW-14 — the invariant, asserted by exhaustion
// ---------------------------------------------------------------------------

describe('GW-14 — judged size equals wire size across the whole input space', () => {
  test('no combination of sizing fields can make them diverge', () => {
    const types = ['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP_LOSS_LIMIT'] as const;
    const venues = ['spot', 'futures-usds'] as const;
    let checked = 0;
    const broken: string[] = [];

    for (const venue of venues) {
      for (const orderType of types) {
        for (const quantity of [undefined, 0.5, 2]) {
          for (const quoteQuantity of [undefined, 100, 50_000]) {
            for (const price of [undefined, 1, MARK, 1e9]) {
              const proposal = {
                category: 'trade', venue, symbol: 'BTCUSDT', side: 'BUY', orderType,
                ...(quantity !== undefined ? { quantity } : {}),
                ...(quoteQuantity !== undefined ? { quoteQuantity } : {}),
                ...(price !== undefined ? { price } : {}),
              } as ProposedAction;

              let a: NormalizedAction;
              try {
                a = normalizeAction(proposal, ctx());
              } catch {
                continue; // refusing ambiguity is the correct outcome
              }
              checked += 1;

              if (a.executionQuantity !== null && a.sizingReference !== null) {
                const implied = a.executionQuantity * a.sizingReference;
                const tolerance = Math.max(0.01, a.notionalUsd * 1e-6);
                if (Math.abs(implied - a.notionalUsd) > tolerance) {
                  broken.push(`${JSON.stringify(proposal)} judged ${a.notionalUsd} wire ${implied}`);
                }
              }
              if (venue === 'spot' && a.executionQuantity === null && quoteQuantity !== undefined) {
                if (a.notionalUsd !== quoteQuantity) {
                  broken.push(`spot quote mismatch: ${a.notionalUsd} vs ${quoteQuantity}`);
                }
              }
            }
          }
        }
      }
    }

    assert.ok(checked > 50, `expected broad coverage, only normalized ${checked}`);
    assert.deepEqual(broken, [], 'every accepted action must send exactly the size it was judged on');
  });

  test('extreme magnitudes stay self-consistent or are refused', () => {
    for (const [quantity, mark] of [[1e-9, MARK], [1e9, MARK], [0.1, 1e-8], [0.1, 1e12]] as const) {
      let a: NormalizedAction;
      try {
        a = normalizeAction(
          { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity },
          ctx({ marks: { BTCUSDT: mark } }),
        );
      } catch {
        continue;
      }
      const implied = (a.executionQuantity as number) * (a.sizingReference as number);
      assert.ok(Math.abs(implied - a.notionalUsd) <= Math.max(0.01, a.notionalUsd * 1e-6));
    }
  });

  test('every non-MARKET leveraged entry is refused by the gateway', async () => {
    const { gw, spy } = makeGw([
      'version: 1', 'name: open', 'mode: enforce', 'default: allow',
      'limits:', '  maxNotionalUsdPerOrder: 1000000',
    ].join('\n'));
    for (const orderType of ['LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP_LOSS_LIMIT', 'OCO'] as const) {
      const before = spy.placed.length;
      await gw.execute({
        id: `e-${orderType}`, category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT',
        side: 'BUY', orderType, quantity: 0.01, price: MARK, stopPrice: 95_000,
      });
      assert.equal(spy.placed.length, before, `${orderType} entry must not reach the venue`);
    }
  });
});
