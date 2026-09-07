/**
 * Action normalization.
 *
 * Agents phrase the same intent a dozen ways: `quoteOrderQty: 250`,
 * `quantity: 0.0025 @ price 100000`, `quantity: 0.0025` at market. Limits are
 * meaningless unless every one of those collapses to a single comparable USD
 * notional first — so normalization happens before any rule runs.
 *
 * This module fails closed: anything it cannot size confidently raises, and the
 * engine converts that into a deny. A firewall that guesses is not a firewall.
 */

import { createHash } from 'node:crypto';
import { ACTION_CATEGORIES, VENUES } from '../policy/schema.js';
import type {
  ActionCategory,
  NormalizedAction,
  OrderType,
  ProposedAction,
  RiskContext,
  Side,
  Venue,
} from '../types.js';

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

/** Assets treated as 1 USD for sizing. Conservative: unknown assets need a mark. */
const USD_PEGGED = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'USD']);

const ORDER_TYPES: readonly OrderType[] = [
  'MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP_LOSS_LIMIT', 'OCO',
];

/** Categories that can never increase risk, so they need no sizing. */
const ZERO_NOTIONAL_CATEGORIES = new Set<ActionCategory>(['read', 'cancel']);

function requireFinitePositive(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new NormalizationError(`"${field}" must be a number, received ${JSON.stringify(value)}`);
  }
  if (!Number.isFinite(value)) {
    throw new NormalizationError(`"${field}" must be a finite number, received ${value}`);
  }
  if (value <= 0) {
    throw new NormalizationError(`"${field}" must be greater than 0, received ${value}`);
  }
  return value;
}

function optionalFinitePositive(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return requireFinitePositive(value, field);
}

function stableId(action: ProposedAction, now: number): string {
  // Deterministic content hash so the same proposal at the same instant produces
  // the same id — that is what makes the duplicate guard meaningful.
  const canonical = JSON.stringify({
    c: action.category,
    v: action.venue,
    s: action.symbol ?? null,
    a: action.asset ?? null,
    side: action.side ?? null,
    t: action.orderType ?? null,
    q: action.quantity ?? null,
    p: action.price ?? null,
    qq: action.quoteQuantity ?? null,
    l: action.leverage ?? null,
    d: action.destination ?? null,
    now,
  });
  return `auto-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

function resolveMark(ctx: RiskContext, key: string): number | null {
  const direct = ctx.marks[key];
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  return null;
}

/** Venues that price in base quantity and cannot accept a quote-sized order. */
const QUANTITY_ONLY_VENUES = new Set<Venue>(['futures-usds', 'futures-coin', 'margin']);

/**
 * Resolve the base-asset quantity that will actually be sent.
 *
 * This fixes the worst defect found in v2.0.0: the engine judged
 * `quoteQuantity: 100` as a $100 order while the adapter computed
 * `quantity = notionalUsd / (price ?? 1)` — sending **100 BTC**, a 100,000x
 * amplification, with every policy check having passed cleanly.
 *
 * The rule is now absolute: **whatever the engine judged is what gets sent.**
 * Derivatives quantities are resolved here, before any rule runs, and the
 * adapter is forbidden from re-deriving them. If a quantity cannot be resolved
 * from a trustworthy price, normalization fails and the engine denies.
 */
function resolveExecutionQuantity(
  venue: Venue,
  category: ActionCategory,
  symbol: string | null,
  quantity: number | null,
  price: number | null,
  notionalUsd: number,
  ctx: RiskContext,
): number | null {
  if (category !== 'trade') return null;
  if (quantity !== null) return quantity;
  if (!QUANTITY_ONLY_VENUES.has(venue)) return null; // spot can size in quote terms
  if (notionalUsd <= 0) return null;

  const reference = price ?? (symbol !== null ? resolveMark(ctx, symbol) : null);
  if (reference === null || reference <= 0) {
    throw new NormalizationError(
      `cannot resolve an execution quantity for a ${venue} order on ${symbol ?? 'an unknown symbol'}: ` +
      'no limit price and no reference mark. Aegis refuses to send a quantity it did not judge — ' +
      'supply an explicit `quantity`, or a `price`, or seed ctx.marks.',
    );
  }

  const qty = notionalUsd / reference;
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new NormalizationError(`resolved a non-finite execution quantity for ${symbol ?? venue}`);
  }
  // 8 dp sits below the step size of every Binance perpetual; anything that
  // still violates stepSize is rejected by the venue, which fails closed.
  return Math.round(qty * 1e8) / 1e8;
}

/** Convert a ProposedAction into the canonical form every rule consumes. */
export function normalizeAction(proposal: ProposedAction, ctx: RiskContext): NormalizedAction {
  if (proposal === null || typeof proposal !== 'object') {
    throw new NormalizationError('action must be an object');
  }

  const category = proposal.category;
  if (!category || !ACTION_CATEGORIES.includes(category)) {
    throw new NormalizationError(
      `invalid action category ${JSON.stringify(category)}. Valid: ${ACTION_CATEGORIES.join(', ')}`,
    );
  }

  const venue = proposal.venue;
  if (!venue || !VENUES.includes(venue)) {
    throw new NormalizationError(`invalid venue ${JSON.stringify(venue)}. Valid: ${VENUES.join(', ')}`);
  }

  const symbol = typeof proposal.symbol === 'string' && proposal.symbol.trim() !== ''
    ? proposal.symbol.trim().toUpperCase()
    : null;
  const asset = typeof proposal.asset === 'string' && proposal.asset.trim() !== ''
    ? proposal.asset.trim().toUpperCase()
    : null;

  let side: Side | null = null;
  if (proposal.side !== undefined && proposal.side !== null) {
    const upper = String(proposal.side).trim().toUpperCase();
    if (upper !== 'BUY' && upper !== 'SELL') {
      throw new NormalizationError(`invalid side ${JSON.stringify(proposal.side)}. Valid: BUY, SELL`);
    }
    side = upper;
  }

  let orderType: OrderType | null = null;
  if (proposal.orderType !== undefined && proposal.orderType !== null) {
    const upper = String(proposal.orderType).trim().toUpperCase() as OrderType;
    if (!ORDER_TYPES.includes(upper)) {
      throw new NormalizationError(`invalid orderType ${JSON.stringify(proposal.orderType)}. Valid: ${ORDER_TYPES.join(', ')}`);
    }
    orderType = upper;
  }

  const quantity = optionalFinitePositive(proposal.quantity, 'quantity');
  const price = optionalFinitePositive(proposal.price, 'price');
  const quoteQuantity = optionalFinitePositive(proposal.quoteQuantity, 'quoteQuantity');
  const leverage = optionalFinitePositive(proposal.leverage, 'leverage');
  const stopPrice = optionalFinitePositive(proposal.stopPrice, 'stopPrice');

  let notionalUsd = 0;
  let notionalBasis: NormalizedAction['notionalBasis'] = 'none';

  if (!ZERO_NOTIONAL_CATEGORIES.has(category)) {
    if (quoteQuantity !== null) {
      notionalUsd = quoteQuantity;
      notionalBasis = 'quote-quantity';
    } else if (quantity !== null && price !== null) {
      notionalUsd = quantity * price;
      notionalBasis = 'quantity-x-price';
    } else if (quantity !== null && asset !== null && (category === 'transfer' || category === 'onchain' || category === 'withdraw')) {
      if (USD_PEGGED.has(asset)) {
        notionalUsd = quantity;
      } else {
        const mark = resolveMark(ctx, asset) ?? resolveMark(ctx, `${asset}USDT`);
        if (mark === null) {
          throw new NormalizationError(
            `no reference price for asset "${asset}" — Aegis refuses to size an action it cannot value. ` +
            `Supply ctx.marks["${asset}"] or an explicit quoteQuantity.`,
          );
        }
        notionalUsd = quantity * mark;
      }
      notionalBasis = 'asset-amount';
    } else if (quantity !== null && symbol !== null) {
      const mark = resolveMark(ctx, symbol);
      if (mark === null) {
        throw new NormalizationError(
          `no reference price for symbol "${symbol}" — Aegis refuses to size an action it cannot value. ` +
          `Supply ctx.marks["${symbol}"] or an explicit price/quoteQuantity.`,
        );
      }
      notionalUsd = quantity * mark;
      notionalBasis = 'quantity-x-mark';
    } else {
      throw new NormalizationError(
        `cannot determine the size of this ${category} action: provide quoteQuantity, or quantity with a price, ` +
        `or quantity with a symbol/asset that has a reference price.`,
      );
    }
  }

  if (!Number.isFinite(notionalUsd)) {
    throw new NormalizationError('computed notional is not a finite number');
  }

  const id = typeof proposal.id === 'string' && proposal.id.trim() !== ''
    ? proposal.id.trim()
    : stableId(proposal, ctx.now);

  const roundedNotional = Math.round(notionalUsd * 1e8) / 1e8;
  const executionQuantity = resolveExecutionQuantity(
    venue as Venue, category, symbol, quantity, price, roundedNotional, ctx,
  );

  return {
    id,
    ts: ctx.now,
    category,
    venue: venue as Venue,
    symbol,
    asset,
    side,
    orderType,
    quantity,
    price,
    leverage,
    reduceOnly: proposal.reduceOnly === true,
    closePosition: proposal.closePosition === true,
    hasStopLoss: proposal.hasStopLoss === true || stopPrice !== null,
    stopPrice,
    executionQuantity,
    destination: typeof proposal.destination === 'string' ? proposal.destination : null,
    notionalUsd: roundedNotional,
    notionalBasis,
    raw: proposal,
  };
}

/**
 * Risk direction classification.
 *
 * v1.0.0 asked a simpler question — `isRiskReducing(action)` — and got it wrong
 * in two ways that an adversarial review reproduced:
 *
 *  1. `STOP_MARKET` / `TAKE_PROFIT_MARKET` were treated as risk-reducing purely
 *     by order type. But a stop-ENTRY opens risk. That made the order type a
 *     skeleton key: submitting a new position as `STOP_MARKET` bypassed the
 *     daily-loss breaker, the cooldown and the stop-loss requirement.
 *  2. A `reduceOnly: true` claim was trusted unconditionally, so an agent could
 *     unlock every size limit just by asserting a flag.
 *
 * The fix is to treat the agent's claim as *evidence* and check it against the
 * positions Aegis actually knows about. Binance enforces `reduceOnly`
 * server-side too, but a risk firewall should not outsource its own invariants
 * to the thing it is guarding.
 */
export interface RiskDirection {
  /** True when the action can only shrink existing exposure. */
  reducing: boolean;
  /** True when the claim was checked against a real, opposing position. */
  verified: boolean;
  /** Notional of the matching position, when one is known. */
  positionNotionalUsd: number | null;
  /** Human-readable justification, surfaced in findings. */
  reason: string;
}

/** Order types that only reduce risk when tied to an existing position. */
const PROTECTIVE_TYPES = new Set<OrderType>(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);

/**
 * Classify whether an action reduces or increases risk.
 *
 * Fails closed: anything it cannot positively confirm as a reduction is treated
 * as risk-increasing, so the full limit set applies.
 */
export function classifyRisk(action: NormalizedAction, ctx: RiskContext): RiskDirection {
  if (action.category === 'read') {
    return { reducing: true, verified: true, positionNotionalUsd: null, reason: 'read-only action' };
  }
  if (action.category === 'cancel') {
    return {
      reducing: true,
      verified: true,
      positionNotionalUsd: null,
      reason: 'cancelling an order can only remove exposure',
    };
  }

  const claimsReduction = action.reduceOnly || action.closePosition;
  if (!claimsReduction) {
    const note = action.orderType && PROTECTIVE_TYPES.has(action.orderType)
      ? `${action.orderType} without reduceOnly/closePosition opens a new position`
      : 'action increases or establishes exposure';
    return { reducing: false, verified: true, positionNotionalUsd: null, reason: note };
  }

  if (action.symbol === null) {
    return {
      reducing: false,
      verified: false,
      positionNotionalUsd: null,
      reason: 'reduction claimed but no symbol was supplied, so it cannot be matched to a position',
    };
  }

  const position = ctx.positions.find((p) => p.symbol === action.symbol && p.quantity !== 0);
  if (!position) {
    return {
      reducing: false,
      verified: false,
      positionNotionalUsd: null,
      reason: `reduction claimed on ${action.symbol} but Aegis knows of no open position there`,
    };
  }

  // Reducing a long means selling; reducing a short means buying.
  const positionIsLong = position.quantity > 0;
  if (action.side !== null) {
    const sideReduces = positionIsLong ? action.side === 'SELL' : action.side === 'BUY';
    if (!sideReduces) {
      return {
        reducing: false,
        verified: false,
        positionNotionalUsd: Math.abs(position.notionalUsd),
        reason: `${action.side} cannot reduce a ${positionIsLong ? 'long' : 'short'} ${action.symbol} position`,
      };
    }
  }

  const positionNotional = Math.abs(position.notionalUsd);
  const round2 = (n: number): number => Math.round(n * 100) / 100;

  // closePosition flattens whatever is there, so size cannot overshoot.
  if (action.closePosition) {
    return {
      reducing: true,
      verified: true,
      positionNotionalUsd: positionNotional,
      reason: `closes the open ${action.symbol} position of $${round2(positionNotional)}`,
    };
  }

  // A reduceOnly order larger than the position is not purely a reduction.
  // 1% tolerance absorbs mark drift between the snapshot and submission.
  if (action.notionalUsd > positionNotional * 1.01) {
    return {
      reducing: false,
      verified: false,
      positionNotionalUsd: positionNotional,
      reason:
        `reduceOnly size $${round2(action.notionalUsd)} exceeds the known ` +
        `${action.symbol} position of $${round2(positionNotional)}`,
    };
  }

  return {
    reducing: true,
    verified: true,
    positionNotionalUsd: positionNotional,
    reason: `reduces the open ${action.symbol} position of $${round2(positionNotional)}`,
  };
}

/** Convenience boolean over {@link classifyRisk}. */
export function isRiskReducing(action: NormalizedAction, ctx: RiskContext): boolean {
  return classifyRisk(action, ctx).reducing;
}
