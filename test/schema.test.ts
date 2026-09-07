import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicyFromString, PolicyError, DEFAULT_POLICY } from '../src/policy/schema.js';

const MINIMAL = ['version: 1', 'name: test', 'mode: enforce', 'default: deny'].join('\n');

describe('loadPolicyFromString — defaults', () => {
  test('fills every unspecified field from DEFAULT_POLICY', () => {
    const p = loadPolicyFromString(MINIMAL);
    assert.equal(p.name, 'test');
    assert.equal(p.mode, 'enforce');
    assert.equal(p.default, 'deny');
    assert.deepEqual(p.limits, DEFAULT_POLICY.limits);
    assert.equal(p.guards.requireStopLoss, DEFAULT_POLICY.guards.requireStopLoss);
    assert.equal(p.allow.symbols, null);
  });

  test('does not mutate DEFAULT_POLICY across loads', () => {
    const a = loadPolicyFromString([MINIMAL, 'limits:', '  maxLeverage: 3'].join('\n'));
    const b = loadPolicyFromString(MINIMAL);
    assert.equal(a.limits.maxLeverage, 3);
    assert.equal(b.limits.maxLeverage, DEFAULT_POLICY.limits.maxLeverage);
    assert.equal(DEFAULT_POLICY.limits.maxLeverage, null);
  });

  test('accepts JSON input as well as YAML', () => {
    const p = loadPolicyFromString(JSON.stringify({ version: 1, name: 'j', mode: 'monitor', default: 'allow' }));
    assert.equal(p.name, 'j');
    assert.equal(p.mode, 'monitor');
  });
});

describe('loadPolicyFromString — validation', () => {
  test('rejects a missing version', () => {
    assert.throws(() => loadPolicyFromString('name: x'), PolicyError);
  });

  test('rejects an unsupported version', () => {
    assert.throws(() => loadPolicyFromString('version: 2\nname: x'), /version/i);
  });

  test('rejects an unknown mode', () => {
    assert.throws(() => loadPolicyFromString([MINIMAL.replace('mode: enforce', 'mode: yolo')].join('\n')), /mode/i);
  });

  test('rejects an unknown default verdict', () => {
    assert.throws(() => loadPolicyFromString(MINIMAL.replace('default: deny', 'default: maybe')), /default/i);
  });

  test('rejects an unknown top-level key (typo protection)', () => {
    assert.throws(() => loadPolicyFromString([MINIMAL, 'limmits:', '  maxLeverage: 3'].join('\n')), /unknown/i);
  });

  test('rejects an unknown limit key', () => {
    assert.throws(() => loadPolicyFromString([MINIMAL, 'limits:', '  maxLevrage: 3'].join('\n')), /maxLevrage/);
  });

  test('rejects a negative limit', () => {
    assert.throws(() => loadPolicyFromString([MINIMAL, 'limits:', '  maxLeverage: -1'].join('\n')), /negative|>= 0/i);
  });

  test('rejects a non-numeric limit', () => {
    assert.throws(() => loadPolicyFromString([MINIMAL, 'limits:', '  maxLeverage: "five"'].join('\n')), /number/i);
  });

  test('rejects an invalid action category', () => {
    assert.throws(
      () => loadPolicyFromString([MINIMAL, 'allow:', '  categories: ["teleport"]'].join('\n')),
      /category/i,
    );
  });

  test('rejects an invalid venue', () => {
    assert.throws(() => loadPolicyFromString([MINIMAL, 'allow:', '  venues: ["nasdaq"]'].join('\n')), /venue/i);
  });

  test('rejects malformed trading hours', () => {
    assert.throws(
      () => loadPolicyFromString([MINIMAL, 'guards:', '  tradingHoursUtc: { from: "25:00", to: "26:00" }'].join('\n')),
      /HH:MM/i,
    );
  });

  test('rejects a drawdown percentage above 100', () => {
    assert.throws(() => loadPolicyFromString([MINIMAL, 'limits:', '  maxDrawdownPct: 150'].join('\n')), /100/);
  });

  test('rejects a non-boolean guard', () => {
    assert.throws(
      () => loadPolicyFromString([MINIMAL, 'guards:', '  requireStopLoss: "yes"'].join('\n')),
      /boolean/i,
    );
  });

  test('rejects an empty policy name', () => {
    assert.throws(() => loadPolicyFromString('version: 1\nname: ""\nmode: enforce\ndefault: deny'), /name/i);
  });
});

describe('loadPolicyFromString — normalization', () => {
  test('upper-cases and de-duplicates symbols', () => {
    const p = loadPolicyFromString([MINIMAL, 'allow:', '  symbols: ["btcusdt", "BTCUSDT", "ethusdt"]'].join('\n'));
    assert.deepEqual(p.allow.symbols, ['BTCUSDT', 'ETHUSDT']);
  });

  test('accepts explicit nulls as "no limit"', () => {
    const p = loadPolicyFromString([MINIMAL, 'limits:', '  maxLeverage: null'].join('\n'));
    assert.equal(p.limits.maxLeverage, null);
  });

  test('parses a full realistic policy', () => {
    const p = loadPolicyFromString([
      'version: 1',
      'name: conservative-desk',
      'mode: enforce',
      'default: deny',
      'limits:',
      '  maxNotionalUsdPerOrder: 500',
      '  maxDailyNotionalUsd: 5000',
      '  maxOpenNotionalUsd: 2000',
      '  maxLeverage: 5',
      '  maxDailyLossUsd: 200',
      '  maxDrawdownPct: 10',
      '  maxOrdersPerMinute: 3',
      '  maxOrdersPerHour: 20',
      '  maxPositionsOpen: 4',
      'allow:',
      '  categories: ["read", "trade", "cancel"]',
      '  venues: ["spot", "futures-usds"]',
      '  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"]',
      'deny:',
      '  categories: ["withdraw"]',
      'guards:',
      '  priceDeviationPct: 5',
      '  minAccountEquityUsd: 100',
      '  requireStopLoss: true',
      '  tradingHoursUtc: { from: "00:00", to: "23:59" }',
      '  cooldownSecondsAfterLoss: 300',
      '  reviewAboveNotionalUsd: 250',
      '  blockDuplicateActionIds: true',
    ].join('\n'));

    assert.equal(p.limits.maxNotionalUsdPerOrder, 500);
    assert.deepEqual(p.deny.categories, ['withdraw']);
    assert.deepEqual(p.guards.tradingHoursUtc, { from: '00:00', to: '23:59' });
    assert.equal(p.guards.reviewAboveNotionalUsd, 250);
    assert.equal(p.limits.maxPositionsOpen, 4);
  });
});
