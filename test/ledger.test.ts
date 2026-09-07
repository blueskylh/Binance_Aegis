import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, GENESIS_HASH, canonicalize } from '../src/ledger/ledger.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aegis-ledger-'));
  path = join(dir, 'ledger.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('canonicalize', () => {
  test('is stable regardless of key insertion order', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  });

  test('recurses into nested objects and arrays', () => {
    const x = canonicalize({ z: [{ b: 1, a: 2 }] });
    const y = canonicalize({ z: [{ a: 2, b: 1 }] });
    assert.equal(x, y);
  });

  test('distinguishes different values', () => {
    assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
  });

  test('handles null and undefined deterministically', () => {
    assert.equal(canonicalize({ a: null }), canonicalize({ a: null }));
    assert.ok(canonicalize({ a: undefined }).length > 0);
  });
});

describe('Ledger — append and chain', () => {
  test('starts empty with the genesis head', () => {
    const l = new Ledger(path);
    assert.equal(l.size(), 0);
    assert.equal(l.head(), GENESIS_HASH);
  });

  test('appends an entry with seq 1 chained to genesis', () => {
    const l = new Ledger(path);
    const e = l.append('decision', { verdict: 'allow' }, 1000);
    assert.equal(e.seq, 1);
    assert.equal(e.prevHash, GENESIS_HASH);
    assert.equal(e.ts, 1000);
    assert.match(e.hash, /^[0-9a-f]{64}$/);
  });

  test('chains each entry to its predecessor', () => {
    const l = new Ledger(path);
    const a = l.append('decision', { n: 1 }, 1000);
    const b = l.append('execution', { n: 2 }, 2000);
    assert.equal(b.prevHash, a.hash);
    assert.equal(b.seq, 2);
  });

  test('produces different hashes for different payloads', () => {
    const l = new Ledger(path);
    const a = l.append('note', { n: 1 }, 1000);
    const b = new Ledger(join(dir, 'other.jsonl')).append('note', { n: 2 }, 1000);
    assert.notEqual(a.hash, b.hash);
  });

  test('is deterministic — same inputs give the same chain', () => {
    const a = new Ledger(join(dir, 'a.jsonl'));
    const b = new Ledger(join(dir, 'b.jsonl'));
    a.append('note', { x: 1 }, 5); a.append('note', { y: 2 }, 6);
    b.append('note', { x: 1 }, 5); b.append('note', { y: 2 }, 6);
    assert.equal(a.head(), b.head());
  });

  test('persists across instances', () => {
    const l1 = new Ledger(path);
    l1.append('decision', { a: 1 }, 100);
    l1.append('decision', { a: 2 }, 200);
    const l2 = new Ledger(path);
    assert.equal(l2.size(), 2);
    assert.equal(l2.head(), l1.head());
    const l3 = new Ledger(path);
    const next = l3.append('decision', { a: 3 }, 300);
    assert.equal(next.seq, 3);
  });

  test('writes one JSON object per line', () => {
    const l = new Ledger(path);
    l.append('note', { a: 1 }, 1);
    l.append('note', { a: 2 }, 2);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });
});

describe('Ledger — verification', () => {
  test('verifies an untouched chain', () => {
    const l = new Ledger(path);
    for (let i = 0; i < 20; i += 1) l.append('decision', { i }, 1000 + i);
    const r = new Ledger(path).verify();
    assert.equal(r.ok, true);
    assert.equal(r.entries, 20);
    assert.equal(r.brokenAt, null);
  });

  test('verifies an empty chain', () => {
    assert.equal(new Ledger(path).verify().ok, true);
  });

  test('detects a mutated payload', () => {
    const l = new Ledger(path);
    l.append('decision', { verdict: 'deny', notional: 100 }, 1);
    l.append('decision', { verdict: 'allow', notional: 50 }, 2);
    l.append('decision', { verdict: 'allow', notional: 60 }, 3);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1] as string);
    tampered.payload.verdict = 'deny';
    lines[1] = JSON.stringify(tampered);
    writeFileSync(path, lines.join('\n') + '\n');

    const r = new Ledger(path).verify();
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 2);
    assert.match(r.reason ?? '', /hash/i);
  });

  test('detects a deleted entry', () => {
    const l = new Ledger(path);
    for (let i = 0; i < 5; i += 1) l.append('decision', { i }, i);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines.splice(2, 1);
    writeFileSync(path, lines.join('\n') + '\n');

    const r = new Ledger(path).verify();
    assert.equal(r.ok, false);
  });

  test('detects a reordered chain', () => {
    const l = new Ledger(path);
    for (let i = 0; i < 4; i += 1) l.append('decision', { i }, i);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const tmp = lines[1] as string;
    lines[1] = lines[2] as string;
    lines[2] = tmp;
    writeFileSync(path, lines.join('\n') + '\n');
    assert.equal(new Ledger(path).verify().ok, false);
  });

  test('detects an appended forgery', () => {
    const l = new Ledger(path);
    l.append('decision', { i: 1 }, 1);
    const forged = {
      seq: 2, ts: 2, type: 'decision', prevHash: 'deadbeef'.repeat(8),
      hash: 'f'.repeat(64), payload: { i: 'forged' },
    };
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(forged) + '\n');
    assert.equal(new Ledger(path).verify().ok, false);
  });

  test('reports a corrupt (non-JSON) line rather than crashing', () => {
    const l = new Ledger(path);
    l.append('decision', { i: 1 }, 1);
    writeFileSync(path, readFileSync(path, 'utf8') + 'not json at all\n');
    const r = new Ledger(path).verify();
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /parse|json/i);
  });
});

describe('Ledger — reading', () => {
  test('tail returns the most recent entries newest-last', () => {
    const l = new Ledger(path);
    for (let i = 1; i <= 10; i += 1) l.append('decision', { i }, i);
    const tail = l.tail(3);
    assert.equal(tail.length, 3);
    assert.equal(tail[0]?.seq, 8);
    assert.equal(tail[2]?.seq, 10);
  });

  test('tail on an empty ledger returns an empty array', () => {
    assert.deepEqual(new Ledger(path).tail(5), []);
  });

  test('filters entries by type', () => {
    const l = new Ledger(path);
    l.append('decision', { a: 1 }, 1);
    l.append('execution', { a: 2 }, 2);
    l.append('decision', { a: 3 }, 3);
    assert.equal(l.byType('decision').length, 2);
    assert.equal(l.byType('execution').length, 1);
  });

  test('survives a truncated final line left by a crash', () => {
    const l = new Ledger(path);
    l.append('decision', { i: 1 }, 1);
    l.append('decision', { i: 2 }, 2);
    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, raw.slice(0, raw.length - 12));
    const reopened = new Ledger(path);
    assert.ok(reopened.size() >= 1, 'the intact prefix is still readable');
  });
});
