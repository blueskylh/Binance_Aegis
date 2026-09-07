/**
 * What the gateway can actually execute.
 *
 * The type system describes seven venues and six action categories because the
 * *policy engine* reasons about all of them. The *executor* implements far less.
 *
 * v2.0.0 conflated the two, and the adapter closed the gap with
 *
 *     const venue = action.venue === 'futures-usds' ? 'futures-usds' : 'spot';
 *
 * which silently rerouted a margin, COIN-M, convert or wallet order to the spot
 * endpoint. Executing a different instrument from the one that was authorised is
 * exactly the failure this project exists to prevent.
 *
 * So capability is now an explicit allowlist, checked before dispatch. Anything
 * not on it is denied with `unsupported-execution-capability`. For a security
 * product, "we do less than we could" is a feature — and a narrow, honest
 * surface is worth more than a broad, wrong one.
 */

import type { ActionCategory, Venue } from '../types.js';

export interface Capability {
  category: ActionCategory;
  venue: Venue;
  note: string;
}

/** Everything the gateway is able to send. Nothing else executes. */
export const GATEWAY_CAPABILITIES: readonly Capability[] = Object.freeze([
  { category: 'trade', venue: 'spot', note: 'spot new-order' },
  { category: 'trade', venue: 'futures-usds', note: 'USD-M futures new-order' },
  { category: 'cancel', venue: 'spot', note: 'spot delete-open-orders' },
  { category: 'cancel', venue: 'futures-usds', note: 'USD-M futures cancel-all-open-orders' },
  { category: 'read', venue: 'market-data', note: 'public market data' },
  { category: 'read', venue: 'spot', note: 'spot account reads' },
  { category: 'read', venue: 'futures-usds', note: 'USD-M account reads' },
]);

export function isExecutable(category: ActionCategory, venue: Venue): boolean {
  return GATEWAY_CAPABILITIES.some((c) => c.category === category && c.venue === venue);
}

/** Human-readable summary for denial messages and `aegis capabilities`. */
export function describeCapabilities(): string {
  return GATEWAY_CAPABILITIES.map((c) => `${c.category}:${c.venue}`).join(', ');
}
