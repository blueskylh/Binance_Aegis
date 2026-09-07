import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAction, NormalizationError } from '../src/core/normalize.js';
import type { ProposedAction, RiskContext } from '../src/types.js';

const NOW = 1_757_000_000_000;

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    equityUsd: 10_000,
    positions: [],
    marks: { BTCUSDT: 100_000, ETHUSDT: 4_000, BNBUSDT: 1_000 },
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
    ...over,
  };
}

describe('normalizeAction — notional derivation', () => {
  test('prefers explicit quoteQuantity', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 250 },
      ctx(),
    );
    assert.equal(a.notionalUsd, 250);
    assert.equal(a.notionalBasis, 'quote-quantity');
  });

  test('uses quantity x limit price when price is given', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quantity: 0.01, price: 90_000 },
      ctx(),
    );
    assert.equal(a.notionalUsd, 900);
    assert.equal(a.notionalBasis, 'quantity-x-price');
  });

  test('falls back to quantity x mark for market orders', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 0.01 },
      ctx(),
    );
    assert.equal(a.notionalUsd, 1_000);
    assert.equal(a.notionalBasis, 'quantity-x-mark');
  });

  test('reads are always zero notional', () => {
    const a = normalizeAction({ category: 'read', venue: 'market-data', symbol: 'BTCUSDT' }, ctx());
    assert.equal(a.notionalUsd, 0);
    assert.equal(a.notionalBasis, 'none');
  });

  test('cancels are always zero notional', () => {
    const a = normalizeAction({ category: 'cancel', venue: 'spot', symbol: 'BTCUSDT' }, ctx());
    assert.equal(a.notionalUsd, 0);
  });

  test('transfer notional uses stable-asset amount at par', () => {
    const a = normalizeAction(
      { category: 'transfer', venue: 'wallet', asset: 'USDT', quantity: 2_000, destination: 'futures-usds' },
      ctx(),
    );
    assert.equal(a.notionalUsd, 2_000);
    assert.equal(a.notionalBasis, 'asset-amount');
  });

  test('transfer of a non-stable asset uses its mark', () => {
    const a = normalizeAction(
      { category: 'transfer', venue: 'wallet', asset: 'BNB', quantity: 3, destination: 'spot' },
      ctx({ marks: { BNB: 1_000 } }),
    );
    assert.equal(a.notionalUsd, 3_000);
  });
});

describe('normalizeAction — canonicalization', () => {
  test('upper-cases symbol, side and asset', () => {
    const a = normalizeAction(
      { category: 'trade', venue: 'spot', symbol: 'btcusdt', side: 'buy' as never, quoteQuantity: 10, asset: 'usdt' },
      ctx(),
    );
    assert.equal(a.symbol, 'BTCUSDT');
    assert.equal(a.side, 'BUY');
    assert.equal(a.asset, 'USDT');
  });

  test('generates a deterministic id when none is supplied', () => {
    const proposal: ProposedAction = { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', quoteQuantity: 10 };
    const a = normalizeAction(proposal, ctx());
    const b = normalizeAction(proposal, ctx());
    assert.equal(a.id, b.id, 'same content + same clock must yield the same id (idempotency)');
    assert.match(a.id, /^auto-[0-9a-f]{16}$/);
  });

  test('preserves a caller-supplied id', () => {
    const a = normalizeAction(
      { id: 'agent-req-1', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', quoteQuantity: 10 },
      ctx(),
    );
    assert.equal(a.id, 'agent-req-1');
  });

  test('defaults reduceOnly and hasStopLoss to false', () => {
    const a = normalizeAction({ category: 'read', venue: 'market-data' }, ctx());
    assert.equal(a.reduceOnly, false);
    assert.equal(a.hasStopLoss, false);
  });

  test('stamps the evaluation timestamp from context, not wall clock', () => {
    const a = normalizeAction({ category: 'read', venue: 'market-data' }, ctx());
    assert.equal(a.ts, NOW);
  });

  test('retains the raw proposal for the audit ledger', () => {
    const proposal: ProposedAction = { category: 'read', venue: 'market-data', meta: { source: 'unit-test' } };
    const a = normalizeAction(proposal, ctx());
    assert.deepEqual(a.raw.meta, { source: 'unit-test' });
  });
});

describe('normalizeAction — input validation (fail closed)', () => {
  test('rejects a missing category', () => {
    assert.throws(() => normalizeAction({ venue: 'spot' } as never, ctx()), NormalizationError);
  });

  test('rejects an unknown category', () => {
    assert.throws(() => normalizeAction({ category: 'teleport', venue: 'spot' } as never, ctx()), /category/i);
  });

  test('rejects an unknown venue', () => {
    assert.throws(() => normalizeAction({ category: 'trade', venue: 'nasdaq' } as never, ctx()), /venue/i);
  });

  test('rejects a negative quantity', () => {
    assert.throws(
      () => normalizeAction({ category: 'trade', venue: 'spot', symbol: 'BTCUSDT', quantity: -1 }, ctx()),
      /quantity/i,
    );
  });

  test('rejects NaN quantity', () => {
    assert.throws(
      () => normalizeAction({ category: 'trade', venue: 'spot', symbol: 'BTCUSDT', quantity: Number.NaN }, ctx()),
      /finite/i,
    );
  });

  test('rejects Infinity notional', () => {
    assert.throws(
      () => normalizeAction({ category: 'trade', venue: 'spot', symbol: 'BTCUSDT', quoteQuantity: Number.POSITIVE_INFINITY }, ctx()),
      /finite/i,
    );
  });

  test('rejects a trade with no sizing information at all', () => {
    assert.throws(
      () => normalizeAction({ category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY' }, ctx()),
      /siz/i,
    );
  });

  test('rejects a trade whose symbol has no reference price', () => {
    assert.throws(
      () => normalizeAction({ category: 'trade', venue: 'spot', symbol: 'DOGEUSDT', side: 'BUY', quantity: 100 }, ctx()),
      /reference price/i,
    );
  });

  test('rejects a negative leverage', () => {
    assert.throws(
      () => normalizeAction(
        { category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', quoteQuantity: 100, leverage: -2 }, ctx(),
      ),
      /leverage/i,
    );
  });
});
