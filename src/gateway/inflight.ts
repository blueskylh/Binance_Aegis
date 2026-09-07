/**
 * In-flight action reservations.
 *
 * Self-audit finding SA-05. The `duplicate-action` rule consults executions
 * already written to the ledger, which makes it a check-then-act: five
 * concurrent submissions of the same action id all observe "not seen before" and
 * all proceed. Under MCP, where a client timeout followed by a retry is routine,
 * that turns one intended order into several real positions.
 *
 * A reservation closes the window. It is taken synchronously — before the first
 * `await` in the execute path — so within a process the JS event loop guarantees
 * exclusivity, and a lock-protected file extends the same guarantee across
 * processes for operators running several gateways against one data dir.
 *
 * Reservations are leases, not locks: they expire, so a crash mid-dispatch
 * cannot permanently blacklist an action id.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** How long a reservation survives without release. Longer than any venue call. */
const LEASE_MS = 120_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 2_000;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

interface Reservation {
  id: string;
  takenAt: number;
  /**
   * Unique per registry instance, not per process.
   *
   * A PID identifies the process, so two ExecutionGateway instances inside one
   * Node process shared a PID, ignored each other's durable entries, and could
   * both reserve the same id.
   */
  owner: string;
}

export class InFlightRegistry {
  private readonly path: string;
  /**
   * Fast in-process guard; the file covers the cross-process case.
   *
   * Keyed by id -> takenAt so the local half honours the same lease as the
   * durable half. Self-audit found that a plain Set never expired, so a leaked
   * reservation would blacklist an action id for the life of the process.
   */
  private readonly local = new Map<string, number>();
  /** Identity of this registry instance, so sibling gateways do not collide. */
  private readonly owner = randomUUID();

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  private withLock<T>(fn: () => T): T {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    for (;;) {
      try { mkdirSync(lockPath); break; } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch { continue; }
        if (Date.now() > deadline) {
          // Fail closed: if we cannot take the lock we do not reserve, and the
          // caller treats that as "already in flight" rather than proceeding.
          throw new Error('timed out waiting for the in-flight registry lock');
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try { return fn(); } finally { rmSync(lockPath, { recursive: true, force: true }); }
  }

  private read(): Reservation[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { reservations?: Reservation[] };
      return Array.isArray(parsed.reservations) ? parsed.reservations : [];
    } catch {
      return [];
    }
  }

  private write(reservations: Reservation[]): void {
    const tmp = join(dirname(this.path), `.inflight-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ version: 1, reservations }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  /**
   * Try to claim an action id.
   *
   * Returns true only for the caller that won it. Must be called synchronously
   * before any `await`, which is what makes the in-process half airtight.
   */
  reserve(id: string, now: number): boolean {
    const heldSince = this.local.get(id);
    if (heldSince !== undefined && now - heldSince < LEASE_MS) return false;
    this.local.set(id, now);

    try {
      return this.withLock(() => {
        const live = this.read().filter((r) => now - r.takenAt < LEASE_MS);
        if (live.some((r) => r.id === id && r.owner !== this.owner)) {
          this.local.delete(id);
          return false;
        }
        this.sweepLocal(now);
        this.write([...live.filter((r) => r.id !== id), { id, takenAt: now, owner: this.owner }]);
        return true;
      });
    } catch {
      // Could not reach the shared registry. The comment here used to claim
      // "refusing is safer than racing" while the code returned true, i.e.
      // proceeded. Self-audit caught the contradiction: fail CLOSED.
      this.local.delete(id);
      return false;
    }
  }

  release(id: string): void {
    this.local.delete(id);
    try {
      this.withLock(() => { this.write(this.read().filter((r) => r.id !== id)); });
    } catch {
      // A leaked reservation expires on its own; nothing to recover here.
    }
  }

  activeCount(now: number): number {
    return this.read().filter((r) => now - r.takenAt < LEASE_MS).length;
  }

  /** Drop expired local entries so the map cannot grow without bound. */
  private sweepLocal(now: number): void {
    for (const [key, takenAt] of this.local) {
      if (now - takenAt >= LEASE_MS) this.local.delete(key);
    }
  }
}
