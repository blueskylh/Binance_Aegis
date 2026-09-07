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
    hasStopLoss: proposal.hasStopLoss === true,
    destination: typeof proposal.destination === 'string' ? proposal.destination : null,
    notionalUsd: Math.round(notionalUsd * 1e8) / 1e8,
    notionalBasis,
    raw: proposal,
  };
}

/** True when an action can only reduce exposure (cancels, reduce-only closes). */
export function isRiskReducing(action: NormalizedAction): boolean {
  if (action.category === 'read' || action.category === 'cancel') return true;
  if (action.reduceOnly) return true;
  if (action.orderType === 'STOP_MARKET' || action.orderType === 'TAKE_PROFIT_MARKET') return true;
  return false;
}
