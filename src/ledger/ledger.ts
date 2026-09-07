/**
 * Tamper-evident audit ledger.
 *
 * Binance Agent OS can tell you *what* your agent did. It cannot tell you what
 * your agent was *allowed* to do, by which policy, on what evidence. That gap is
 * what this ledger closes.
 *
 * Every decision and execution is appended as one JSON line, hash-chained to its
 * predecessor: hash(n) = SHA-256(prevHash + canonicalJSON(seq, ts, type, payload)).
 * Editing, deleting or reordering any entry breaks every hash after it, and
 * `verify()` reports the exact sequence number where the chain first diverges.
 *
 * Append-only JSONL is a deliberate choice over a database: it is greppable,
 * diffable, trivially shippable to S3 or a SIEM, and survives a crash with at
 * worst one partial trailing line.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { LedgerEntry, LedgerEventType } from '../types.js';

/** Chain anchor. Fixed constant so independent verifiers agree. */
export const GENESIS_HASH: string = createHash('sha256').update('aegis-ledger-genesis-v1').digest('hex');

/**
 * Deterministic JSON with sorted keys.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * payloads could hash differently. For a chain that is meant to be independently
 * re-verifiable, that is unacceptable.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '"__undefined__"';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : '"__nonfinite__"';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function computeHash(prevHash: string, seq: number, ts: number, type: string, payload: unknown): string {
  return createHash('sha256')
    .update(prevHash)
    .update(canonicalize({ seq, ts, type, payload }))
    .digest('hex');
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** Sequence number of the first bad entry, or null when the chain is intact. */
  brokenAt: number | null;
  reason: string | null;
  head: string;
}

export class Ledger {
  private readonly path: string;
  private entries: LedgerEntry[];

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      // Touch the file so `aegis ledger verify` works before the first decision.
      closeSync(openSync(path, 'a'));
    }
    this.entries = Ledger.readAll(path);
  }

  private static readAll(path: string): LedgerEntry[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as LedgerEntry;
        if (typeof parsed?.seq === 'number' && typeof parsed?.hash === 'string') out.push(parsed);
      } catch {
        // A crash can leave one partial trailing line. Stop cleanly at the last
        // intact record instead of discarding an otherwise valid history.
        break;
      }
    }
    return out;
  }

  /** SHA-256 of the newest entry, or the genesis anchor when empty. */
  head(): string {
    const last = this.entries.at(-1);
    return last ? last.hash : GENESIS_HASH;
  }

  size(): number {
    return this.entries.length;
  }

  /** Append a new entry and flush it to disk immediately. */
  append(type: LedgerEventType, payload: Record<string, unknown>, ts: number): LedgerEntry {
    const prevHash = this.head();
    const seq = this.entries.length + 1;
    const hash = computeHash(prevHash, seq, ts, type, payload);
    const entry: LedgerEntry = { seq, ts, type, hash, prevHash, payload };
    // Synchronous append: an audit record that might not have been written is
    // worse than a few milliseconds of latency.
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    this.entries.push(entry);
    return entry;
  }

  /** Recompute the whole chain and report the first divergence. */
  verify(): VerifyResult {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      return { ok: false, entries: 0, brokenAt: null, reason: `cannot read ledger: ${(err as Error).message}`, head: GENESIS_HASH };
    }

    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    let prevHash = GENESIS_HASH;
    let count = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1;
      let entry: LedgerEntry;
      try {
        entry = JSON.parse(lines[i] as string) as LedgerEntry;
      } catch (err) {
        return {
          ok: false, entries: count, brokenAt: lineNo,
          reason: `line ${lineNo} is not valid JSON (parse error: ${(err as Error).message})`,
          head: prevHash,
        };
      }

      if (entry.seq !== lineNo) {
        return {
          ok: false, entries: count, brokenAt: lineNo,
          reason: `sequence gap: line ${lineNo} declares seq ${entry.seq} — an entry was deleted or reordered`,
          head: prevHash,
        };
      }
      if (entry.prevHash !== prevHash) {
        return {
          ok: false, entries: count, brokenAt: entry.seq,
          reason: `broken link at seq ${entry.seq}: prevHash does not match the previous entry's hash`,
          head: prevHash,
        };
      }
      const expected = computeHash(entry.prevHash, entry.seq, entry.ts, entry.type, entry.payload);
      if (expected !== entry.hash) {
        return {
          ok: false, entries: count, brokenAt: entry.seq,
          reason: `hash mismatch at seq ${entry.seq}: the payload was modified after it was written`,
          head: prevHash,
        };
      }
      prevHash = entry.hash;
      count += 1;
    }

    return { ok: true, entries: count, brokenAt: null, reason: null, head: prevHash };
  }

  /** The last `n` entries, oldest first. */
  tail(n: number): LedgerEntry[] {
    if (n <= 0) return [];
    return this.entries.slice(Math.max(0, this.entries.length - n));
  }

  byType(type: LedgerEventType): LedgerEntry[] {
    return this.entries.filter((e) => e.type === type);
  }

  /** All entries with `ts >= since`. Used to rebuild rolling counters. */
  since(since: number): LedgerEntry[] {
    return this.entries.filter((e) => e.ts >= since);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }
}
