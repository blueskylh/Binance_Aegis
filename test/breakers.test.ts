import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessBreakers, type GuardianSnapshot } from '../src/guardian/breakers.js';
import { loadPolicyFromString } from '../src/policy/schema.js';

function policy(body: string[] = []) {
  return loadPolicyFromString(['version: 1', 'name: g', 'mode: enforce', 'default: allow', ...body].join('\n'));
}

function snap(over: Partial<GuardianSnapshot> = {}): GuardianSnapshot {
  return {
    equityUsd: 10_000,
    peakEquityUsd: 10_000,
    openExposureUsd: 0,
    dailyRealizedPnlUsd: 0,
    openPositions: 0,
    killSwitch: false,
    ...over,
  };
}

describe('assessBreakers', () => {
  test('a healthy account trips nothing', () => {
    assert.deepEqual(assessBreakers(snap(), policy(['limits:', '  maxDrawdownPct: 10'])), []);
  });

  test('trips on a drawdown breach', () => {
    const b = assessBreakers(snap({ equityUsd: 8_000 }), policy(['limits:', '  maxDrawdownPct: 10']));
    assert.equal(b.length, 1);
    assert.equal(b[0]?.id, 'drawdown');
    assert.equal(b[0]?.observed, 20);
  });

  test('trips on a daily loss breach', () => {
    const b = assessBreakers(snap({ dailyRealizedPnlUsd: -300 }), policy(['limits:', '  maxDailyLossUsd: 250']));
    assert.equal(b[0]?.id, 'daily-loss');
  });

  test('trips on an exposure breach', () => {
    const b = assessBreakers(snap({ openExposureUsd: 5_000 }), policy(['limits:', '  maxOpenNotionalUsd: 2000']));
    assert.equal(b[0]?.id, 'open-exposure');
  });

  test('trips on an equity floor breach', () => {
    const b = assessBreakers(snap({ equityUsd: 10 }), policy(['guards:', '  minAccountEquityUsd: 100']));
    assert.equal(b[0]?.id, 'min-equity');
  });

  test('reports every simultaneous breach', () => {
    const b = assessBreakers(
      snap({ equityUsd: 5_000, dailyRealizedPnlUsd: -900, openExposureUsd: 9_000 }),
      policy(['limits:', '  maxDrawdownPct: 10', '  maxDailyLossUsd: 250', '  maxOpenNotionalUsd: 2000']),
    );
    assert.deepEqual(b.map((x) => x.id).sort(), ['daily-loss', 'drawdown', 'open-exposure']);
  });

  test('an unset limit is never a breach', () => {
    assert.deepEqual(assessBreakers(snap({ equityUsd: 1, dailyRealizedPnlUsd: -99_999 }), policy()), []);
  });

  test('stays silent once the kill switch is already engaged', () => {
    const b = assessBreakers(snap({ equityUsd: 1, killSwitch: true }), policy(['limits:', '  maxDrawdownPct: 1']));
    assert.deepEqual(b, [], 'no repeated halts — the breaker is edge-triggered, not level-triggered');
  });

  test('ignores drawdown when peak equity is zero', () => {
    const b = assessBreakers(snap({ equityUsd: 0, peakEquityUsd: 0 }), policy(['limits:', '  maxDrawdownPct: 5']));
    assert.deepEqual(b, []);
  });

  test('every breach carries a human-readable reason', () => {
    const b = assessBreakers(snap({ equityUsd: 8_000 }), policy(['limits:', '  maxDrawdownPct: 10']));
    assert.ok((b[0]?.reason.length ?? 0) > 20);
  });
});
