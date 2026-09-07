/**
 * Aegis — core domain types.
 *
 * Everything the policy engine reasons about is expressed here. The engine is a
 * pure function of (Policy, NormalizedAction, RiskContext) -> Decision, which is
 * what makes it deterministic, replayable and exhaustively testable.
 */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Broad capability class of an action. Used for coarse allow/deny gating. */
export type ActionCategory =
  | 'read'      // market data, balances — never moves funds
  | 'trade'     // spot / margin / futures order placement
  | 'cancel'    // order cancellation — always risk-reducing
  | 'transfer'  // moving funds between wallets inside the agentic sub-account
  | 'onchain'   // Agentic Wallet swaps / sends / DeFi
  | 'withdraw'; // external withdrawal — Binance Agent OS never grants this

/** Execution venue. Mirrors Binance Agent OS surfaces. */
export type Venue =
  | 'spot'
  | 'margin'
  | 'futures-usds'
  | 'futures-coin'
  | 'convert'
  | 'wallet'
  | 'market-data';

export type Side = 'BUY' | 'SELL';

export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT_MARKET'
  | 'STOP_LOSS_LIMIT'
  | 'OCO';

/**
 * The raw action an agent proposes, in a shape close to what it would send to
 * `binance-cli` / the Binance MCP server.
 */
export interface ProposedAction {
  /** Stable id supplied by the caller; used for idempotency. Auto-generated when absent. */
  id?: string;
  category: ActionCategory;
  venue: Venue;
  /** e.g. "BTCUSDT". Absent for pure transfers. */
  symbol?: string;
  /** e.g. "USDT". Used by transfers / on-chain sends. */
  asset?: string;
  side?: Side;
  orderType?: OrderType;
  /** Base-asset quantity. */
  quantity?: number;
  /** Limit price, when applicable. */
  price?: number;
  /** Quote-asset notional, when the agent sizes in quote terms (quoteOrderQty). */
  quoteQuantity?: number;
  /** Requested leverage for derivatives. */
  leverage?: number;
  /** True when the order can only reduce an existing position. */
  reduceOnly?: boolean;
  /** True when the agent attached a protective stop to this entry. */
  hasStopLoss?: boolean;
  /** Destination wallet / address label for transfers. */
  destination?: string;
  /** Free-form passthrough retained in the audit ledger. */
  meta?: Record<string, unknown>;
}

/** Canonical, engine-ready form of a ProposedAction. */
export interface NormalizedAction {
  id: string;
  ts: number;
  category: ActionCategory;
  venue: Venue;
  symbol: string | null;
  asset: string | null;
  side: Side | null;
  orderType: OrderType | null;
  quantity: number | null;
  price: number | null;
  leverage: number | null;
  reduceOnly: boolean;
  hasStopLoss: boolean;
  destination: string | null;
  /** USD notional the engine sizes limits against. 0 for non-value actions. */
  notionalUsd: number;
  /** How notionalUsd was derived — surfaced in explanations. */
  notionalBasis: 'quote-quantity' | 'quantity-x-price' | 'quantity-x-mark' | 'asset-amount' | 'none';
  raw: ProposedAction;
}

// ---------------------------------------------------------------------------
// Risk context
// ---------------------------------------------------------------------------

export interface PositionSnapshot {
  symbol: string;
  /** Signed base quantity: positive = long, negative = short. */
  quantity: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  leverage: number;
  unrealizedPnlUsd: number;
}

/** Rolling counters the engine consults for window-based limits. */
export interface RollingCounters {
  /** Sum of |notionalUsd| for trades executed in the current UTC day. */
  dailyNotionalUsd: number;
  /** Realized PnL in USD for the current UTC day (negative = loss). */
  dailyRealizedPnlUsd: number;
  /** Executed order count in the trailing 60 seconds. */
  ordersLastMinute: number;
  /** Executed order count in the trailing 60 minutes. */
  ordersLastHour: number;
  /** Epoch ms of the most recent realized loss, or null. */
  lastLossAt: number | null;
  /** Highest account equity ever observed, for drawdown maths. */
  peakEquityUsd: number;
}

export interface RiskContext {
  /** Evaluation timestamp (epoch ms). Injected so tests are deterministic. */
  now: number;
  /** Total account equity in USD across the agentic sub-account. */
  equityUsd: number;
  /** Open positions, keyed access done by the engine. */
  positions: PositionSnapshot[];
  /** Reference prices used for fat-finger and notional maths. */
  marks: Record<string, number>;
  counters: RollingCounters;
  /** Action ids already seen — powers the duplicate/replay guard. */
  recentActionIds: string[];
  /** Operator-triggered global halt. Overrides everything. */
  killSwitch: boolean;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type PolicyMode = 'enforce' | 'monitor' | 'simulate';

export interface PolicyLimits {
  maxNotionalUsdPerOrder: number | null;
  maxDailyNotionalUsd: number | null;
  maxOpenNotionalUsd: number | null;
  maxLeverage: number | null;
  maxDailyLossUsd: number | null;
  maxDrawdownPct: number | null;
  maxOrdersPerMinute: number | null;
  maxOrdersPerHour: number | null;
  maxPositionsOpen: number | null;
}

export interface PolicyAccess {
  categories: ActionCategory[] | null;
  venues: Venue[] | null;
  symbols: string[] | null;
}

export interface PolicyGuards {
  /** Reject orders whose limit price deviates from mark by more than this %. */
  priceDeviationPct: number | null;
  /** Block all risk-increasing actions below this equity floor. */
  minAccountEquityUsd: number | null;
  /** Require a protective stop on risk-increasing derivatives entries. */
  requireStopLoss: boolean;
  /** UTC trading window, "HH:MM" inclusive start / exclusive end. */
  tradingHoursUtc: { from: string; to: string } | null;
  /** Refuse new risk for N seconds after a realized loss. */
  cooldownSecondsAfterLoss: number | null;
  /** Notional above which a human must confirm (decision = "review"). */
  reviewAboveNotionalUsd: number | null;
  /** Block replays of an action id already seen. */
  blockDuplicateActionIds: boolean;
}

export interface Policy {
  version: 1;
  name: string;
  mode: PolicyMode;
  /** Verdict for actions no allow-rule matched. Deny-by-default is the safe posture. */
  default: 'allow' | 'deny';
  limits: PolicyLimits;
  allow: PolicyAccess;
  deny: PolicyAccess;
  guards: PolicyGuards;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type Verdict = 'allow' | 'review' | 'deny';

export type Severity = 'info' | 'warn' | 'critical';

export interface Finding {
  ruleId: string;
  verdict: Verdict;
  severity: Severity;
  message: string;
  /** Machine-readable evidence so downstream agents can reason, not just read prose. */
  observed?: number | string | null;
  limit?: number | string | null;
}

export interface Decision {
  /** Final verdict after aggregating every finding and applying policy mode. */
  verdict: Verdict;
  /** Verdict before policy-mode softening. Equal to `verdict` in enforce mode. */
  rawVerdict: Verdict;
  action: NormalizedAction;
  findings: Finding[];
  policy: { name: string; mode: PolicyMode; version: 1 };
  /** One-line human summary, ready for an agent to relay to its operator. */
  summary: string;
  evaluatedAt: number;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEventType = 'decision' | 'execution' | 'breaker' | 'note';

export interface LedgerEntry {
  seq: number;
  ts: number;
  type: LedgerEventType;
  /** SHA-256 over (prevHash + canonical JSON of this entry's payload block). */
  hash: string;
  prevHash: string;
  payload: Record<string, unknown>;
}

/** A rule is a pure function. No I/O, no clock access, no randomness. */
export type Rule = (
  action: NormalizedAction,
  policy: Policy,
  ctx: RiskContext,
) => Finding[];
