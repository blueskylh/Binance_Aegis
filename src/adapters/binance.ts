/**
 * Binance Agent OS adapter.
 *
 * Aegis reads account and market state through `binance-cli` — the official
 * Agent OS CLI from the Binance Skills Hub — rather than a hand-rolled REST
 * client. That keeps auth, signing and endpoint drift Binance's problem, not
 * ours.
 *
 * Two hard rules:
 *  1. This adapter is **read-only**. Aegis authorizes actions; it never places
 *     them. The one exception is `cancelAllOpenOrders`, which only ever reduces
 *     risk and is what makes the guardian's circuit breaker meaningful.
 *  2. Every call degrades gracefully. If `binance-cli` is missing or
 *     unauthenticated, Aegis keeps enforcing on its last known snapshot instead
 *     of failing open.
 */

import { execFile } from 'node:child_process';
import type { PositionSnapshot } from '../types.js';

export interface CliResult {
  ok: boolean;
  data: unknown;
  error: string | null;
}

export interface AdapterOptions {
  /** Binary name or path. Override for testing or a pinned install. */
  bin?: string;
  timeoutMs?: number;
  /** binance-cli profile, when several accounts are configured. */
  profile?: string;
}

/** Promise wrapper around execFile with a hard timeout and no shell. */
function run(bin: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return new Promise((resolveP) => {
    // execFile (not exec) — no shell means no interpolation surface.
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout ?? '').trim();
      if (err) {
        const detail = String(stderr ?? '').trim() || err.message;
        // A CLI can exit non-zero yet still print a useful JSON error body.
        if (out !== '') {
          try {
            resolveP({ ok: false, data: JSON.parse(out), error: detail });
            return;
          } catch { /* fall through */ }
        }
        resolveP({ ok: false, data: null, error: detail });
        return;
      }
      if (out === '') {
        resolveP({ ok: true, data: null, error: null });
        return;
      }
      try {
        resolveP({ ok: true, data: JSON.parse(out), error: null });
      } catch {
        resolveP({ ok: true, data: out, error: null });
      }
    });
  });
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pickArray(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of keys) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export class BinanceAdapter {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly profile: string | null;

  constructor(options: AdapterOptions = {}) {
    this.bin = options.bin ?? process.env['AEGIS_BINANCE_CLI'] ?? 'binance-cli';
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.profile = options.profile ?? process.env['BINANCE_CLI_PROFILE'] ?? null;
  }

  private withProfile(args: string[]): string[] {
    return this.profile ? [...args, '--profile', this.profile] : args;
  }

  /** True when the CLI is installed and runnable. */
  async available(): Promise<boolean> {
    const r = await run(this.bin, ['--version'], 5_000);
    return r.ok;
  }

  /** Public mark prices for the given symbols. Needs no credentials. */
  async marks(symbols: readonly string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const symbol of symbols) {
      const r = await run(this.bin, this.withProfile(['spot', 'ticker-price', '--symbol', symbol]), this.timeoutMs);
      if (!r.ok || r.data === null) continue;
      const body = r.data as Record<string, unknown>;
      const price = num(body['price'] ?? (body['data'] as Record<string, unknown> | undefined)?.['price']);
      if (price > 0) out[symbol] = price;
    }
    return out;
  }

  /** USD-M futures positions, filtered to non-zero size. */
  async positions(): Promise<PositionSnapshot[]> {
    const r = await run(this.bin, this.withProfile(['futures-usds', 'position-risk']), this.timeoutMs);
    if (!r.ok) return [];
    const rows = pickArray(r.data, 'positions', 'data');
    const out: PositionSnapshot[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const quantity = num(p['positionAmt'] ?? p['positionAmount'] ?? p['quantity']);
      if (quantity === 0) continue;
      const markPrice = num(p['markPrice'] ?? p['marketPrice']);
      out.push({
        symbol: String(p['symbol'] ?? ''),
        quantity,
        entryPrice: num(p['entryPrice']),
        markPrice,
        notionalUsd: Math.abs(num(p['notional'] ?? quantity * markPrice)),
        leverage: num(p['leverage']) || 1,
        unrealizedPnlUsd: num(p['unRealizedProfit'] ?? p['unrealizedProfit'] ?? p['unrealizedPnl']),
      });
    }
    return out;
  }

  /** Total account equity in USD across spot and USD-M futures wallets. */
  async equityUsd(): Promise<number> {
    let total = 0;

    const futures = await run(this.bin, this.withProfile(['futures-usds', 'account']), this.timeoutMs);
    if (futures.ok && futures.data && typeof futures.data === 'object') {
      const f = futures.data as Record<string, unknown>;
      total += num(f['totalMarginBalance'] ?? f['totalWalletBalance']);
    }

    const spot = await run(this.bin, this.withProfile(['spot', 'account']), this.timeoutMs);
    if (spot.ok && spot.data && typeof spot.data === 'object') {
      const balances = pickArray((spot.data as Record<string, unknown>)['balances'] ?? spot.data, 'balances');
      for (const raw of balances) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as Record<string, unknown>;
        const asset = String(b['asset'] ?? '');
        const amount = num(b['free']) + num(b['locked']);
        if (amount === 0) continue;
        // Only stablecoins are valued without a quote lookup; everything else is
        // priced by the caller through `marks`, so we do not double-count here.
        if (['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'].includes(asset)) total += amount;
      }
    }

    return Math.round(total * 100) / 100;
  }

  /**
   * Risk-reducing escape hatch: cancel all open orders for a symbol.
   * The only write this adapter is permitted to perform.
   */
  async cancelAllOpenOrders(symbol: string, venue: 'spot' | 'futures-usds'): Promise<CliResult> {
    return run(this.bin, this.withProfile([venue, 'cancel-all-open-orders', '--symbol', symbol]), this.timeoutMs);
  }
}
