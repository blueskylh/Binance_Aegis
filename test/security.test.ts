/**
 * Security regression suite.
 *
 * Every test here corresponds to a defect that was found in v1.0.0 by an
 * adversarial review and reproduced before being fixed. They exist to make
 * those specific failures impossible to reintroduce.
 *
 * The unifying theme: an invariant that is only asserted in a README is not an
 * invariant. Each one below is now asserted in code.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/core/engine.js';
import { classifyRisk } from '../src/core/normalize.js';
import { loadPolicyFromString } from '../src/policy/schema.js';
import { EXIT } from '../src/cli/exit.js';
import type { PositionSnapshot, ProposedAction, RiskContext } from '../src/types.js';

const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);

function longBtc(notionalUsd = 2_000): PositionSnapshot {
  return {
    symbol: 'BTCUSDT',
    quantity: notionalUsd / 100_000,
    entryPrice: 100_000,
    markPrice: 100_000,
    notionalUsd,
    leverage: 1,
    unrealizedPnlUsd: 0,
  };
}

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOON,
    equityUsd: 10_000,
    positions: [],
    marks: { BTCUSDT: 100_000, ETHUSDT: 4_000 },
    counters: {
      dailyNotionalUsd: 0,
      dailyRealizedPnlUsd: 0,
      ordersLastMinute: 0,
      ordersLastHour: 0,
      lastLossAt: null,
      peakEquityUsd: 10_000,
    },
    recentActionIds: [],
    killSwitch: false,
    snapshotAgeMs: 0,
    ...over,
  };
}

function policy(body: string[] = []) {
  return loadPolicyFromString([
    'version: 1',
    'name: sec',
    'mode: enforce',
    'default: deny',
    'allow:',
    '  categories: ["read", "trade", "cancel"]',
    '  venues: ["spot", "futures-usds", "market-data"]',
    ...body,
  ].join('\n'));
}

const ids = (d: ReturnType<typeof evaluate>): string[] => d.findings.map((f) => f.ruleId);

// ---------------------------------------------------------------------------
// SEC-01 — "The exit is never blocked" must hold against SIZE limits
// ---------------------------------------------------------------------------

describe('SEC-01 — size limits must never block a verified exit', () => {
  test('a $1,000 reduce-only close passes a $500 per-order cap', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 1_000, reduceOnly: true },
      policy(['limits:', '  maxNotionalUsdPerOrder: 500']),
      ctx({ positions: [longBtc(2_000)] }),
    );
    assert.equal(d.verdict, 'allow', 'a per-order cap must not trap a position');
    assert.ok(!ids(d).includes('max-notional-per-order'));
  });

  test('a reduce-only close passes an exhausted daily notional budget', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 800, reduceOnly: true },
      policy(['limits:', '  maxDailyNotionalUsd: 100']),
      ctx({ positions: [longBtc(2_000)], counters: { ...ctx().counters, dailyNotionalUsd: 100 } }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('a reduce-only close is never escalated to review', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 1_500, reduceOnly: true },
      policy(['guards:', '  reviewAboveNotionalUsd: 100']),
      ctx({ positions: [longBtc(2_000)] }),
    );
    assert.equal(d.verdict, 'allow', 'waiting for a human to approve an exit is how accounts blow up');
  });
});

// ---------------------------------------------------------------------------
// SEC-02 — the kill-switch must not trap a position either
// ---------------------------------------------------------------------------

describe('SEC-02 — the kill-switch must permit exits', () => {
  test('a reduce-only close is allowed while the kill-switch is engaged', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 100, reduceOnly: true },
      policy(),
      ctx({ killSwitch: true, positions: [longBtc(2_000)] }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('a NEW position is still blocked while the kill-switch is engaged', () => {
    const d = evaluate(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
      policy(),
      ctx({ killSwitch: true }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(ids(d).includes('kill-switch'));
  });

  test('cancels remain allowed while the kill-switch is engaged', () => {
    const d = evaluate({ category: 'cancel', venue: 'spot', symbol: 'BTCUSDT' }, policy(), ctx({ killSwitch: true }));
    assert.equal(d.verdict, 'allow');
  });
});

// ---------------------------------------------------------------------------
// SEC-03 — order type alone must not grant a risk-control bypass
// ---------------------------------------------------------------------------

describe('SEC-03 — STOP_MARKET / TAKE_PROFIT_MARKET bypass', () => {
  const breached = ctx({
    counters: { ...ctx().counters, dailyRealizedPnlUsd: -500, lastLossAt: NOON - 1_000 },
  });
  const strict = policy([
    'limits:', '  maxDailyLossUsd: 100',
    'guards:', '  cooldownSecondsAfterLoss: 3600', '  requireStopLoss: true',
  ]);

  test('an OPENING STOP_MARKET is treated as risk-increasing and blocked', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'STOP_MARKET', quoteQuantity: 400 },
      strict,
      breached,
    );
    assert.equal(d.verdict, 'deny', 'a stop-entry opens risk; the order type must not be a skeleton key');
    assert.ok(ids(d).includes('daily-loss-limit'));
    assert.ok(ids(d).includes('loss-cooldown'));
  });

  test('an OPENING TAKE_PROFIT_MARKET is likewise blocked', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'ETHUSDT', side: 'BUY', orderType: 'TAKE_PROFIT_MARKET', quoteQuantity: 400 },
      strict,
      breached,
    );
    assert.equal(d.verdict, 'deny');
  });

  test('a reduce-only STOP_MARKET against a real position IS risk-reducing', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', quoteQuantity: 400, reduceOnly: true },
      strict,
      ctx({
        positions: [longBtc(2_000)],
        counters: { ...ctx().counters, dailyRealizedPnlUsd: -500, lastLossAt: NOON - 1_000 },
      }),
    );
    assert.equal(d.verdict, 'allow', 'attaching protection to an open position must always be possible');
  });

  test('closePosition=true also counts as risk-reducing', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', quoteQuantity: 400, closePosition: true },
      strict,
      ctx({ positions: [longBtc(2_000)], counters: { ...ctx().counters, dailyRealizedPnlUsd: -500 } }),
    );
    assert.equal(d.verdict, 'allow');
  });
});

// ---------------------------------------------------------------------------
// SEC-04 — a reduceOnly claim is evidence, not proof
// ---------------------------------------------------------------------------

describe('SEC-04 — reduceOnly claims are validated against real positions', () => {
  test('reduceOnly on a symbol with NO position is not an exemption', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 5_000, reduceOnly: true },
      policy(['limits:', '  maxNotionalUsdPerOrder: 500']),
      ctx({ positions: [] }),
    );
    assert.equal(d.verdict, 'deny', 'a fabricated reduceOnly flag must not unlock the limits');
    assert.ok(ids(d).includes('unverified-reduce-only'));
  });

  test('reduceOnly larger than the position is capped and denied', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 9_000, reduceOnly: true },
      policy(['limits:', '  maxNotionalUsdPerOrder: 500']),
      ctx({ positions: [longBtc(1_000)] }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(ids(d).includes('unverified-reduce-only'));
  });

  test('reduceOnly within the position size is exempt', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 900, reduceOnly: true },
      policy(['limits:', '  maxNotionalUsdPerOrder: 500']),
      ctx({ positions: [longBtc(1_000)] }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('a reduce-only order on the same side as the position is not a reduction', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 900, reduceOnly: true },
      policy(['limits:', '  maxNotionalUsdPerOrder: 500']),
      ctx({ positions: [longBtc(1_000)] }),
    );
    assert.equal(d.verdict, 'deny', 'BUY cannot reduce a long');
  });

  test('classifyRisk explains itself', () => {
    const verdict = classifyRisk(
      {
        id: 'x', ts: NOON, category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT',
        asset: null, side: 'SELL', orderType: 'MARKET', quantity: null, price: null, leverage: null,
        reduceOnly: true, closePosition: false, hasStopLoss: false, stopPrice: null,
        executionQuantity: 0.005, sizingReference: 100000, destination: null,
        notionalUsd: 500, notionalBasis: 'quote-quantity', raw: {} as ProposedAction,
      },
      ctx({ positions: [longBtc(1_000)] }),
    );
    assert.equal(verdict.reducing, true);
    assert.equal(verdict.verified, true);
    assert.equal(verdict.positionNotionalUsd, 1_000);
    assert.ok(verdict.reason.length > 0);
  });
});

// ---------------------------------------------------------------------------
// SEC-05 — REVIEW must not be indistinguishable from ALLOW at the shell
// ---------------------------------------------------------------------------

describe('SEC-05 — exit codes distinguish review from allow', () => {
  test('the exit-code contract has four distinct values', () => {
    assert.equal(EXIT.ALLOW, 0);
    assert.equal(EXIT.DENY, 1);
    assert.equal(EXIT.USAGE, 2);
    assert.equal(EXIT.REVIEW, 3);
    const values = Object.values(EXIT);
    assert.equal(new Set(values).size, values.length, 'exit codes must be unique');
  });

  test('REVIEW is non-zero so `check && execute` cannot auto-run it', () => {
    assert.notEqual(EXIT.REVIEW, EXIT.ALLOW);
    assert.ok(EXIT.REVIEW > 0);
  });
});
