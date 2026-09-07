/**
 * v2 hardening regression suite — GW-01 … GW-08.
 *
 * A second adversarial review of v2.0.0 found three critical execution-boundary
 * defects and several high-severity ones. They share a single theme, and it is a
 * different theme from the v1 findings:
 *
 *   v1 failed at "what should be allowed?"
 *   v2 failed at "is the thing I execute the same thing I judged?"
 *
 * The worst of them — GW-02 — had the policy engine approve a $100 order while
 * the adapter would have sent 100 BTC. A 100,000x amplification between the
 * decision and the wire is the most dangerous class of bug an execution firewall
 * can have, because every control above it was working perfectly.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aegis } from '../src/aegis.js';
import { ExecutionGateway, type FillReport, type OrderExecutor } from '../src/gateway/executor.js';
import { ApprovalStore } from '../src/gateway/approvals.js';
import { GATEWAY_CAPABILITIES, isExecutable } from '../src/gateway/capabilities.js';
import { normalizeAction, NormalizationError } from '../src/core/normalize.js';
import { loadPolicyFromString } from '../src/policy/schema.js';
import { VERSION } from '../src/version.js';
import type { NormalizedAction, PositionSnapshot, ProposedAction, RiskContext } from '../src/types.js';

const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);
let dir: string;

const POLICY = [
  'version: 1', 'name: gw-hardening', 'mode: enforce', 'default: deny',
  'limits:', '  maxNotionalUsdPerOrder: 500',
  'allow:',
  '  categories: ["read", "trade", "cancel"]',
  '  venues: ["spot", "futures-usds", "margin", "convert", "wallet", "market-data"]',
  'guards:', '  reviewAboveNotionalUsd: 200',
].join('\n');

const LONG_BTC: PositionSnapshot = {
  symbol: 'BTCUSDT', quantity: 0.02, entryPrice: 100_000, markPrice: 100_000,
  notionalUsd: 2_000, leverage: 2, unrealizedPnlUsd: 0,
};

class SpyExecutor implements OrderExecutor {
  readonly placed: NormalizedAction[] = [];
  status = 'FILLED';
  /** When set, the venue reports no fill numbers at all. */
  omitFillData = false;

  async placeOrder(action: NormalizedAction): Promise<FillReport> {
    this.placed.push(action);
    return {
      ok: true,
      orderId: `ord-${this.placed.length}`,
      clientOrderId: action.id,
      symbol: action.symbol ?? '',
      status: this.status,
      filledNotionalUsd: this.omitFillData ? 0 : action.notionalUsd,
      filledQuantity: this.omitFillData ? 0 : (action.executionQuantity ?? 0),
      realizedPnlUsd: 0,
      raw: {},
    };
  }
}

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOON,
    equityUsd: 10_000,
    positions: [],
    marks: { BTCUSDT: 100_000, ETHUSDT: 4_000 },
    counters: {
      dailyNotionalUsd: 0, dailyRealizedPnlUsd: 0, ordersLastMinute: 0,
      ordersLastHour: 0, lastLossAt: null, peakEquityUsd: 10_000,
    },
    recentActionIds: [],
    killSwitch: false,
    snapshotAgeMs: 0,
    ...over,
  };
}

function makeGw(over: { positions?: PositionSnapshot[] } = {}) {
  const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
  aegis.updateAccount({
    equityUsd: 10_000,
    positions: over.positions ?? [LONG_BTC],
    marks: { BTCUSDT: 100_000, ETHUSDT: 4_000 },
  });
  const spy = new SpyExecutor();
  const gw = new ExecutionGateway(aegis, spy, { dataDir: dir });
  return { aegis, gw, spy };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aegis-gw2-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// GW-01 — approval tickets must survive process exit
// ---------------------------------------------------------------------------

describe('GW-01 — approval tickets are durable across processes', () => {
  test('a ticket parked by one gateway is visible to a fresh one', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });
    assert.equal(r.status, 'pending-approval');

    // A completely separate gateway — the CLI's `aegis pending` in a new process.
    const { gw: gw2 } = makeGw();
    const pending = gw2.listPending();
    assert.equal(pending.length, 1, 'the ticket must outlive the process that created it');
    assert.equal(pending[0]?.id, r.ticketId);
  });

  test('a ticket parked by one gateway can be approved by another', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });

    const { gw: gw2, spy: spy2 } = makeGw();
    const approved = await gw2.approve(r.ticketId as string, 'operator');
    assert.equal(approved.status, 'executed');
    assert.equal(spy2.placed.length, 1);
  });

  test('a ticket stays single-use across processes', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });
    await makeGw().gw.approve(r.ticketId as string, 'operator');

    const { gw: gw3, spy: spy3 } = makeGw();
    const again = await gw3.approve(r.ticketId as string, 'operator');
    assert.equal(again.status, 'failed');
    assert.equal(spy3.placed.length, 0, 'a consumed ticket must never execute twice');
  });

  test('rejection persists too', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });
    makeGw().gw.reject(r.ticketId as string, 'no');
    assert.equal(makeGw().gw.listPending().length, 0);
  });

  test('the store file is written atomically and is valid JSON', async () => {
    const { gw } = makeGw();
    await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });
    const raw = readFileSync(join(dir, 'approvals.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  test('a corrupt store degrades to empty rather than crashing', () => {
    const path = join(dir, 'approvals.json');
    writeFileSync(path, '{not json');
    const reopened = new ApprovalStore(path);
    assert.deepEqual(reopened.listPending(NOON), [], 'the safe failure is "nothing approved"');
  });
});

// ---------------------------------------------------------------------------
// GW-02 — the engine must judge the exact order that will be sent
// ---------------------------------------------------------------------------

describe('GW-02 — execution quantity is resolved and judged, never re-derived', () => {
  test('a futures quote-sized order resolves an execution quantity from the mark', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
      ctx(),
    );
    assert.equal(a.notionalUsd, 100);
    assert.equal(a.executionQuantity, 0.001, '$100 / $100,000 = 0.001 BTC, NOT 100');
  });

  test('the resolved quantity round-trips back to the judged notional', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 250 },
      ctx(),
    );
    const impliedNotional = (a.executionQuantity as number) * 100_000;
    assert.ok(Math.abs(impliedNotional - a.notionalUsd) < 0.01, 'what is sent must equal what was judged');
  });

  test('an explicit quantity is preserved verbatim', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 0.5 },
      ctx(),
    );
    assert.equal(a.executionQuantity, 0.5);
  });

  test('a limit order sizes off the limit price, not the mark', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quoteQuantity: 900, price: 90_000 },
      ctx(),
    );
    assert.equal(a.executionQuantity, 0.01);
  });

  test('a derivatives order that cannot be sized fails closed', () => {
    assert.throws(
      () => normalizeAction(
        { category: 'trade', venue: 'futures-usds', symbol: 'DOGEUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
        ctx(),
      ),
      NormalizationError,
    );
  });

  test('the gateway hands the venue the resolved quantity', async () => {
    const { gw, spy } = makeGw();
    await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    assert.ok(spy.placed.length >= 1);
    assert.equal(spy.placed[0]?.executionQuantity, 0.001, 'the entry must carry the judged quantity');
    assert.notEqual(spy.placed[0]?.executionQuantity, 100, 'never the raw notional');
  });

  test('spot quote-sized orders may still use quoteOrderQty', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
      ctx(),
    );
    assert.equal(a.executionQuantity, null, 'spot can size in quote terms natively');
    assert.equal(a.notionalUsd, 100);
  });
});

// ---------------------------------------------------------------------------
// GW-03 — unsupported capabilities must fail closed, never reroute
// ---------------------------------------------------------------------------

describe('GW-03 — the gateway executes only what it actually supports', () => {
  test('the capability matrix is explicit and narrow', () => {
    assert.ok(isExecutable('trade', 'spot'));
    assert.ok(isExecutable('trade', 'futures-usds'));
    assert.ok(isExecutable('cancel', 'spot'));
    assert.ok(!isExecutable('trade', 'margin'));
    assert.ok(!isExecutable('trade', 'futures-coin'));
    assert.ok(!isExecutable('trade', 'convert'));
    assert.ok(!isExecutable('transfer', 'wallet'));
    assert.ok(!isExecutable('withdraw', 'wallet'));
    assert.ok(GATEWAY_CAPABILITIES.length > 0);
  });

  for (const venue of ['margin', 'convert', 'wallet'] as const) {
    test(`a ${venue} trade is denied, not silently routed to spot`, async () => {
      const { gw, spy } = makeGw();
      const r = await gw.execute({
        category: 'trade', venue, symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
      } as ProposedAction);
      assert.equal(r.status, 'blocked');
      assert.equal(spy.placed.length, 0, `a ${venue} order must never reach the spot endpoint`);
      assert.ok(r.decision.findings.some((f) => f.ruleId === 'unsupported-execution-capability'));
    });
  }

  test('the denial names what IS supported', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'margin', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
    });
    const finding = r.decision.findings.find((f) => f.ruleId === 'unsupported-execution-capability');
    assert.match(String(finding?.message), /spot/i);
  });

  test('advisory checks still evaluate unsupported venues normally', () => {
    // The capability limit is a property of EXECUTION, not of policy evaluation.
    const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
    aegis.updateAccount({ equityUsd: 10_000, positions: [], marks: { BTCUSDT: 100_000 } });
    const d = aegis.guard({
      category: 'trade', venue: 'margin', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
    });
    assert.ok(!d.findings.some((f) => f.ruleId === 'unsupported-execution-capability'));
  });
});

// ---------------------------------------------------------------------------
// GW-04 — counters settle from real fills, or not at all
// ---------------------------------------------------------------------------

describe('GW-04 — fill reconciliation is status-aware', () => {
  test('an unfilled NEW order consumes no budget', async () => {
    const { aegis, gw, spy } = makeGw();
    spy.status = 'NEW';
    spy.omitFillData = true;
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quoteQuantity: 100, price: 99_000,
    });
    assert.equal(r.status, 'accepted-unfilled');
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 0, 'a resting order is not a fill');
  });

  test('a rejected order consumes no budget', async () => {
    const { aegis, gw, spy } = makeGw();
    spy.status = 'REJECTED';
    spy.omitFillData = true;
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
    });
    assert.equal(r.status, 'failed');
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 0);
  });

  test('a FILLED order settles the real number', async () => {
    const { aegis, gw } = makeGw();
    await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
    });
    assert.equal(Number(aegis.status()['dailyNotionalUsd']), 100);
  });

  test('missing fill data never falls back to the requested size', async () => {
    const { aegis, gw, spy } = makeGw();
    spy.status = 'FILLED';
    spy.omitFillData = true;
    await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 400,
    });
    assert.equal(
      Number(aegis.status()['dailyNotionalUsd']), 0,
      'reporting a request as a fill is exactly the lie this whole design exists to prevent',
    );
  });
});

// ---------------------------------------------------------------------------
// GW-05 — stale position data must not authorise an exit exemption
// ---------------------------------------------------------------------------

describe('GW-05 — snapshot freshness gates reduce-only verification', () => {
  test('a fresh snapshot allows a verified exit', () => {
    const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
    aegis.updateAccount({ equityUsd: 10_000, positions: [LONG_BTC], marks: { BTCUSDT: 100_000 } });
    const d = aegis.guard({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL',
      orderType: 'MARKET', quoteQuantity: 1_000, reduceOnly: true,
    });
    assert.equal(d.verdict, 'allow');
  });

  test('a stale snapshot refuses the exemption rather than guessing', () => {
    const policy = loadPolicyFromString([
      'version: 1', 'name: stale', 'mode: enforce', 'default: deny',
      'limits:', '  maxPositionSnapshotAgeSec: 60',
      'allow:',
      '  categories: ["read", "trade", "cancel"]',
      '  venues: ["spot", "futures-usds", "market-data"]',
    ].join('\n'));
    const aegis = new Aegis({ dataDir: dir, policy, clock: () => NOON });
    aegis.updateAccount({ equityUsd: 10_000, positions: [LONG_BTC], marks: { BTCUSDT: 100_000 } });
    const d = aegis.evaluateWith({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL',
      orderType: 'MARKET', quoteQuantity: 1_000, reduceOnly: true,
    }, { snapshotAgeMs: 3_600_000 });
    assert.ok(d.findings.some((f) => f.ruleId === 'stale-position-data'));
    assert.equal(d.verdict, 'deny');
  });
});

// ---------------------------------------------------------------------------
// GW-06 — a stop-loss claim is evidence, not proof
// ---------------------------------------------------------------------------

describe('GW-06 — protective stops are validated, not believed', () => {
  const strict = loadPolicyFromString([
    'version: 1', 'name: stops', 'mode: enforce', 'default: deny',
    'allow:', '  categories: ["trade"]', '  venues: ["futures-usds"]',
    'guards:', '  requireStopLoss: true',
  ].join('\n'));

  function guard(proposal: ProposedAction) {
    const aegis = new Aegis({ dataDir: dir, policy: strict, clock: () => NOON });
    aegis.updateAccount({ equityUsd: 10_000, positions: [], marks: { BTCUSDT: 100_000 } });
    return aegis.guard(proposal);
  }

  test('a bare hasStopLoss:true claim is no longer sufficient', () => {
    const d = guard({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, hasStopLoss: true,
    });
    assert.equal(d.verdict, 'deny');
    assert.ok(d.findings.some((f) => f.ruleId === 'require-stop-loss'));
  });

  test('a concrete stopPrice on the correct side is accepted', () => {
    const d = guard({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    assert.equal(d.verdict, 'allow');
  });

  test('a stop above the entry on a long is rejected', () => {
    const d = guard({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 105_000,
    });
    assert.equal(d.verdict, 'deny');
    assert.ok(d.findings.some((f) => f.ruleId === 'invalid-stop-price'));
  });

  test('a stop below the entry on a short is rejected', () => {
    const d = guard({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    assert.equal(d.verdict, 'deny');
    assert.ok(d.findings.some((f) => f.ruleId === 'invalid-stop-price'));
  });

  test('the gateway places the protective stop after the entry fills', async () => {
    const { gw, spy } = makeGw();
    await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    assert.equal(spy.placed.length, 2, 'entry plus its protective stop');
    assert.equal(spy.placed[1]?.orderType, 'STOP_MARKET');
    assert.equal(spy.placed[1]?.side, 'SELL');
    assert.equal(spy.placed[1]?.reduceOnly, true);
  });
});

// ---------------------------------------------------------------------------
// GW-07 — one version number
// ---------------------------------------------------------------------------

describe('GW-07 — version is defined once and used everywhere', () => {
  test('the shared constant is 2.x', () => {
    assert.match(VERSION, /^2\.\d+\.\d+$/);
  });

  test('package.json agrees with the shared constant', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(pkg.version, VERSION);
  });
});
