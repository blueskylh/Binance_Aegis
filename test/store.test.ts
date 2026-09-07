import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiskStore } from '../src/state/store.js';
import { Ledger } from '../src/ledger/ledger.js';

const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);
let dir: string;

function makeStore(): { store: RiskStore; ledger: Ledger } {
  const ledger = new Ledger(join(dir, 'ledger.jsonl'));
  const store = new RiskStore(join(dir, 'state.json'), ledger);
  return { store, ledger };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aegis-store-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('RiskStore — fresh state', () => {
  test('starts with safe zeroed counters', () => {
    const { store } = makeStore();
    const c = store.buildContext(NOON);
    assert.equal(c.equityUsd, 0);
    assert.equal(c.counters.dailyNotionalUsd, 0);
    assert.equal(c.counters.dailyRealizedPnlUsd, 0);
    assert.equal(c.counters.ordersLastMinute, 0);
    assert.equal(c.counters.lastLossAt, null);
    assert.equal(c.killSwitch, false);
    assert.deepEqual(c.positions, []);
  });

  test('uses the supplied clock, not the wall clock', () => {
    const { store } = makeStore();
    assert.equal(store.buildContext(12345).now, 12345);
  });
});

describe('RiskStore — account snapshot', () => {
  test('records equity, positions and marks', () => {
    const { store } = makeStore();
    store.updateAccount({
      equityUsd: 5_000,
      positions: [{ symbol: 'BTCUSDT', quantity: 0.01, entryPrice: 100_000, markPrice: 101_000, notionalUsd: 1_010, leverage: 2, unrealizedPnlUsd: 10 }],
      marks: { BTCUSDT: 101_000 },
    });
    const c = store.buildContext(NOON);
    assert.equal(c.equityUsd, 5_000);
    assert.equal(c.positions.length, 1);
    assert.equal(c.marks['BTCUSDT'], 101_000);
  });

  test('tracks peak equity as a high-water mark', () => {
    const { store } = makeStore();
    store.updateAccount({ equityUsd: 5_000, positions: [], marks: {} });
    store.updateAccount({ equityUsd: 8_000, positions: [], marks: {} });
    store.updateAccount({ equityUsd: 6_000, positions: [], marks: {} });
    assert.equal(store.buildContext(NOON).counters.peakEquityUsd, 8_000);
  });

  test('peak equity survives a restart', () => {
    const { store } = makeStore();
    store.updateAccount({ equityUsd: 9_000, positions: [], marks: {} });
    const reopened = new RiskStore(join(dir, 'state.json'), new Ledger(join(dir, 'ledger.jsonl')));
    assert.equal(reopened.buildContext(NOON).counters.peakEquityUsd, 9_000);
  });

  test('resetPeak drops the high-water mark to current equity', () => {
    const { store } = makeStore();
    store.updateAccount({ equityUsd: 10_000, positions: [], marks: {} });
    store.updateAccount({ equityUsd: 7_000, positions: [], marks: {} });
    store.resetPeak();
    assert.equal(store.buildContext(NOON).counters.peakEquityUsd, 7_000);
  });
});

describe('RiskStore — kill switch', () => {
  test('defaults to disengaged and toggles', () => {
    const { store } = makeStore();
    assert.equal(store.buildContext(NOON).killSwitch, false);
    store.setKillSwitch(true, 'manual halt', NOON);
    assert.equal(store.buildContext(NOON).killSwitch, true);
    store.setKillSwitch(false, 'resumed', NOON);
    assert.equal(store.buildContext(NOON).killSwitch, false);
  });

  test('persists across restarts', () => {
    const { store } = makeStore();
    store.setKillSwitch(true, 'halt', NOON);
    const reopened = new RiskStore(join(dir, 'state.json'), new Ledger(join(dir, 'ledger.jsonl')));
    assert.equal(reopened.buildContext(NOON).killSwitch, true);
  });

  test('writes a breaker entry to the ledger', () => {
    const { store, ledger } = makeStore();
    store.setKillSwitch(true, 'drawdown breached', NOON);
    const breakers = ledger.byType('breaker');
    assert.equal(breakers.length, 1);
    assert.equal(breakers[0]?.payload['engaged'], true);
    assert.equal(breakers[0]?.payload['reason'], 'drawdown breached');
  });
});

describe('RiskStore — rolling counters from the ledger', () => {
  function exec(store: RiskStore, over: { ts: number; notionalUsd?: number; realizedPnlUsd?: number; id?: string }) {
    store.recordExecution({
      actionId: over.id ?? `a-${over.ts}`,
      category: 'trade',
      venue: 'spot',
      symbol: 'BTCUSDT',
      notionalUsd: over.notionalUsd ?? 100,
      realizedPnlUsd: over.realizedPnlUsd ?? 0,
    }, over.ts);
  }

  test('sums notional traded in the current UTC day', () => {
    const { store } = makeStore();
    exec(store, { ts: NOON - 3_600_000, notionalUsd: 300 });
    exec(store, { ts: NOON - 60_000, notionalUsd: 200 });
    assert.equal(store.buildContext(NOON).counters.dailyNotionalUsd, 500);
  });

  test('excludes executions from a previous UTC day', () => {
    const { store } = makeStore();
    exec(store, { ts: Date.UTC(2026, 8, 6, 23, 0, 0), notionalUsd: 999 });
    exec(store, { ts: NOON, notionalUsd: 100 });
    assert.equal(store.buildContext(NOON).counters.dailyNotionalUsd, 100);
  });

  test('sums realized PnL for the current UTC day', () => {
    const { store } = makeStore();
    exec(store, { ts: NOON - 7_200_000, realizedPnlUsd: -80 });
    exec(store, { ts: NOON - 3_600_000, realizedPnlUsd: 30 });
    assert.equal(store.buildContext(NOON).counters.dailyRealizedPnlUsd, -50);
  });

  test('counts orders in the trailing minute and hour', () => {
    const { store } = makeStore();
    exec(store, { ts: NOON - 30_000 });
    exec(store, { ts: NOON - 45_000 });
    exec(store, { ts: NOON - 90_000 });
    exec(store, { ts: NOON - 3_500_000 });
    exec(store, { ts: NOON - 7_200_000 });
    const c = store.buildContext(NOON).counters;
    assert.equal(c.ordersLastMinute, 2);
    assert.equal(c.ordersLastHour, 4);
  });

  test('tracks the timestamp of the most recent loss only', () => {
    const { store } = makeStore();
    exec(store, { ts: NOON - 600_000, realizedPnlUsd: -10 });
    exec(store, { ts: NOON - 300_000, realizedPnlUsd: -5 });
    exec(store, { ts: NOON - 100_000, realizedPnlUsd: 20 });
    assert.equal(store.buildContext(NOON).counters.lastLossAt, NOON - 300_000);
  });

  test('a break-even execution is not a loss', () => {
    const { store } = makeStore();
    exec(store, { ts: NOON - 100, realizedPnlUsd: 0 });
    assert.equal(store.buildContext(NOON).counters.lastLossAt, null);
  });

  test('collects recent action ids for the replay guard', () => {
    const { store } = makeStore();
    exec(store, { ts: NOON - 1000, id: 'order-1' });
    exec(store, { ts: NOON - 500, id: 'order-2' });
    const ids = store.buildContext(NOON).recentActionIds;
    assert.ok(ids.includes('order-1'));
    assert.ok(ids.includes('order-2'));
  });

  test('counters rebuild identically after a restart', () => {
    const { store } = makeStore();
    exec(store, { ts: NOON - 1000, notionalUsd: 250, realizedPnlUsd: -40 });
    const before = store.buildContext(NOON).counters;
    const reopened = new RiskStore(join(dir, 'state.json'), new Ledger(join(dir, 'ledger.jsonl')));
    assert.deepEqual(reopened.buildContext(NOON).counters, before);
  });
});

describe('RiskStore — decision recording', () => {
  test('records a decision to the ledger and returns the entry', () => {
    const { store, ledger } = makeStore();
    const entry = store.recordDecision({
      verdict: 'deny',
      rawVerdict: 'deny',
      action: { id: 'x', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', notionalUsd: 100 },
      findings: [{ ruleId: 'max-notional-per-order', verdict: 'deny', severity: 'critical', message: 'too big' }],
      policyName: 'p',
    }, NOON);
    assert.equal(entry.seq, 1);
    assert.equal(ledger.byType('decision').length, 1);
    assert.equal(entry.payload['verdict'], 'deny');
  });

  test('the ledger still verifies after mixed writes', () => {
    const { store, ledger } = makeStore();
    store.setKillSwitch(true, 'r', NOON);
    store.recordDecision({
      verdict: 'allow', rawVerdict: 'allow',
      action: { id: 'y', category: 'read', venue: 'market-data', symbol: null, notionalUsd: 0 },
      findings: [], policyName: 'p',
    }, NOON + 1);
    store.recordExecution({
      actionId: 'y', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', notionalUsd: 10, realizedPnlUsd: 1,
    }, NOON + 2);
    assert.equal(ledger.verify().ok, true);
  });
});
