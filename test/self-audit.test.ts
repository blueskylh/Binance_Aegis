/**
 * Self-audit regressions — SA-01 … SA-04.
 *
 * Found by attacking my own v2.1 code rather than waiting for a reviewer to.
 * The concurrency one matters most: every other single-use guarantee in this
 * project is worthless if two terminals can redeem the same ticket at once.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aegis } from '../src/aegis.js';
import { ApprovalStore, type ApprovalTicket } from '../src/gateway/approvals.js';
import { ExecutionGateway, type FillReport, type OrderExecutor } from '../src/gateway/executor.js';
import { loadPolicyFromString } from '../src/policy/schema.js';
import type { NormalizedAction, ProposedAction } from '../src/types.js';

const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);
let dir: string;

const POLICY = [
  'version: 1', 'name: self-audit', 'mode: enforce', 'default: deny',
  'allow:',
  '  categories: ["read", "trade", "cancel"]',
  '  venues: ["spot", "futures-usds", "market-data"]',
  'guards:', '  reviewAboveNotionalUsd: 200',
].join('\n');

class Spy implements OrderExecutor {
  readonly placed: NormalizedAction[] = [];
  async placeOrder(action: NormalizedAction): Promise<FillReport> {
    this.placed.push(action);
    return {
      ok: true, orderId: `o-${this.placed.length}`, clientOrderId: action.id,
      symbol: action.symbol ?? '', status: 'FILLED',
      filledNotionalUsd: action.notionalUsd,
      filledQuantity: action.executionQuantity ?? 0.001,
      realizedPnlUsd: 0, raw: {},
    };
  }
}

function makeGw() {
  const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
  aegis.updateAccount({
    equityUsd: 10_000,
    positions: [{
      symbol: 'BTCUSDT', quantity: 0.02, entryPrice: 100_000, markPrice: 100_000,
      notionalUsd: 2_000, leverage: 2, unrealizedPnlUsd: 0,
    }],
    marks: { BTCUSDT: 100_000 },
  });
  const spy = new Spy();
  return { aegis, spy, gw: new ExecutionGateway(aegis, spy, { dataDir: dir }) };
}

function ticket(id: string, status: ApprovalTicket['status'] = 'PENDING'): ApprovalTicket {
  return {
    id, status, createdAt: NOON, expiresAt: NOON + 3_600_000,
    actionDigest: 'd'.repeat(64), summary: 's', symbol: 'BTCUSDT', notionalUsd: 300,
    findings: [], proposal: { category: 'trade', venue: 'spot' } as ProposedAction,
    resolvedAt: null, resolvedBy: null, resolution: null,
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aegis-sa-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// SA-01 — concurrent redemption must not double-execute
// ---------------------------------------------------------------------------

describe('SA-01 — ticket redemption is atomic under concurrency', () => {
  test('only one of many concurrent consumers wins', async () => {
    const store = new ApprovalStore(join(dir, 'approvals.json'));
    store.put(ticket('tkt-race'));

    // Ten simultaneous approvals, as two terminals plus a retrying agent would.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve().then(() => store.consume('tkt-race', NOON, 'APPROVED', `op-${i}`, 'go'))),
    );
    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1, 'exactly one consumer may win a single-use ticket');
  });

  test('a second sequential consume still fails', () => {
    const store = new ApprovalStore(join(dir, 'approvals.json'));
    store.put(ticket('tkt-seq'));
    assert.ok(store.consume('tkt-seq', NOON, 'APPROVED', 'a', 'go'));
    assert.equal(store.consume('tkt-seq', NOON, 'APPROVED', 'b', 'go'), null);
  });

  test('concurrent gateway approvals place exactly one order', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });
    const id = r.ticketId as string;

    // Three independent gateways racing, as three shells would.
    const gws = [makeGw(), makeGw(), makeGw()];
    const outcomes = await Promise.all(gws.map((g) => g.gw.approve(id, 'op')));
    const executed = outcomes.filter((o) => o.status === 'executed');
    const totalPlaced = gws.reduce((n, g) => n + g.spy.placed.length, 0);

    assert.equal(executed.length, 1, 'one winner');
    assert.equal(totalPlaced, 1, 'and exactly one order on the wire');
  });

  test('a stale lock does not deadlock the store', () => {
    const store = new ApprovalStore(join(dir, 'approvals.json'));
    store.put(ticket('tkt-lock'));
    // Simulate a crashed process that never released its lock, aged past the
    // staleness threshold.
    const lockPath = join(dir, 'approvals.json.lock');
    mkdirSync(lockPath, { recursive: true });
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    const consumed = store.consume('tkt-lock', NOON, 'APPROVED', 'op', 'go');
    assert.ok(consumed, 'a lock left by a dead process must eventually be broken');
  });
});

// ---------------------------------------------------------------------------
// SA-02 — protective stops only where the venue supports them
// ---------------------------------------------------------------------------

describe('SA-02 — no STOP_MARKET on spot', () => {
  test('a spot entry with a stopPrice does not emit a futures-style stop', async () => {
    const { gw, spy } = makeGw();
    await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    const stops = spy.placed.filter((a) => a.orderType === 'STOP_MARKET');
    assert.equal(stops.length, 0, 'spot does not take STOP_MARKET; sending one would be rejected or wrong');
  });

  test('a futures entry with a stopPrice does emit the protective stop', async () => {
    const { gw, spy } = makeGw();
    await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 100, stopPrice: 95_000,
    });
    const stops = spy.placed.filter((a) => a.orderType === 'STOP_MARKET');
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.reduceOnly, true);
  });

  test('the protective stop is sized to what actually filled', async () => {
    const { gw, spy } = makeGw();
    await gw.execute({
      category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'BUY',
      orderType: 'MARKET', quoteQuantity: 200, stopPrice: 95_000,
    });
    const entry = spy.placed[0];
    const stop = spy.placed[1];
    assert.equal(stop?.executionQuantity, entry?.executionQuantity);
  });
});

// ---------------------------------------------------------------------------
// SA-03 — the instruction a user copies must actually work
// ---------------------------------------------------------------------------

describe('SA-03 — approval instructions are copy-pasteable', () => {
  test('the parked summary names the flag that actually executes', async () => {
    const { gw } = makeGw();
    const r = await gw.execute({
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });
    assert.match(r.summary, /aegis approve \S+ --live/, 'omitting --live silently no-ops for the operator');
  });
});

// ---------------------------------------------------------------------------
// SA-04 — a broken adapter must not bury the ledger
// ---------------------------------------------------------------------------

describe('SA-04 — repeated refresh failures are suppressed', () => {
  test('an identical failure is recorded once, not once per call', async () => {
    const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
    aegis.updateAccount({ equityUsd: 10_000, positions: [], marks: { BTCUSDT: 100_000 } });
    const failing = {
      async equityUsd(): Promise<number> { throw new Error('binance-cli not found'); },
      async positions(): Promise<never[]> { throw new Error('binance-cli not found'); },
      async marks(): Promise<Record<string, number>> { throw new Error('binance-cli not found'); },
    };
    const gw = new ExecutionGateway(aegis, new Spy(), { dataDir: dir, refresher: failing });

    for (let i = 0; i < 25; i += 1) {
      await gw.execute({ category: 'read', venue: 'market-data', symbol: 'BTCUSDT' });
    }

    const notes = aegis.ledger.byType('note')
      .filter((e) => String((e.payload as { message?: string }).message ?? '').includes('refresh failed'));
    assert.ok(notes.length <= 2, `25 identical failures should not write 25 notes (wrote ${notes.length})`);
  });
});

// ---------------------------------------------------------------------------
// SA-05 — concurrent duplicate submissions must execute once
// ---------------------------------------------------------------------------

describe('SA-05 — in-flight reservation closes the replay race', () => {
  /** A venue with latency, so concurrent calls genuinely interleave. */
  class SlowSpy implements OrderExecutor {
    readonly placed: NormalizedAction[] = [];
    async placeOrder(action: NormalizedAction): Promise<FillReport> {
      this.placed.push(action);
      await new Promise((r) => setTimeout(r, 5));
      return {
        ok: true, orderId: `o-${this.placed.length}`, clientOrderId: action.id,
        symbol: action.symbol ?? '', status: 'FILLED',
        filledNotionalUsd: action.notionalUsd, filledQuantity: 0.001,
        realizedPnlUsd: 0, raw: {},
      };
    }
  }

  function slowGw() {
    const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(POLICY), clock: () => NOON });
    aegis.updateAccount({ equityUsd: 10_000, positions: [], marks: { BTCUSDT: 100_000 } });
    const spy = new SlowSpy();
    return { aegis, spy, gw: new ExecutionGateway(aegis, spy, { dataDir: dir }) };
  }

  const dup: ProposedAction = {
    id: 'retry-me', category: 'trade', venue: 'spot', symbol: 'BTCUSDT',
    side: 'BUY', orderType: 'MARKET', quoteQuantity: 100,
  };

  test('five concurrent identical submissions place exactly one order', async () => {
    const { gw, spy } = slowGw();
    const results = await Promise.all(Array.from({ length: 5 }, () => gw.execute(dup)));
    assert.equal(spy.placed.length, 1, 'an MCP timeout retry must not become a second position');
    assert.equal(results.filter((r) => r.status === 'executed').length, 1);
  });

  test('the losers are told why, not silently dropped', async () => {
    const { gw } = slowGw();
    const results = await Promise.all(Array.from({ length: 3 }, () => gw.execute(dup)));
    const blocked = results.filter((r) => r.status === 'blocked');
    assert.ok(blocked.length >= 1);
    assert.ok(blocked.some((r) => r.decision.findings.some((f) => f.ruleId === 'action-in-flight')));
  });

  test('a different id is unaffected', async () => {
    const { gw, spy } = slowGw();
    await Promise.all([
      gw.execute({ ...dup, id: 'a' }),
      gw.execute({ ...dup, id: 'b' }),
      gw.execute({ ...dup, id: 'c' }),
    ]);
    assert.equal(spy.placed.length, 3);
  });

  test('the reservation is released so a later legitimate retry can proceed', async () => {
    const { gw, spy } = slowGw();
    await gw.execute({ ...dup, id: 'once' });
    await gw.execute({ ...dup, id: 'twice' });
    assert.equal(spy.placed.length, 2, 'reservations must not leak');
  });
});

// ---------------------------------------------------------------------------
// SA-06 — reservations are leases, never permanent blacklists
// ---------------------------------------------------------------------------

describe('SA-06 — in-flight reservations expire', () => {
  test('an id becomes reservable again after the lease elapses', async () => {
    const { InFlightRegistry } = await import('../src/gateway/inflight.js');
    const reg = new InFlightRegistry(join(dir, 'inflight.json'));
    const now = Date.now();
    assert.equal(reg.reserve('X', now), true);
    assert.equal(reg.reserve('X', now), false, 'concurrent duplicate refused');
    assert.equal(reg.reserve('X', now + 130_000), true, 'a leaked reservation must not blacklist an id forever');
  });

  test('an explicit release frees it immediately', async () => {
    const { InFlightRegistry } = await import('../src/gateway/inflight.js');
    const reg = new InFlightRegistry(join(dir, 'inflight.json'));
    const now = Date.now();
    assert.equal(reg.reserve('Y', now), true);
    reg.release('Y');
    assert.equal(reg.reserve('Y', now), true);
  });

  test('the local map does not grow without bound', async () => {
    const { InFlightRegistry } = await import('../src/gateway/inflight.js');
    const reg = new InFlightRegistry(join(dir, 'inflight.json'));
    const now = Date.now();
    for (let i = 0; i < 300; i += 1) reg.reserve(`id-${i}`, now);
    // A much later reservation sweeps everything expired.
    assert.equal(reg.reserve('final', now + 200_000), true);
    assert.equal(reg.activeCount(now + 200_000), 1);
  });
});
