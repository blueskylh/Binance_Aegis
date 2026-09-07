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

/** Venues that price in base quantity and cannot accept a quote-sized order. */
const QUANTITY_ONLY_VENUES = new Set<Venue>(['futures-usds', 'futures-coin', 'margin']);

const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

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
      throw new NormalizationError(
        `invalid orderType ${JSON.stringify(proposal.orderType)}. Valid: ${ORDER_TYPES.join(', ')}`,
      );
    }
    orderType = upper;
  }

  const quantity = optionalFinitePositive(proposal.quantity, 'quantity');
  const price = optionalFinitePositive(proposal.price, 'price');
  const quoteQuantity = optionalFinitePositive(proposal.quoteQuantity, 'quoteQuantity');
  const leverage = optionalFinitePositive(proposal.leverage, 'leverage');
  const stopPrice = optionalFinitePositive(proposal.stopPrice, 'stopPrice');

  // ---------------------------------------------------------------------------
  // Canonical sizing
  //
  // GW-08/09/10. The v2.1 fix for GW-02 stopped the adapter re-deriving a
  // quantity, but left the *action* free to describe its size more than once.
  // Three live bypasses followed, each 100,000x:
  //
  //   { quoteQuantity: 100, quantity: 100 } → judged $100, would send 100 BTC
  //   { quantity: 1, price: 1, MARKET }     → judged $1,   would send 1 BTC
  //   the same conflict on spot             → judged $100, would send 100 BTC
  //
  // The answer is not smarter precedence, because precedence still leaves two
  // descriptions in play and some layer will believe the wrong one. Ambiguity is
  // refused outright, one reference price is chosen explicitly, and the result is
  // asserted self-consistent before it can leave this function.
  // ---------------------------------------------------------------------------

  let notionalUsd = 0;
  let notionalBasis: NormalizedAction['notionalBasis'] = 'none';
  let sizingReference: number | null = null;
  let executionQuantity: number | null = null;

  if (!ZERO_NOTIONAL_CATEGORIES.has(category)) {
    if (quantity !== null && quoteQuantity !== null) {
      throw new NormalizationError(
        'an action must state its size exactly once: `quantity` and `quoteQuantity` were both supplied. ' +
        'Aegis refuses to guess which one the venue will honour — send one or the other.',
      );
    }

    if (category === 'transfer' || category === 'onchain' || category === 'withdraw') {
      // Asset movements are sized by asset amount, not by an order book.
      if (quoteQuantity !== null) {
        notionalUsd = quoteQuantity;
        notionalBasis = 'quote-quantity';
      } else if (quantity !== null && asset !== null) {
        if (USD_PEGGED.has(asset)) {
          notionalUsd = quantity;
          sizingReference = 1;
        } else {
          const mark = resolveMark(ctx, asset) ?? resolveMark(ctx, `${asset}USDT`);
          if (mark === null) {
            throw new NormalizationError(
              `no reference price for asset "${asset}" — Aegis refuses to size an action it cannot value. ` +
              `Supply ctx.marks["${asset}"] or an explicit quoteQuantity.`,
            );
          }
          notionalUsd = quantity * mark;
          sizingReference = mark;
        }
        notionalBasis = 'asset-amount';
      } else {
        throw new NormalizationError(
          `cannot determine the size of this ${category} action: provide quoteQuantity, ` +
          'or quantity with an asset that has a reference price.',
        );
      }
    } else {
      // Orders. Exactly one reference price, chosen by order type:
      //   LIMIT  → the limit price, which is what will actually transact.
      //   MARKET → the mark. A caller-supplied `price` on a MARKET order means
      //            nothing to the venue, so believing it would let an agent
      //            declare a $1 notional and receive a $100,000 fill.
      const isLimit = orderType === 'LIMIT' || orderType === 'STOP_LOSS_LIMIT';
      const mark = symbol !== null ? resolveMark(ctx, symbol) : null;
      const reference = isLimit ? price : mark;

      // A reference is only demanded when a conversion actually needs one. A spot
      // quote-sized order needs none: the notional IS the quote amount, and the
      // venue accepts `quoteOrderQty` directly.
      const needsReference =
        quantity !== null || (quoteQuantity !== null && QUANTITY_ONLY_VENUES.has(venue as Venue));

      if (needsReference && (reference === null || reference <= 0)) {
        throw new NormalizationError(
          isLimit
            ? 'a LIMIT order must carry a positive `price`.'
            : `no reference mark for "${symbol ?? 'an unknown symbol'}" — Aegis will not size an order ` +
              'it cannot value. Seed ctx.marks or run `aegis sync`.',
        );
      }
      sizingReference = reference;

      if (quoteQuantity !== null) {
        notionalUsd = quoteQuantity;
        notionalBasis = 'quote-quantity';
        // Derivatives cannot be sized in quote terms on the wire, so resolve the
        // base quantity here — the engine judges what will actually be sent.
        if (QUANTITY_ONLY_VENUES.has(venue as Venue) && reference !== null) {
          executionQuantity = round8(quoteQuantity / reference);
        }
      } else if (quantity !== null && reference !== null) {
        notionalUsd = quantity * reference;
        notionalBasis = isLimit ? 'quantity-x-price' : 'quantity-x-mark';
        executionQuantity = quantity;
      } else {
        throw new NormalizationError(
          'cannot determine the size of this trade: provide `quoteQuantity`, or `quantity`.',
        );
      }
    }
  }

  notionalUsd = round8(notionalUsd);

  if (!Number.isFinite(notionalUsd)) {
    throw new NormalizationError('computed notional is not a finite number');
  }

  // Post-condition. Anything that reaches the venue as a base quantity must
  // multiply back to the notional the rules judged. This is the invariant GW-02
  // and GW-08 both violated; asserting it here means a future refactor cannot
  // reintroduce the class of bug, only fail loudly.
  if (executionQuantity !== null) {
    if (!Number.isFinite(executionQuantity) || executionQuantity <= 0) {
      throw new NormalizationError('resolved a non-positive execution quantity');
    }
    if (sizingReference !== null) {
      const implied = executionQuantity * sizingReference;
      const tolerance = Math.max(0.01, notionalUsd * 1e-6);
      if (Math.abs(implied - notionalUsd) > tolerance) {
        throw new NormalizationError(
          `internal sizing inconsistency: judged $${notionalUsd} but would send ${executionQuantity} ` +
          `at ${sizingReference} = $${implied}. Refusing to proceed.`,
        );
      }
    }
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
    closePosition: proposal.closePosition === true,
    hasStopLoss: proposal.hasStopLoss === true || stopPrice !== null,
    stopPrice,
    executionQuantity,
    sizingReference,
    destination: typeof proposal.destination === 'string' ? proposal.destination : null,
    notionalUsd,
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
  reducing: boolean;
  verified: boolean;
  positionNotionalUsd: number | null;
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
