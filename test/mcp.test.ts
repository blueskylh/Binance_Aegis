import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aegis } from '../src/aegis.js';
import { createHandler, PROTOCOL_VERSION, TOOLS } from '../src/mcp/handler.js';

const NOON = Date.UTC(2026, 8, 7, 12, 0, 0);
let dir: string;
let handler: ReturnType<typeof createHandler>;
let aegis: Aegis;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aegis-mcp-'));
  aegis = new Aegis({
    dataDir: dir,
    clock: () => NOON,
    policy: undefined,
    policyPath: undefined,
  });
  aegis.updateAccount({ equityUsd: 10_000, positions: [], marks: { BTCUSDT: 100_000, ETHUSDT: 4_000 } });
  handler = createHandler(aegis);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function call(method: string, params?: unknown, id: number | string = 1) {
  return handler({ jsonrpc: '2.0', id, method, params });
}

function toolCall(name: string, args: Record<string, unknown>) {
  const res = call('tools/call', { name, arguments: args });
  const content = (res?.result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]?.text ?? '{}');
}

describe('MCP — lifecycle', () => {
  test('initialize returns the protocol version and tool capability', () => {
    const res = call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
    const r = res?.result as Record<string, unknown>;
    assert.equal(r['protocolVersion'], PROTOCOL_VERSION);
    assert.ok((r['capabilities'] as Record<string, unknown>)['tools']);
    assert.equal((r['serverInfo'] as Record<string, string>)['name'], 'aegis');
  });

  test('notifications produce no response', () => {
    assert.equal(handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  test('ping is answered', () => {
    assert.deepEqual(call('ping')?.result, {});
  });

  test('an unknown method returns JSON-RPC error -32601', () => {
    const res = call('does/not/exist');
    assert.equal(res?.error?.code, -32601);
  });

  test('the response echoes the request id', () => {
    assert.equal(call('ping', undefined, 'abc')?.id, 'abc');
  });
});

describe('MCP — tools/list', () => {
  test('advertises every tool with a JSON schema', () => {
    const res = call('tools/list');
    const tools = (res?.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.equal(tools.length, TOOLS.length);
    for (const t of tools) {
      assert.ok(typeof t['name'] === 'string' && (t['name'] as string).length > 0);
      assert.ok(typeof t['description'] === 'string');
      assert.equal((t['inputSchema'] as Record<string, unknown>)['type'], 'object');
    }
  });

  test('exposes the guard tool an agent must call first', () => {
    const tools = (call('tools/list')?.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some((t) => t.name === 'aegis_guard_action'));
    assert.ok(tools.some((t) => t.name === 'aegis_status'));
    assert.ok(tools.some((t) => t.name === 'aegis_record_execution'));
    assert.ok(tools.some((t) => t.name === 'aegis_verify_ledger'));
    assert.ok(tools.some((t) => t.name === 'aegis_emergency_stop'));
  });
});

describe('MCP — aegis_guard_action', () => {
  test('allows a small compliant order', () => {
    const out = toolCall('aegis_guard_action', {
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 50,
    });
    assert.equal(out.verdict, 'allow');
    assert.ok(out.ledgerSeq >= 1);
  });

  test('denies an oversized order and explains why', () => {
    const out = toolCall('aegis_guard_action', {
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 5_000,
    });
    assert.equal(out.verdict, 'deny');
    assert.ok(out.findings.some((f: { ruleId: string }) => f.ruleId === 'max-notional-per-order'));
  });

  test('escalates a large-but-legal order to review', () => {
    const out = toolCall('aegis_guard_action', {
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300,
    });
    assert.equal(out.verdict, 'review');
  });

  test('a malformed argument object yields a deny, not a crash', () => {
    const out = toolCall('aegis_guard_action', { category: 'trade', venue: 'spot', symbol: 'BTCUSDT' });
    assert.equal(out.verdict, 'deny');
  });

  test('every guard call is written to the ledger', () => {
    const before = aegis.ledger.size();
    toolCall('aegis_guard_action', { category: 'read', venue: 'market-data' });
    assert.equal(aegis.ledger.size(), before + 1);
  });
});

describe('MCP — status, execution, ledger, stop', () => {
  test('status reports posture and budgets', () => {
    const out = toolCall('aegis_status', {});
    assert.equal(out.killSwitch, false);
    assert.equal(out.equityUsd, 10_000);
    assert.ok(out.budgets);
    assert.ok(out.rulesActive >= 20);
  });

  test('recording an execution moves the daily counters', () => {
    toolCall('aegis_record_execution', {
      actionId: 'x1', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', notionalUsd: 120, realizedPnlUsd: -5,
    });
    const out = toolCall('aegis_status', {});
    assert.equal(out.dailyNotionalUsd, 120);
    assert.equal(out.dailyRealizedPnlUsd, -5);
  });

  test('verify_ledger reports an intact chain', () => {
    toolCall('aegis_guard_action', { category: 'read', venue: 'market-data' });
    const out = toolCall('aegis_verify_ledger', {});
    assert.equal(out.ok, true);
    assert.equal(out.brokenAt, null);
  });

  test('emergency stop engages the kill switch and blocks the next trade', () => {
    const stop = toolCall('aegis_emergency_stop', { reason: 'demo halt' });
    assert.equal(stop.killSwitch, true);
    const out = toolCall('aegis_guard_action', {
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', quoteQuantity: 10,
    });
    assert.equal(out.verdict, 'deny');
    assert.ok(out.findings.some((f: { ruleId: string }) => f.ruleId === 'kill-switch'));
  });

  test('resume clears the halt', () => {
    toolCall('aegis_emergency_stop', { reason: 'x' });
    const res = toolCall('aegis_resume', {});
    assert.equal(res.killSwitch, false);
    const out = toolCall('aegis_guard_action', {
      category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', quoteQuantity: 10,
    });
    assert.equal(out.verdict, 'allow');
  });

  test('explain_policy returns the active limits', () => {
    const out = toolCall('aegis_explain_policy', {});
    assert.ok(out.limits);
    assert.ok(Array.isArray(out.rules));
    assert.ok(out.rules.length >= 20);
  });
});

describe('MCP — error handling', () => {
  test('an unknown tool name returns an MCP tool error', () => {
    const res = call('tools/call', { name: 'aegis_nope', arguments: {} });
    assert.equal((res?.result as { isError: boolean }).isError, true);
  });

  test('missing arguments are tolerated as an empty object', () => {
    const res = call('tools/call', { name: 'aegis_status' });
    assert.equal((res?.result as { isError?: boolean }).isError, undefined);
  });

  test('a bad params shape returns -32602', () => {
    const res = call('tools/call', { notName: true });
    assert.equal(res?.error?.code, -32602);
  });

  test('handler never throws on arbitrary input', () => {
    for (const bad of [null, undefined, 42, 'x', [], { jsonrpc: '1.0' }]) {
      assert.doesNotThrow(() => handler(bad as never));
    }
  });
});
