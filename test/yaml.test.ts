import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../src/policy/yaml.js';

describe('parseYaml — scalars', () => {
  test('parses string, int, float, bool, null', () => {
    const doc = parseYaml([
      'name: conservative',
      'count: 42',
      'ratio: 1.5',
      'negative: -3',
      'enabled: true',
      'disabled: false',
      'missing: null',
      'tilde: ~',
      'empty:',
    ].join('\n'));
    assert.deepEqual(doc, {
      name: 'conservative',
      count: 42,
      ratio: 1.5,
      negative: -3,
      enabled: true,
      disabled: false,
      missing: null,
      tilde: null,
      empty: null,
    });
  });

  test('quoted strings keep their content verbatim', () => {
    const doc = parseYaml(['a: "12:00"', "b: 'true'", 'c: "# not a comment"'].join('\n'));
    assert.deepEqual(doc, { a: '12:00', b: 'true', c: '# not a comment' });
  });

  test('unquoted value containing a colon is preserved', () => {
    assert.deepEqual(parseYaml('url: https://example.com/x'), { url: 'https://example.com/x' });
  });

  test('scientific notation and underscores are not misread as numbers', () => {
    const doc = parseYaml(['a: 1e3', 'b: 1_000', 'c: 007'].join('\n'));
    assert.equal(doc.a, 1000);
    assert.equal(doc.b, '1_000');
    assert.equal(doc.c, '007', 'leading-zero tokens stay strings so IDs are not mangled');
  });
});

describe('parseYaml — comments and blank lines', () => {
  test('strips full-line and trailing comments', () => {
    const doc = parseYaml([
      '# leading comment',
      'name: x   # trailing comment',
      '',
      '   ',
      'value: 3 # another',
    ].join('\n'));
    assert.deepEqual(doc, { name: 'x', value: 3 });
  });

  test('does not strip # inside quotes', () => {
    assert.deepEqual(parseYaml('a: "b # c"'), { a: 'b # c' });
  });
});

describe('parseYaml — nesting', () => {
  test('parses nested maps', () => {
    const doc = parseYaml([
      'limits:',
      '  maxLeverage: 5',
      '  nested:',
      '    deep: true',
      'top: 1',
    ].join('\n'));
    assert.deepEqual(doc, { limits: { maxLeverage: 5, nested: { deep: true } }, top: 1 });
  });

  test('parses inline flow sequences', () => {
    const doc = parseYaml('symbols: ["BTCUSDT", "ETHUSDT"]');
    assert.deepEqual(doc, { symbols: ['BTCUSDT', 'ETHUSDT'] });
  });

  test('parses empty inline sequence and map', () => {
    assert.deepEqual(parseYaml(['a: []', 'b: {}'].join('\n')), { a: [], b: {} });
  });

  test('parses inline flow maps', () => {
    const doc = parseYaml('tradingHoursUtc: { from: "08:00", to: "20:00" }');
    assert.deepEqual(doc, { tradingHoursUtc: { from: '08:00', to: '20:00' } });
  });

  test('parses block sequences of scalars', () => {
    const doc = parseYaml(['symbols:', '  - BTCUSDT', '  - ETHUSDT'].join('\n'));
    assert.deepEqual(doc, { symbols: ['BTCUSDT', 'ETHUSDT'] });
  });

  test('parses block sequences of maps', () => {
    const doc = parseYaml([
      'rules:',
      '  - id: a',
      '    weight: 1',
      '  - id: b',
      '    weight: 2',
    ].join('\n'));
    assert.deepEqual(doc, { rules: [{ id: 'a', weight: 1 }, { id: 'b', weight: 2 }] });
  });

  test('handles dedent back to a shallower level', () => {
    const doc = parseYaml([
      'a:',
      '  b:',
      '    c: 1',
      'd: 2',
    ].join('\n'));
    assert.deepEqual(doc, { a: { b: { c: 1 } }, d: 2 });
  });
});

describe('parseYaml — errors', () => {
  test('rejects tab indentation with a line number', () => {
    assert.throws(() => parseYaml('a:\n\tb: 1'), (e: unknown) => {
      assert.ok(e instanceof YamlError);
      assert.match((e as YamlError).message, /tab/i);
      assert.equal((e as YamlError).line, 2);
      return true;
    });
  });

  test('rejects a line with no colon and no dash', () => {
    assert.throws(() => parseYaml('just some text'), YamlError);
  });

  test('rejects an unterminated quote', () => {
    assert.throws(() => parseYaml('a: "unterminated'), YamlError);
  });

  test('rejects inconsistent dedent', () => {
    assert.throws(() => parseYaml(['a:', '    b: 1', '  c: 2'].join('\n')), YamlError);
  });

  test('rejects a duplicate key', () => {
    assert.throws(() => parseYaml(['a: 1', 'a: 2'].join('\n')), /duplicate/i);
  });
});

describe('parseYaml — real policy round-trip', () => {
  test('parses a full policy document', () => {
    const doc = parseYaml([
      'version: 1',
      'name: conservative-desk',
      'mode: enforce',
      'default: deny',
      'limits:',
      '  maxNotionalUsdPerOrder: 500',
      '  maxLeverage: 5',
      '  maxDailyLossUsd: null',
      'allow:',
      '  categories: ["read", "trade", "cancel"]',
      '  symbols:',
      '    - BTCUSDT',
      '    - ETHUSDT',
      'guards:',
      '  requireStopLoss: true',
      '  tradingHoursUtc: { from: "00:00", to: "23:59" }',
    ].join('\n'));

    assert.equal(doc.version, 1);
    assert.equal(doc.name, 'conservative-desk');
    assert.deepEqual((doc.allow as Record<string, unknown>).symbols, ['BTCUSDT', 'ETHUSDT']);
    assert.deepEqual((doc.guards as Record<string, unknown>).tradingHoursUtc, {
      from: '00:00',
      to: '23:59',
    });
    assert.equal((doc.limits as Record<string, unknown>).maxDailyLossUsd, null);
  });
});
