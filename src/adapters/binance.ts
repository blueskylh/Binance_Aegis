/**
 * Binance Agent OS adapter.
 *
 * Aegis reads account state and (in gateway mode) places orders through
 * `binance-cli`, the official CLI from the Binance Skills Hub, rather than a
 * hand-rolled REST client. Auth, signing and endpoint drift stay Binance's
 * problem.
 *
 * ## Command names are verified, not remembered
 *
 * v1.0.0 guessed at subcommand names (`spot account`, `spot
 * cancel-all-open-orders`) and got them wrong. The real surface, taken from
 * `binance/binance-cli` `examples/`, is:
 *
 *   spot get-account            spot ticker-price          spot get-open-orders
 *   spot delete-open-orders     spot new-order             spot get-order
 *   futures-usds account-information-v3
 *   futures-usds cancel-all-open-orders
 *   futures-usds new-order
 *
 * Note `--rtype` (not `--type`) for order type — a detail that silently breaks
 * every order if you assume otherwise. `aegis doctor` probes the installed CLI
 * and prints what it actually found, so this can never be a matter of belief.
 *
 * ## Write discipline
 *
 * Only two write paths exist and both are risk-relevant:
 *   - `placeOrder` — reachable ONLY from the ExecutionGateway, after an allow.
 *   - `cancelAllOpenOrders` — risk-reducing only; used by the guardian breaker.
 *
 * Every call degrades gracefully: if the CLI is missing or unauthenticated,
 * Aegis keeps enforcing on its last known snapshot instead of failing open.
 */

import { execFile } from 'node:child_process';
import type { NormalizedAction, PositionSnapshot } from '../types.js';
import type { FillReport, OrderExecutor } from '../gateway/executor.js';

export interface CliResult {
  ok: boolean;
  data: unknown;
  error: string | null;
  /** The argv actually invoked — surfaced by `aegis doctor` as evidence. */
  argv: string[];
}

export interface AdapterOptions {
  bin?: string;
  timeoutMs?: number;
  profile?: string;
}

/** Promise wrapper around execFile. No shell, so no interpolation surface. */
function run(bin: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return new Promise((resolveP) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout ?? '').trim();
      const argv = [bin, ...args];
      if (err) {
        const detail = String(stderr ?? '').trim() || err.message;
        if (out !== '') {
          try { resolveP({ ok: false, data: JSON.parse(out), error: detail, argv }); return; } catch { /* fall through */ }
        }
        resolveP({ ok: false, data: null, error: detail, argv });
        return;
      }
      if (out === '') { resolveP({ ok: true, data: null, error: null, argv }); return; }
      try { resolveP({ ok: true, data: JSON.parse(out), error: null, argv }); }
      catch { resolveP({ ok: true, data: out, error: null, argv }); }
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

const USD_PEGGED = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'];

export class BinanceAdapter implements OrderExecutor {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly profile: string | null;

  constructor(options: AdapterOptions = {}) {
    this.bin = options.bin ?? process.env['AEGIS_BINANCE_CLI'] ?? 'binance-cli';
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.profile = options.profile ?? process.env['BINANCE_CLI_PROFILE'] ?? null;
  }

  private args(list: string[]): string[] {
    return this.profile ? [...list, '--profile', this.profile] : list;
  }

  async version(): Promise<CliResult> {
    return run(this.bin, ['--version'], 5_000);
  }

  async available(): Promise<boolean> {
    return (await this.version()).ok;
  }

  // --- reads ---------------------------------------------------------------

  /** Public mark prices. Needs no credentials. */
  async marks(symbols: readonly string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const symbol of symbols) {
      const r = await run(this.bin, this.args(['spot', 'ticker-price', '--symbol', symbol]), this.timeoutMs);
      if (!r.ok || r.data === null) continue;
      const body = r.data as Record<string, unknown>;
      const nested = body['data'] as Record<string, unknown> | undefined;
      const price = num(body['price'] ?? nested?.['price']);
      if (price > 0) out[symbol] = price;
    }
    return out;
  }

  /** USD-M futures positions with non-zero size. */
  async positions(): Promise<PositionSnapshot[]> {
    const r = await run(this.bin, this.args(['futures-usds', 'account-information-v3']), this.timeoutMs);
    if (!r.ok || !r.data) return [];
    const root = r.data as Record<string, unknown>;
    const rows = pickArray(root['positions'] ?? root['data'] ?? root, 'positions', 'data');
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

  /** Total equity in USD across spot and USD-M futures wallets. */
  async equityUsd(): Promise<number> {
    let total = 0;

    const futures = await run(this.bin, this.args(['futures-usds', 'account-information-v3']), this.timeoutMs);
    if (futures.ok && futures.data && typeof futures.data === 'object') {
      const f = futures.data as Record<string, unknown>;
      const inner = (f['data'] as Record<string, unknown> | undefined) ?? f;
      total += num(inner['totalMarginBalance'] ?? inner['totalWalletBalance']);
    }

    const spot = await run(this.bin, this.args(['spot', 'get-account', '--omit-zero-balances', 'true']), this.timeoutMs);
    if (spot.ok && spot.data && typeof spot.data === 'object') {
      const root = spot.data as Record<string, unknown>;
      const balances = pickArray(root['balances'] ?? (root['data'] as Record<string, unknown> | undefined)?.['balances'] ?? root, 'balances');
      for (const raw of balances) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as Record<string, unknown>;
        const asset = String(b['asset'] ?? '');
        const amount = num(b['free']) + num(b['locked']);
        if (amount === 0) continue;
        // Only stablecoins are valued without a quote lookup; other assets are
        // priced by the caller through `marks`, so nothing is double-counted.
        if (USD_PEGGED.includes(asset)) total += amount;
      }
    }

    return Math.round(total * 100) / 100;
  }

  async openOrders(symbol: string, venue: 'spot' | 'futures-usds'): Promise<CliResult> {
    const cmd = venue === 'spot'
      ? ['spot', 'get-open-orders', '--symbol', symbol]
      : ['futures-usds', 'current-all-open-orders', '--symbol', symbol];
    return run(this.bin, this.args(cmd), this.timeoutMs);
  }

  // --- writes (gateway only) ----------------------------------------------

  /**
   * Place an order. Reachable only from the ExecutionGateway, after an allow.
   *
   * Both venues take `--rtype` for the order type, not `--type`.
   */
  async placeOrder(action: NormalizedAction): Promise<FillReport> {
    if (action.symbol === null || action.side === null) {
      throw new Error('placeOrder requires a symbol and a side');
    }

    // GW-03: never guess a venue. Rerouting an unsupported instrument to spot is
    // how you execute something other than what was authorised.
    if (action.venue !== 'spot' && action.venue !== 'futures-usds') {
      throw new Error(
        `the gateway cannot place orders on "${action.venue}" — supported venues are spot and futures-usds`,
      );
    }
    const venue = action.venue;

    const cmd: string[] = [
      venue, 'new-order',
      '--symbol', action.symbol,
      '--side', action.side,
      '--rtype', action.orderType ?? 'MARKET',
      '--new-client-order-id', action.id.slice(0, 36),
    ];

    if (venue === 'spot') {
      // Spot can size natively in quote terms, which is unambiguous.
      if (action.executionQuantity !== null) cmd.push('--quantity', String(action.executionQuantity));
      else cmd.push('--quote-order-qty', String(action.notionalUsd));
    } else {
      // GW-02: the adapter must NEVER re-derive a quantity. v2.0.0 computed
      // `notionalUsd / (price ?? 1)`, which turned a judged $100 order into
      // 100 BTC. The engine resolved this number; we send exactly that.
      if (action.executionQuantity === null) {
        throw new Error(
          'refusing to place a derivatives order with no engine-resolved quantity — ' +
          'this would mean sending a size the policy never judged',
        );
      }
      cmd.push('--quantity', String(action.executionQuantity));
      if (action.reduceOnly) cmd.push('--reduce-only', 'TRUE');
      if (action.closePosition) cmd.push('--close-position', 'TRUE');
      if (action.orderType === 'STOP_MARKET' || action.orderType === 'TAKE_PROFIT_MARKET') {
        cmd.push('--stop-price', String(action.stopPrice ?? action.price));
      }
    }
    if (action.price !== null && action.orderType === 'LIMIT') cmd.push('--price', String(action.price));
    if (action.orderType === 'LIMIT') cmd.push('--time-in-force', 'GTC');

    const r = await run(this.bin, this.args(cmd), this.timeoutMs);
    if (!r.ok) {
      throw new Error(`binance-cli ${cmd.slice(0, 2).join(' ')} failed: ${r.error ?? 'unknown error'}`);
    }

    const body = (r.data ?? {}) as Record<string, unknown>;
    const inner = (body['data'] as Record<string, unknown> | undefined) ?? body;

    // Prefer the venue's own numbers over anything the caller asserted.
    // GW-04: report ONLY what the venue says filled. v2.0.0 fell back to the
    // requested notional when fill fields were absent, so a resting LIMIT order
    // was booked as a completed trade. Absent data now means zero, not "assume
    // it worked" — a firewall must not launder a request into a fill.
    const executedQty = num(inner['executedQty']);
    const cummulativeQuote = num(inner['cummulativeQuoteQty'] ?? inner['cumQuote']);
    const avgPrice = num(inner['avgPrice']);
    const filledNotionalUsd = cummulativeQuote > 0
      ? cummulativeQuote
      : executedQty > 0 && avgPrice > 0
        ? executedQty * avgPrice
        : 0;

    return {
      ok: true,
      orderId: inner['orderId'] === undefined ? null : String(inner['orderId']),
      clientOrderId: inner['clientOrderId'] === undefined ? null : String(inner['clientOrderId']),
      symbol: String(inner['symbol'] ?? action.symbol),
      status: String(inner['status'] ?? 'UNKNOWN'),
      filledNotionalUsd: Math.round(filledNotionalUsd * 1e8) / 1e8,
      filledQuantity: Math.round(executedQty * 1e8) / 1e8,
      realizedPnlUsd: num(inner['realizedPnl'] ?? 0),
      raw: r.data,
    };
  }

  /** Risk-reducing escape hatch used by the guardian's circuit breaker. */
  async cancelAllOpenOrders(symbol: string, venue: 'spot' | 'futures-usds'): Promise<CliResult> {
    const cmd = venue === 'spot'
      ? ['spot', 'delete-open-orders', '--symbol', symbol]
      : ['futures-usds', 'cancel-all-open-orders', '--symbol', symbol];
    return run(this.bin, this.args(cmd), this.timeoutMs);
  }

  // --- diagnostics ---------------------------------------------------------

  /** Probe the installed CLI and return raw evidence for `aegis doctor`. */
  async probe(symbol = 'BTCUSDT'): Promise<Array<{ label: string; argv: string[]; ok: boolean; detail: string }>> {
    const checks: Array<{ label: string; cmd: string[] }> = [
      { label: 'CLI present', cmd: ['--version'] },
      { label: 'Public market data', cmd: ['spot', 'ticker-price', '--symbol', symbol] },
      { label: 'Spot account (auth)', cmd: ['spot', 'get-account', '--omit-zero-balances', 'true'] },
      { label: 'USD-M account (auth)', cmd: ['futures-usds', 'account-information-v3'] },
    ];
    const out: Array<{ label: string; argv: string[]; ok: boolean; detail: string }> = [];
    for (const c of checks) {
      const r = await run(this.bin, this.args(c.cmd), 12_000);
      const preview = r.ok
        ? JSON.stringify(r.data).slice(0, 160)
        : (r.error ?? 'unknown error').slice(0, 160);
      out.push({ label: c.label, argv: r.argv, ok: r.ok, detail: preview });
    }
    return out;
  }
}
