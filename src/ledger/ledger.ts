/**
 * Tamper-evident audit ledger.
 *
 * Every decision and execution is appended as one JSON line, chained to its
 * predecessor:
 *
 *   hash(n) = H( prevHash ‖ canonicalJSON(seq, ts, type, payload) )
 *
 * where H is SHA-256, or HMAC-SHA256 when `AEGIS_LEDGER_KEY` is set.
 *
 * ## Threat model — stated honestly
 *
 * Unkeyed mode is **tamper-evident, not tamper-proof**. It detects edits,
 * deletions, reordering and naïve appends. It does NOT stop an attacker who has
 * write access to the file and knows the algorithm: they can recompute the whole
 * chain from the point of the edit onward. Claiming otherwise would be the kind
 * of overstatement that discredits a security tool.
 *
 * Set `AEGIS_LEDGER_KEY` to close that gap. The chain then uses HMAC-SHA256, and
 * forging it requires the key — which lives with the operator, not in the
 * agent's environment. That is the difference between "someone edited this" and
 * "nobody but you could have written this".
 *
 * For the strongest form, periodically publish `aegis ledger head` somewhere you
 * do not control (a git commit, a chat message, an object store with WORM). An
 * external anchor makes even a full rewrite detectable.
 *
 * ## Why JSONL over a database
 *
 * Greppable, diffable, shippable to S3 or a SIEM with `cat`, and a crash costs
 * at worst one partial trailing line — which the reader stops cleanly at rather
 * than discarding an otherwise valid history.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import type { LedgerEntry, LedgerEventType } from '../types.js';

/** Chain anchor. Fixed constant so independent verifiers agree. */
export const GENESIS_HASH: string = createHash('sha256').update('aegis-ledger-genesis-v1').digest('hex');

/** Operator key for HMAC mode. Read once at import so the agent cannot swap it mid-run. */
function ledgerKey(): string | null {
  const k = process.env['AEGIS_LEDGER_KEY'];
  return k && k.length > 0 ? k : null;
}

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
  const material = canonicalize({ seq, ts, type, payload });
  const key = ledgerKey();
  if (key !== null) {
    return createHmac('sha256', key).update(prevHash).update(material).digest('hex');
  }
  return createHash('sha256').update(prevHash).update(material).digest('hex');
}

/** Constant-time hex comparison, so verification cannot be probed by timing. */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** Sequence number of the first bad entry, or null when the chain is intact. */
  brokenAt: number | null;
  reason: string | null;
  head: string;
  /** True when an operator key is in use, so the chain is unforgeable without it. */
  keyed: boolean;
  /** Plain-language statement of what this verification does and does not prove. */
  assurance: string;
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
    const keyed = ledgerKey() !== null;
    const assurance = keyed
      ? 'HMAC mode: forging this chain requires AEGIS_LEDGER_KEY, which the agent does not hold.'
      : 'Unkeyed mode: detects edits, deletions and reordering. An attacker with write access ' +
        'and knowledge of the algorithm could recompute the chain — set AEGIS_LEDGER_KEY to prevent that.';
    const fail = (entries: number, brokenAt: number | null, reason: string, head: string): VerifyResult =>
      ({ ok: false, entries, brokenAt, reason, head, keyed, assurance });

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      return fail(0, null, `cannot read ledger: ${(err as Error).message}`, GENESIS_HASH);
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
        return fail(count, lineNo, `line ${lineNo} is not valid JSON (parse error: ${(err as Error).message})`, prevHash);
      }

      if (entry.seq !== lineNo) {
        return fail(count, lineNo, `sequence gap: line ${lineNo} declares seq ${entry.seq} — an entry was deleted or reordered`, prevHash);
      }
      if (entry.prevHash !== prevHash) {
        return fail(count, entry.seq, `broken link at seq ${entry.seq}: prevHash does not match the previous entry's hash`, prevHash);
      }
      const expected = computeHash(entry.prevHash, entry.seq, entry.ts, entry.type, entry.payload);
      if (!hashesEqual(expected, entry.hash)) {
        return fail(count, entry.seq, `hash mismatch at seq ${entry.seq}: the payload was modified after it was written`, prevHash);
      }
      prevHash = entry.hash;
      count += 1;
    }

    return { ok: true, entries: count, brokenAt: null, reason: null, head: prevHash, keyed, assurance };
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
