/**
 * What the gateway can actually execute.
 *
 * The type system describes seven venues and six action categories because the
 * *policy engine* reasons about all of them. The *executor* implements far less.
 *
 * v2.0.0 conflated the two and the adapter closed the gap by rerouting anything
 * unrecognised to spot. v2.1.0 introduced this allowlist but overstated it:
 * `cancel` and `read` were listed, yet `dispatch()` only ever calls
 * `placeOrder()`, which requires a symbol and a side. A cancel would have passed
 * the capability check and then been submitted as an order.
 *
 * So the list now claims exactly what `placeOrder` implements, and nothing else.
 * For a security product a narrow honest surface beats a broad wrong one — and
 * the guardian still cancels orders directly through the adapter, which is a
 * risk-reducing path that never needs gateway authorisation.
 */

import type { ActionCategory, Venue } from '../types.js';

export interface Capability {
  category: ActionCategory;
  venue: Venue;
  note: string;
}

/** Everything `ExecutionGateway.dispatch` can actually send. Nothing else executes. */
export const GATEWAY_CAPABILITIES: readonly Capability[] = Object.freeze([
  { category: 'trade', venue: 'spot', note: 'binance-cli spot new-order' },
  { category: 'trade', venue: 'futures-usds', note: 'binance-cli futures-usds new-order' },
]);

export function isExecutable(category: ActionCategory, venue: Venue): boolean {
  return GATEWAY_CAPABILITIES.some((c) => c.category === category && c.venue === venue);
}

/** Human-readable summary for denial messages and `aegis capabilities`. */
export function describeCapabilities(): string {
  return GATEWAY_CAPABILITIES.map((c) => `${c.category}:${c.venue}`).join(', ');
}

/**
 * Order types whose exposure can be settled inside one request/response.
 *
 * GW-11. A resting LIMIT entry returns `NEW` with nothing filled, the gateway
 * hands control back, and when it fills minutes later there is no code present
 * to record the notional, update positions, or attach the protective stop the
 * policy demanded. Aegis would believe the account is flat while it is levered.
 *
 * Rather than build an order-lifecycle daemon days before a deadline — and ship
 * the bugs that come with one — leveraged *entries* are restricted to order
 * types that reconcile synchronously. Exits are never restricted, and spot
 * carries no liquidation risk, so both are exempt.
 */
export const SYNCHRONOUSLY_RECONCILABLE = new Set(['MARKET']);

/** Venues where an unreconciled resting entry could be liquidated. */
export const LEVERAGED_VENUES = new Set<Venue>(['futures-usds', 'futures-coin', 'margin']);
