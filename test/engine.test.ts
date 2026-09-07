import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/core/engine.js';
import { loadPolicyFromString } from '../src/policy/schema.js';
import type { Policy, ProposedAction, RiskContext } from '../src/types.js';

// 2026-09-07T12:00:00Z — fixed clock keeps every assertion deterministic.
const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOON,
    equityUsd: 10_000,
    positions: [],
    marks: { BTCUSDT: 100_000, ETHUSDT: 4_000, BNBUSDT: 1_000, SOLUSDT: 200 },
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

function policy(body: string[] = []): Policy {
  return loadPolicyFromString([
    'version: 1',
    'name: test-policy',
    'mode: enforce',
    'default: deny',
    'allow:',
    '  categories: ["read", "trade", "cancel", "transfer", "onchain"]',
    '  venues: ["spot", "futures-usds", "market-data", "wallet", "convert"]',
    ...body,
  ].join('\n'));
}

const BUY_100: ProposedAction = {
  category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
};

function findingIds(d: ReturnType<typeof evaluate>): string[] {
  return d.findings.map((f) => f.ruleId);
}

// ---------------------------------------------------------------------------

describe('engine — baseline', () => {
  test('allows a compliant order', () => {
    const d = evaluate(BUY_100, policy(), ctx());
    assert.equal(d.verdict, 'allow');
    assert.ok(d.summary.length > 0);
  });

  test('deny-by-default blocks a category not on the allowlist', () => {
    const p = loadPolicyFromString(['version: 1', 'name: t', 'mode: enforce', 'default: deny'].join('\n'));
    const d = evaluate(BUY_100, p, ctx());
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('default-posture'));
  });

  test('default: allow lets an unmatched action through', () => {
    const p = loadPolicyFromString(['version: 1', 'name: t', 'mode: enforce', 'default: allow'].join('\n'));
    assert.equal(evaluate(BUY_100, p, ctx()).verdict, 'allow');
  });

  test('a malformed action is denied, never thrown to the caller', () => {
    const d = evaluate({ category: 'trade', venue: 'spot', symbol: 'BTCUSDT' } as ProposedAction, policy(), ctx());
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('malformed-action'));
  });

  test('every finding carries a rule id, severity and message', () => {
    const d = evaluate(BUY_100, policy(['limits:', '  maxNotionalUsdPerOrder: 10']), ctx());
    for (const f of d.findings) {
      assert.ok(f.ruleId, 'ruleId');
      assert.ok(['info', 'warn', 'critical'].includes(f.severity));
      assert.ok(typeof f.message === 'string' && f.message.length > 0);
    }
  });
});

describe('rule: kill-switch', () => {
  test('denies every risk-increasing action when engaged', () => {
    const d = evaluate(BUY_100, policy(), ctx({ killSwitch: true }));
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('kill-switch'));
  });

  test('still allows cancels so the operator can flatten', () => {
    const d = evaluate({ category: 'cancel', venue: 'spot', symbol: 'BTCUSDT' }, policy(), ctx({ killSwitch: true }));
    assert.equal(d.verdict, 'allow');
  });

  test('still allows reads', () => {
    const d = evaluate({ category: 'read', venue: 'market-data' }, policy(), ctx({ killSwitch: true }));
    assert.equal(d.verdict, 'allow');
  });

  test('overrides even a default: allow policy', () => {
    const p = loadPolicyFromString(['version: 1', 'name: t', 'mode: enforce', 'default: allow'].join('\n'));
    assert.equal(evaluate(BUY_100, p, ctx({ killSwitch: true })).verdict, 'deny');
  });
});

describe('rule: category / venue / symbol access', () => {
  test('denies a category on the denylist even if also allowlisted', () => {
    const p = policy(['deny:', '  categories: ["transfer"]']);
    const d = evaluate({ category: 'transfer', venue: 'wallet', asset: 'USDT', quantity: 100 }, p, ctx());
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('category-denylist'));
  });

  test('withdraw is denied unless explicitly allowlisted', () => {
    const d = evaluate({ category: 'withdraw', venue: 'wallet', asset: 'USDT', quantity: 10 }, policy(), ctx());
    assert.equal(d.verdict, 'deny');
  });

  test('a withdrawal is sized correctly and blocked by the denylist, not by a parse failure', () => {
    const p = policy(['deny:', '  categories: ["withdraw"]']);
    const d = evaluate(
      { category: 'withdraw', venue: 'wallet', asset: 'USDT', quantity: 5_000, destination: '0xattacker' },
      p,
      ctx(),
    );
    assert.equal(d.verdict, 'deny');
    const ids = findingIds(d);
    assert.ok(ids.includes('category-denylist'), 'must be a policy denial');
    assert.ok(!ids.includes('malformed-action'), 'must not fall back to a parse failure');
    assert.equal(d.action.notionalUsd, 5_000);
  });

  test('denies a venue outside the allowlist', () => {
    const d = evaluate({ ...BUY_100, venue: 'margin' }, policy(), ctx());
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('venue-allowlist'));
  });

  test('denies a symbol outside the allowlist', () => {
    const p = policy(['limits:', '  maxNotionalUsdPerOrder: 1000']);
    const withSymbols = loadPolicyFromString([
      'version: 1', 'name: t', 'mode: enforce', 'default: deny',
      'allow:', '  categories: ["trade"]', '  venues: ["spot"]', '  symbols: ["ETHUSDT"]',
    ].join('\n'));
    void p;
    const d = evaluate(BUY_100, withSymbols, ctx());
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('symbol-allowlist'));
  });

  test('symbol allowlist matching is case-insensitive', () => {
    const p = loadPolicyFromString([
      'version: 1', 'name: t', 'mode: enforce', 'default: deny',
      'allow:', '  categories: ["trade"]', '  venues: ["spot"]', '  symbols: ["btcusdt"]',
    ].join('\n'));
    assert.equal(evaluate(BUY_100, p, ctx()).verdict, 'allow');
  });

  test('denies a symbol on the denylist', () => {
    const p = policy(['deny:', '  symbols: ["BTCUSDT"]']);
    const d = evaluate(BUY_100, p, ctx());
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('symbol-denylist'));
  });
});

describe('rule: notional and exposure limits', () => {
  test('denies an order above the per-order notional cap', () => {
    const d = evaluate(BUY_100, policy(['limits:', '  maxNotionalUsdPerOrder: 50']), ctx());
    assert.equal(d.verdict, 'deny');
    const f = d.findings.find((x) => x.ruleId === 'max-notional-per-order');
    assert.equal(f?.observed, 100);
    assert.equal(f?.limit, 50);
  });

  test('allows an order exactly at the cap (inclusive boundary)', () => {
    assert.equal(evaluate(BUY_100, policy(['limits:', '  maxNotionalUsdPerOrder: 100']), ctx()).verdict, 'allow');
  });

  test('denies when the order would breach the daily notional budget', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxDailyNotionalUsd: 150']),
      ctx({ counters: { ...ctx().counters, dailyNotionalUsd: 80 } }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('max-daily-notional'));
  });

  test('daily notional counts the prospective order, not just history', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxDailyNotionalUsd: 200']),
      ctx({ counters: { ...ctx().counters, dailyNotionalUsd: 80 } }),
    );
    assert.equal(d.verdict, 'allow', '80 + 100 = 180 <= 200');
  });

  test('denies when open exposure would exceed the cap', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxOpenNotionalUsd: 500']),
      ctx({
        positions: [{
          symbol: 'ETHUSDT', quantity: 0.1, entryPrice: 4000, markPrice: 4000,
          notionalUsd: 450, leverage: 1, unrealizedPnlUsd: 0,
        }],
      }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('max-open-exposure'));
  });

  test('reduce-only orders bypass the exposure cap', () => {
    const d = evaluate(
      { ...BUY_100, venue: 'futures-usds', side: 'SELL', reduceOnly: true },
      policy(['limits:', '  maxOpenNotionalUsd: 100']),
      ctx({
        positions: [{
          symbol: 'BTCUSDT', quantity: 0.01, entryPrice: 100_000, markPrice: 100_000,
          notionalUsd: 1_000, leverage: 1, unrealizedPnlUsd: 0,
        }],
      }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('denies leverage above the cap', () => {
    const d = evaluate(
      { ...BUY_100, venue: 'futures-usds', leverage: 20 },
      policy(['limits:', '  maxLeverage: 5']),
      ctx(),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('max-leverage'));
  });

  test('denies opening more positions than allowed', () => {
    const pos = (symbol: string) => ({
      symbol, quantity: 1, entryPrice: 1, markPrice: 1, notionalUsd: 10, leverage: 1, unrealizedPnlUsd: 0,
    });
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxPositionsOpen: 2']),
      ctx({ positions: [pos('ETHUSDT'), pos('BNBUSDT')] }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('max-positions-open'));
  });

  test('adding to an existing position does not count as a new position', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxPositionsOpen: 1']),
      ctx({
        positions: [{
          symbol: 'BTCUSDT', quantity: 0.001, entryPrice: 100_000, markPrice: 100_000,
          notionalUsd: 100, leverage: 1, unrealizedPnlUsd: 0,
        }],
      }),
    );
    assert.equal(d.verdict, 'allow');
  });
});

describe('rule: loss and drawdown circuit breakers', () => {
  test('denies new risk once the daily loss limit is hit', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxDailyLossUsd: 200']),
      ctx({ counters: { ...ctx().counters, dailyRealizedPnlUsd: -250 } }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('daily-loss-limit'));
  });

  test('a daily profit never trips the loss breaker', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxDailyLossUsd: 200']),
      ctx({ counters: { ...ctx().counters, dailyRealizedPnlUsd: 500 } }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('closing trades are still permitted after the loss limit trips', () => {
    // A verified exit: there is a real long to sell into.
    const d = evaluate(
      { ...BUY_100, venue: 'futures-usds', side: 'SELL', reduceOnly: true },
      policy(['limits:', '  maxDailyLossUsd: 200']),
      ctx({
        counters: { ...ctx().counters, dailyRealizedPnlUsd: -250 },
        positions: [{
          symbol: 'BTCUSDT', quantity: 0.01, entryPrice: 100_000, markPrice: 100_000,
          notionalUsd: 1_000, leverage: 1, unrealizedPnlUsd: 0,
        }],
      }),
    );
    assert.equal(d.verdict, 'allow', 'a breaker must never trap the agent in a position');
  });

  test('denies when equity drawdown from peak exceeds the cap', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxDrawdownPct: 10']),
      ctx({ equityUsd: 8_500, counters: { ...ctx().counters, peakEquityUsd: 10_000 } }),
    );
    assert.equal(d.verdict, 'deny');
    const f = d.findings.find((x) => x.ruleId === 'max-drawdown');
    assert.equal(f?.observed, 15);
  });

  test('drawdown is ignored when peak equity is zero', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxDrawdownPct: 10']),
      ctx({ equityUsd: 100, counters: { ...ctx().counters, peakEquityUsd: 0 } }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('enforces a cooldown window after a realized loss', () => {
    const d = evaluate(
      BUY_100,
      policy(['guards:', '  cooldownSecondsAfterLoss: 300']),
      ctx({ counters: { ...ctx().counters, lastLossAt: NOON - 60_000 } }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('loss-cooldown'));
  });

  test('allows trading once the cooldown has elapsed', () => {
    const d = evaluate(
      BUY_100,
      policy(['guards:', '  cooldownSecondsAfterLoss: 300']),
      ctx({ counters: { ...ctx().counters, lastLossAt: NOON - 400_000 } }),
    );
    assert.equal(d.verdict, 'allow');
  });
});

describe('rule: tempo controls', () => {
  test('denies when orders-per-minute is exhausted', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxOrdersPerMinute: 3']),
      ctx({ counters: { ...ctx().counters, ordersLastMinute: 3 } }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('rate-limit-minute'));
  });

  test('denies when orders-per-hour is exhausted', () => {
    const d = evaluate(
      BUY_100,
      policy(['limits:', '  maxOrdersPerHour: 20']),
      ctx({ counters: { ...ctx().counters, ordersLastHour: 20 } }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('rate-limit-hour'));
  });

  test('rate limits do not apply to reads', () => {
    const d = evaluate(
      { category: 'read', venue: 'market-data' },
      policy(['limits:', '  maxOrdersPerMinute: 1']),
      ctx({ counters: { ...ctx().counters, ordersLastMinute: 99 } }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('rate limits never block a verified reduce-only exit', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 100, reduceOnly: true },
      policy(['limits:', '  maxOrdersPerMinute: 3', '  maxOrdersPerHour: 20']),
      ctx({
        counters: { ...ctx().counters, ordersLastMinute: 99, ordersLastHour: 99 },
        positions: [{
          symbol: 'BTCUSDT', quantity: 0.01, entryPrice: 100_000, markPrice: 100_000,
          notionalUsd: 1_000, leverage: 1, unrealizedPnlUsd: 0,
        }],
      }),
    );
    assert.equal(d.verdict, 'allow', 'a rate limiter must never trap the agent in a position');
  });

  test('rate limits DO apply to a stop-entry, which opens risk', () => {
    // SEC-03: a STOP_MARKET without reduceOnly is an entry, not protection.
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY', orderType: 'STOP_MARKET', quoteQuantity: 100 },
      policy(['limits:', '  maxOrdersPerMinute: 1']),
      ctx({ counters: { ...ctx().counters, ordersLastMinute: 50 } }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('rate-limit-minute'));
  });

  test('rate limits never block a reduce-only protective stop', () => {
    const d = evaluate(
      { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', quoteQuantity: 100, reduceOnly: true },
      policy(['limits:', '  maxOrdersPerMinute: 1']),
      ctx({
        counters: { ...ctx().counters, ordersLastMinute: 50 },
        positions: [{
          symbol: 'BTCUSDT', quantity: 0.01, entryPrice: 100_000, markPrice: 100_000,
          notionalUsd: 1_000, leverage: 1, unrealizedPnlUsd: 0,
        }],
      }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('denies trading outside the configured UTC window', () => {
    const d = evaluate(
      BUY_100,
      policy(['guards:', '  tradingHoursUtc: { from: "13:00", to: "17:00" }']),
      ctx(),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('trading-hours'));
  });

  test('allows trading inside the window', () => {
    const d = evaluate(
      BUY_100,
      policy(['guards:', '  tradingHoursUtc: { from: "08:00", to: "20:00" }']),
      ctx(),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('supports a window that wraps past midnight', () => {
    const d = evaluate(
      BUY_100,
      policy(['guards:', '  tradingHoursUtc: { from: "22:00", to: "06:00" }']),
      ctx({ now: Date.UTC(2026, 8, 7, 23, 30, 0) }),
    );
    assert.equal(d.verdict, 'allow');
  });
});

describe('rule: order integrity guards', () => {
  test('denies a fat-finger limit price far from the mark', () => {
    const d = evaluate(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quantity: 0.001, price: 10_000 },
      policy(['guards:', '  priceDeviationPct: 5']),
      ctx(),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('price-deviation'));
  });

  test('allows a limit price within tolerance', () => {
    const d = evaluate(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quantity: 0.001, price: 98_000 },
      policy(['guards:', '  priceDeviationPct: 5']),
      ctx(),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('denies a futures entry with no protective stop when required', () => {
    const d = evaluate(
      { ...BUY_100, venue: 'futures-usds' },
      policy(['guards:', '  requireStopLoss: true']),
      ctx(),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('require-stop-loss'));
  });

  test('a bare hasStopLoss claim is NOT enough (GW-06)', () => {
    const d = evaluate(
      { ...BUY_100, venue: 'futures-usds', hasStopLoss: true },
      policy(['guards:', '  requireStopLoss: true']),
      ctx(),
    );
    assert.equal(d.verdict, 'deny', 'a boolean the agent sets itself is not evidence');
    assert.ok(findingIds(d).includes('require-stop-loss'));
  });

  test('allows a futures entry carrying a validated stopPrice', () => {
    const d = evaluate(
      { ...BUY_100, venue: 'futures-usds', side: 'BUY', stopPrice: 95_000 },
      policy(['guards:', '  requireStopLoss: true']),
      ctx(),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('the stop requirement does not apply to verified reduce-only exits', () => {
    const d = evaluate(
      { ...BUY_100, venue: 'futures-usds', side: 'SELL', reduceOnly: true },
      policy(['guards:', '  requireStopLoss: true']),
      ctx({
        positions: [{
          symbol: 'BTCUSDT', quantity: 0.01, entryPrice: 100_000, markPrice: 100_000,
          notionalUsd: 1_000, leverage: 1, unrealizedPnlUsd: 0,
        }],
      }),
    );
    assert.equal(d.verdict, 'allow');
  });

  test('blocks equity below the configured floor', () => {
    const d = evaluate(BUY_100, policy(['guards:', '  minAccountEquityUsd: 5000']), ctx({ equityUsd: 1_000 }));
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('min-equity'));
  });

  test('blocks a replayed action id', () => {
    const d = evaluate(
      { ...BUY_100, id: 'order-42' },
      policy(['guards:', '  blockDuplicateActionIds: true']),
      ctx({ recentActionIds: ['order-41', 'order-42'] }),
    );
    assert.equal(d.verdict, 'deny');
    assert.ok(findingIds(d).includes('duplicate-action'));
  });

  test('allows a replay when the duplicate guard is disabled', () => {
    const d = evaluate(
      { ...BUY_100, id: 'order-42' },
      policy(['guards:', '  blockDuplicateActionIds: false']),
      ctx({ recentActionIds: ['order-42'] }),
    );
    assert.equal(d.verdict, 'allow');
  });
});

describe('rule: human-in-the-loop escalation', () => {
  test('escalates to review above the configured notional', () => {
    const d = evaluate(
      { ...BUY_100, quoteQuantity: 400 },
      policy(['guards:', '  reviewAboveNotionalUsd: 250']),
      ctx(),
    );
    assert.equal(d.verdict, 'review');
    assert.ok(findingIds(d).includes('review-threshold'));
  });

  test('a deny outranks a review', () => {
    const d = evaluate(
      { ...BUY_100, quoteQuantity: 400 },
      policy(['limits:', '  maxNotionalUsdPerOrder: 300', 'guards:', '  reviewAboveNotionalUsd: 250']),
      ctx(),
    );
    assert.equal(d.verdict, 'deny');
  });

  test('stays allow below the threshold', () => {
    const d = evaluate(BUY_100, policy(['guards:', '  reviewAboveNotionalUsd: 250']), ctx());
    assert.equal(d.verdict, 'allow');
  });
});

describe('engine — policy modes', () => {
  test('monitor mode downgrades deny to review but keeps the raw verdict', () => {
    const p = loadPolicyFromString([
      'version: 1', 'name: t', 'mode: monitor', 'default: deny',
      'allow:', '  categories: ["trade"]', '  venues: ["spot"]',
      'limits:', '  maxNotionalUsdPerOrder: 10',
    ].join('\n'));
    const d = evaluate(BUY_100, p, ctx());
    assert.equal(d.rawVerdict, 'deny');
    assert.equal(d.verdict, 'review');
  });

  test('simulate mode reports without ever blocking', () => {
    const p = loadPolicyFromString([
      'version: 1', 'name: t', 'mode: simulate', 'default: deny',
      'allow:', '  categories: ["trade"]', '  venues: ["spot"]',
      'limits:', '  maxNotionalUsdPerOrder: 10',
    ].join('\n'));
    const d = evaluate(BUY_100, p, ctx());
    assert.equal(d.rawVerdict, 'deny');
    assert.equal(d.verdict, 'allow');
    assert.ok(d.findings.length > 0, 'findings are still reported in simulate mode');
  });

  test('enforce mode leaves the verdict untouched', () => {
    const d = evaluate(BUY_100, policy(['limits:', '  maxNotionalUsdPerOrder: 10']), ctx());
    assert.equal(d.rawVerdict, 'deny');
    assert.equal(d.verdict, 'deny');
  });

  test('kill-switch is absolute even in simulate mode', () => {
    const p = loadPolicyFromString([
      'version: 1', 'name: t', 'mode: simulate', 'default: allow',
    ].join('\n'));
    assert.equal(evaluate(BUY_100, p, ctx({ killSwitch: true })).verdict, 'deny');
  });
});

describe('engine — determinism and purity', () => {
  test('the same inputs always produce the same decision', () => {
    const p = policy(['limits:', '  maxNotionalUsdPerOrder: 500', 'guards:', '  reviewAboveNotionalUsd: 50']);
    const a = evaluate(BUY_100, p, ctx());
    const b = evaluate(BUY_100, p, ctx());
    assert.deepEqual(a.findings, b.findings);
    assert.equal(a.verdict, b.verdict);
  });

  test('evaluation does not mutate the policy or the context', () => {
    const p = policy(['limits:', '  maxNotionalUsdPerOrder: 500']);
    const c = ctx();
    const pSnapshot = JSON.stringify(p);
    const cSnapshot = JSON.stringify(c);
    evaluate(BUY_100, p, c);
    assert.equal(JSON.stringify(p), pSnapshot);
    assert.equal(JSON.stringify(c), cSnapshot);
  });

  test('reports every violated rule, not just the first', () => {
    const p = policy([
      'limits:', '  maxNotionalUsdPerOrder: 10', '  maxLeverage: 2',
      'guards:', '  minAccountEquityUsd: 999999',
    ]);
    const d = evaluate({ ...BUY_100, venue: 'futures-usds', leverage: 10 }, p, ctx());
    const ids = findingIds(d);
    assert.ok(ids.includes('max-notional-per-order'));
    assert.ok(ids.includes('max-leverage'));
    assert.ok(ids.includes('min-equity'));
  });
});
