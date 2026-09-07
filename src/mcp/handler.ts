/**
 * MCP request handler — pure request → response, no transport concerns.
 *
 * Splitting the protocol logic from stdio is what makes the server testable
 * without spawning a process, and it is why every branch below is covered.
 *
 * Aegis speaks MCP because that is how it slots into Binance Agent OS: the agent
 * keeps the Binance MCP server for execution and adds Aegis as a second server
 * for authorization. Two servers, one rule — nothing reaches Binance until
 * `aegis_guard_action` says `allow`.
 */

import { VERSION } from '../version.js';
import { GATEWAY_CAPABILITIES } from '../gateway/capabilities.js';
import type { Aegis } from '../aegis.js';
import type { ExecutionGateway } from '../gateway/executor.js';
import type { ProposedAction } from '../types.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'aegis';
export const SERVER_VERSION = VERSION;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const ACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable id for this proposal. Reused ids are rejected as replays.' },
    category: {
      type: 'string',
      enum: ['read', 'trade', 'cancel', 'transfer', 'onchain', 'withdraw'],
      description: 'Capability class of the action.',
    },
    venue: {
      type: 'string',
      enum: ['spot', 'margin', 'futures-usds', 'futures-coin', 'convert', 'wallet', 'market-data'],
      description: 'Where the action executes.',
    },
    symbol: { type: 'string', description: 'Trading pair, e.g. BTCUSDT.' },
    asset: { type: 'string', description: 'Asset ticker for transfers, e.g. USDT.' },
    side: { type: 'string', enum: ['BUY', 'SELL'] },
    orderType: { type: 'string', enum: ['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP_LOSS_LIMIT', 'OCO'] },
    quantity: { type: 'number', description: 'Base-asset quantity.' },
    price: { type: 'number', description: 'Limit price, when applicable.' },
    stopPrice: { type: 'number', description: 'Protective stop trigger price. Validated, and actually placed in gateway mode.' },
    quoteQuantity: { type: 'number', description: 'Quote-asset notional (quoteOrderQty).' },
    leverage: { type: 'number' },
    reduceOnly: { type: 'boolean', description: 'True when the order can only reduce an existing position. Verified against real positions.' },
    closePosition: { type: 'boolean', description: 'True when the order closes the entire position.' },
    hasStopLoss: { type: 'boolean', description: 'True when a protective stop is attached to this entry.' },
    destination: { type: 'string', description: 'Destination wallet for transfers.' },
  },
  required: ['category', 'venue'],
  additionalProperties: true,
};

export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'aegis_execute',
    description:
      'GATEWAY MODE — the ONLY way to reach Binance. Evaluates the action against policy and, if allowed, ' +
      'places it through Binance Agent OS itself, then settles the risk counters from the REAL fill. ' +
      'Returns status "executed" (done), "pending-approval" (a human must approve; NOTHING was sent), ' +
      '"blocked" (policy refused; NOTHING was sent) or "failed". Prefer this over aegis_guard_action: ' +
      'with it, no Binance write can bypass the firewall.',
    inputSchema: ACTION_SCHEMA,
  },
  {
    name: 'aegis_pending_approvals',
    description:
      'List actions parked awaiting human approval. Show these to the user when they ask what is waiting on them.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aegis_approve',
    description:
      'Redeem a parked approval ticket and execute it. ONLY call this after the human has explicitly said yes to ' +
      'that specific ticket. The action is re-evaluated at redemption, so a policy change or kill-switch since ' +
      'parking still wins. Tickets are single-use.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'The ticket id returned by aegis_execute.' },
        approver: { type: 'string', description: 'Who approved it — recorded in the ledger.' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
  },
  {
    name: 'aegis_reject',
    description: 'Discard a parked approval ticket without executing it. Use when the human declines.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
  },
  {
    name: 'aegis_guard_action',
    description:
      'ADVISORY MODE pre-flight check. Use only when the agent executes through a separate Binance tool. ' +
      'Returns verdict "allow" (proceed), "review" (stop and ask the human to confirm) or ' +
      '"deny" (do not proceed; relay the reason). Every call is written to a tamper-evident audit ledger. ' +
      'Note: this cannot enforce anything on its own — prefer aegis_execute.',
    inputSchema: ACTION_SCHEMA,
  },
  {
    name: 'aegis_record_execution',
    description:
      'Call immediately AFTER a Binance action actually executes, with the real filled notional and realized PnL. ' +
      'This is what advances the daily budget, loss and rate-limit counters — skip it and the limits go blind.',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'The id returned by aegis_guard_action.' },
        category: { type: 'string' },
        venue: { type: 'string' },
        symbol: { type: 'string' },
        notionalUsd: { type: 'number', description: 'Actual filled notional in USD.' },
        realizedPnlUsd: { type: 'number', description: 'Realized PnL in USD; negative for a loss.' },
      },
      required: ['actionId', 'notionalUsd'],
      additionalProperties: true,
    },
  },
  {
    name: 'aegis_status',
    description:
      'Current risk posture: equity, drawdown, open exposure, budget consumption, kill-switch state and ledger head. ' +
      'Call this when the user asks "how much room do I have left" or before planning a series of trades.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aegis_explain_policy',
    description:
      'Return the active policy — limits, allowlists, guards — plus the list of rules being enforced. ' +
      'Use it to explain to the user why something was blocked, or what would need to change to permit it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aegis_capabilities',
    description:
      'What the gateway can actually execute. Anything absent is denied rather than rerouted. Check this before ' +
      'promising the user a venue is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aegis_verify_ledger',
    description:
      'Cryptographically verify the audit ledger. Returns ok=false with the exact sequence number if any entry ' +
      'was modified, deleted or reordered.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aegis_recent_decisions',
    description: 'Return the most recent guard decisions from the ledger, for review or incident analysis.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many entries to return (default 10, max 200).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'aegis_emergency_stop',
    description:
      'Engage the kill-switch: halts every risk-increasing action immediately. Reads and cancels still work so ' +
      'positions can always be closed. Use when the user says stop, halt, panic, or something looks wrong.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why the halt was triggered.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'aegis_resume',
    description:
      'Disengage the kill-switch. Only call this when the human explicitly asks to resume — never on the ' +
      "agent's own initiative.",
    inputSchema: {
      type: 'object',
      properties: { resetPeak: { type: 'boolean', description: 'Also re-baseline the drawdown breaker.' } },
      additionalProperties: false,
    },
  },
]);

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textResult(payload: unknown, isError = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
  if (isError) body['isError'] = true;
  return body;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build a handler bound to an Aegis instance. Never throws.
 *
 * Async because gateway execution reaches the venue; advisory tools resolve
 * immediately. Returning a Promise uniformly keeps the transport simple.
 */
export function createHandler(
  aegis: Aegis,
  gateway?: ExecutionGateway,
): (req: unknown) => Promise<JsonRpcResponse | null> {
  async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (name) {
      case 'aegis_execute': {
        if (!gateway) {
          return textResult({
            error: 'gateway mode is not enabled on this server',
            hint: 'Start with `aegis mcp --gateway`, or use aegis_guard_action in advisory mode.',
          }, true);
        }
        const outcome = await gateway.execute(args as unknown as ProposedAction);
        return textResult({
          status: outcome.status,
          verdict: outcome.verdict,
          summary: outcome.summary,
          ticketId: outcome.ticketId,
          findings: outcome.decision.findings,
          fill: outcome.fill,
          error: outcome.error,
          ledgerSeq: outcome.decision.ledgerSeq,
        });
      }

      case 'aegis_pending_approvals':
        if (!gateway) return textResult({ pending: [], note: 'gateway mode is not enabled' });
        return textResult({ pending: gateway.listPending() });

      case 'aegis_approve': {
        if (!gateway) return textResult({ error: 'gateway mode is not enabled on this server' }, true);
        const ticketId = String(args['ticketId'] ?? '');
        if (ticketId === '') return textResult({ error: 'ticketId is required' }, true);
        const outcome = await gateway.approve(ticketId, String(args['approver'] ?? 'human'));
        return textResult({
          status: outcome.status,
          verdict: outcome.verdict,
          summary: outcome.summary,
          ticketId: outcome.ticketId,
          fill: outcome.fill,
          protectiveStop: outcome.protectiveStop,
          error: outcome.error,
        });
      }

      case 'aegis_reject': {
        if (!gateway) return textResult({ error: 'gateway mode is not enabled on this server' }, true);
        const ticketId = String(args['ticketId'] ?? '');
        const existed = gateway.reject(ticketId, String(args['reason'] ?? 'declined by human'));
        return textResult({ rejected: existed, ticketId });
      }

      case 'aegis_capabilities':
        return textResult({ capabilities: GATEWAY_CAPABILITIES });

      case 'aegis_guard_action':
        return textResult(aegis.guard(args as unknown as ProposedAction));

      case 'aegis_record_execution': {
        const entry = aegis.recordExecution({
          actionId: String(args['actionId'] ?? 'unknown'),
          category: String(args['category'] ?? 'trade'),
          venue: String(args['venue'] ?? 'spot'),
          symbol: args['symbol'] === undefined ? null : String(args['symbol']),
          notionalUsd: Number(args['notionalUsd'] ?? 0),
          realizedPnlUsd: Number(args['realizedPnlUsd'] ?? 0),
        });
        return textResult({ recorded: true, ledgerSeq: entry.seq, ledgerHash: entry.hash });
      }

      case 'aegis_status':
        return textResult(aegis.status());

      case 'aegis_explain_policy':
        return textResult({
          name: aegis.policy.name,
          mode: aegis.policy.mode,
          default: aegis.policy.default,
          limits: aegis.policy.limits,
          allow: aegis.policy.allow,
          deny: aegis.policy.deny,
          guards: aegis.policy.guards,
          rules: aegis.rules(),
        });

      case 'aegis_verify_ledger':
        return textResult(aegis.verifyLedger());

      case 'aegis_recent_decisions': {
        const raw = Number(args['limit'] ?? 10);
        const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 10;
        const decisions = aegis.ledger.byType('decision').slice(-limit);
        return textResult({ count: decisions.length, decisions });
      }

      case 'aegis_emergency_stop': {
        const reason = String(args['reason'] ?? 'emergency stop requested');
        aegis.halt(reason);
        return textResult({ killSwitch: true, reason, note: 'Reads and cancels remain available so you can flatten.' });
      }

      case 'aegis_resume': {
        aegis.resume(args['resetPeak'] === true);
        return textResult({ killSwitch: false, resetPeak: args['resetPeak'] === true });
      }

      default:
        return textResult({ error: `unknown tool "${name}"`, available: TOOLS.map((t) => t.name) }, true);
    }
  }

  return async function handle(req: unknown): Promise<JsonRpcResponse | null> {
    const request = asObject(req) as JsonRpcRequest;
    const id = request.id ?? null;
    const method = typeof request.method === 'string' ? request.method : '';

    // Notifications carry no id and must never receive a response.
    if (method.startsWith('notifications/')) return null;
    if (method === '') return fail(id, -32600, 'invalid request: missing method');

    try {
      switch (method) {
        case 'initialize':
          return ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              'Aegis is the risk firewall for Binance Agent OS. In GATEWAY mode call aegis_execute for every ' +
              'order, transfer or exposure change — it is the only path to Binance and it settles the risk ' +
              'counters from the real fill. In ADVISORY mode call aegis_guard_action BEFORE the action and ' +
              'aegis_record_execution AFTER it fills. Treat "deny" as final and "review"/"pending-approval" ' +
              'as a hard stop pending human confirmation. Never call aegis_resume on your own initiative.',
          });

        case 'ping':
          return ok(id, {});

        case 'tools/list':
          return ok(id, { tools: TOOLS });

        case 'tools/call': {
          const params = asObject(request.params);
          const name = params['name'];
          if (typeof name !== 'string' || name === '') {
            return fail(id, -32602, 'invalid params: "name" is required');
          }
          return ok(id, await runTool(name, asObject(params['arguments'])));
        }

        case 'resources/list':
          return ok(id, { resources: [] });

        case 'prompts/list':
          return ok(id, { prompts: [] });

        default:
          return fail(id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      // A firewall that crashes is a firewall that gets bypassed. Surface the
      // fault as a protocol error and stay up.
      return fail(id, -32603, `internal error: ${(err as Error).message}`);
    }
  };
}
