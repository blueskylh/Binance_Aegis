/**
 * Durable approval tickets.
 *
 * v2.0.0 kept pending approvals in a `Map` on the gateway instance. That works
 * inside a single long-lived MCP server and passes any test that reuses one
 * object — but the CLI builds a fresh gateway per invocation, so the real
 * operator flow was broken end to end:
 *
 *     process A:  aegis execute …   → parks tkt-123 in memory → exits
 *     process B:  aegis approve tkt-123 → new Map → "no such pending ticket"
 *
 * A human-in-the-loop control that cannot be completed by a human is worse than
 * none, because the UI implies an approval happened somewhere.
 *
 * Tickets now live in `approvals.json` beside the ledger: atomic writes, single
 * use, explicit state machine, and expiry evaluated on read.
 *
 *     PENDING ──approve──▶ APPROVED
 *             ──reject───▶ REJECTED
 *             ──ttl──────▶ EXPIRED
 *
 * Terminal states are retained (not deleted) so `aegis ledger`-style forensics
 * can answer "who approved what, and when" long after the fact.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProposedAction } from '../types.js';

export type TicketStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ApprovalTicket {
  id: string;
  status: TicketStatus;
  createdAt: number;
  expiresAt: number;
  /** SHA-256 of the normalized action — binds approval to exactly what was shown. */
  actionDigest: string;
  summary: string;
  symbol: string | null;
  notionalUsd: number;
  findings: string[];
  proposal: ProposedAction;
  /** Set when the ticket leaves PENDING. */
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolution: string | null;
}

interface StoreFile {
  version: 1;
  tickets: ApprovalTicket[];
}

const EMPTY: StoreFile = { version: 1, tickets: [] };
/** Keep terminal tickets for a week, then prune so the file cannot grow forever. */
const RETENTION_MS = 7 * 24 * 3_600_000;
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 15;
const LOCK_MAX_WAIT_MS = 3_000;

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export class ApprovalStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) return { ...EMPTY, tickets: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreFile>;
      return { version: 1, tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [] };
    } catch {
      // A corrupt approvals file must not brick execution. Degrade to empty:
      // the safe failure is "nothing is approved", never "everything is".
      return { ...EMPTY, tickets: [] };
    }
  }

  /** Atomic write: temp file + rename, so a crash never leaves a half-written store. */
  private write(file: StoreFile): void {
    const tmp = join(dirname(this.path), `.approvals-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  /**
   * Cross-process mutual exclusion around read-modify-write.
   *
   * Self-audit finding SA-01: `consume` was read → check → write, which is atomic
   * inside one process but not across two. Two terminals running `aegis approve`
   * on the same ticket could each observe PENDING and each execute — defeating
   * the single-use guarantee that the whole human-in-the-loop design rests on.
   *
   * `mkdir` is atomic on every POSIX filesystem and on Windows, which makes it a
   * dependency-free mutex. A lock left behind by a crashed process is broken
   * after LOCK_STALE_MS so a dead approver cannot wedge the queue forever.
   */
  private withLock<T>(fn: () => T): T {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;

    for (;;) {
      try {
        mkdirSync(lockPath);
        break;
      } catch {
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // the lock vanished between our check and stat; retry
        }
        if (Date.now() > deadline) {
          // Fail closed: refusing to act is always safer than acting unguarded.
          throw new Error('timed out waiting for the approvals lock; no ticket was consumed');
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  put(ticket: ApprovalTicket): void {
    this.withLock(() => {
      const file = this.read();
      file.tickets = file.tickets.filter((t) => t.id !== ticket.id);
      file.tickets.push(ticket);
      this.write(this.prune(file, ticket.createdAt));
    });
  }

  get(id: string, now: number): ApprovalTicket | null {
    const found = this.read().tickets.find((t) => t.id === id);
    if (!found) return null;
    if (found.status === 'PENDING' && now > found.expiresAt) {
      return { ...found, status: 'EXPIRED' };
    }
    return found;
  }

  /**
   * Atomically move a ticket out of PENDING.
   *
   * Returns the ticket only if this call is the one that consumed it, so a
   * double approval — from two terminals, or a retrying agent — can never
   * execute twice.
   */
  consume(id: string, now: number, status: 'APPROVED' | 'REJECTED', by: string, note: string): ApprovalTicket | null {
    return this.withLock(() => {
      const file = this.read();
      const idx = file.tickets.findIndex((t) => t.id === id);
      if (idx === -1) return null;

      const ticket = file.tickets[idx] as ApprovalTicket;
      if (ticket.status !== 'PENDING') return null;
      if (now > ticket.expiresAt) {
        file.tickets[idx] = { ...ticket, status: 'EXPIRED', resolvedAt: now, resolvedBy: by, resolution: 'expired' };
        this.write(file);
        return null;
      }

      const consumed: ApprovalTicket = {
        ...ticket, status, resolvedAt: now, resolvedBy: by, resolution: note,
      };
      file.tickets[idx] = consumed;
      this.write(file);
      return consumed;
    });
  }

  listPending(now: number): ApprovalTicket[] {
    return this.read().tickets
      .filter((t) => t.status === 'PENDING' && now <= t.expiresAt)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listAll(): ApprovalTicket[] {
    return this.read().tickets.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  private prune(file: StoreFile, now: number): StoreFile {
    return {
      version: 1,
      tickets: file.tickets.filter((t) => t.status === 'PENDING' || now - (t.resolvedAt ?? t.createdAt) < RETENTION_MS),
    };
  }
}
