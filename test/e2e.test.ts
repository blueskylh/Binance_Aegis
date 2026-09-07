/**
 * End-to-end integration tests.
 *
 * These spawn the real CLI and the real MCP server as child processes and talk
 * to them over stdio, exactly as Claude Code would. Unit tests prove the logic;
 * only this file proves the product actually runs.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../src/cli/main.js');
const MCP = resolve(HERE, '../src/mcp/server.js');

let dir: string;
let policyPath: string;

const POLICY = [
  'version: 1',
  'name: e2e',
  'mode: enforce',
  'default: deny',
  'limits:',
  '  maxNotionalUsdPerOrder: 500',
  'allow:',
  '  categories: ["read", "trade", "cancel"]',
  '  venues: ["spot", "market-data"]',
  'guards:',
  '  reviewAboveNotionalUsd: 250',
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-'));
  policyPath = join(dir, 'policy.yaml');
  writeFileSync(policyPath, POLICY, 'utf8');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [CLI, '--policy', policyPath, '--data-dir', dir, ...args],
      { timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
        res({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe('e2e — CLI', () => {
  test('--help exits 0 and lists the commands', async () => {
    const r = await cli(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /aegis/);
    assert.match(r.stdout, /ledger verify/);
  });

  test('--version prints a semver', async () => {
    const r = await cli(['--version']);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('check allows a compliant order and exits 0', async () => {
    const r = await cli(['check', '--category', 'trade', '--venue', 'spot', '--symbol', 'BTCUSDT', '--side', 'BUY', '--quoteQuantity', '100']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ALLOW/);
  });

  test('check denies an oversized order and exits 1 (usable in a shell guard)', async () => {
    const r = await cli(['check', '--category', 'trade', '--venue', 'spot', '--symbol', 'BTCUSDT', '--side', 'BUY', '--quoteQuantity', '5000']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /DENY/);
    assert.match(r.stdout, /max-notional-per-order/);
  });

  test('check escalates to review', async () => {
    const r = await cli(['check', '--category', 'trade', '--venue', 'spot', '--symbol', 'BTCUSDT', '--side', 'BUY', '--quoteQuantity', '300']);
    assert.match(r.stdout, /REVIEW/);
  });

  test('check accepts a JSON action', async () => {
    const r = await cli(['check', '{"category":"read","venue":"market-data","symbol":"BTCUSDT"}']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ALLOW/);
  });

  test('--json emits parseable output', async () => {
    const r = await cli(['--json', 'check', '{"category":"read","venue":"market-data"}']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, 'allow');
    assert.ok(parsed.ledgerHash);
  });

  test('status renders the posture', async () => {
    await cli(['check', '{"category":"read","venue":"market-data"}']);
    const r = await cli(['status']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /AEGIS RISK POSTURE/);
    assert.match(r.stdout, /BUDGETS/);
  });

  test('rules lists all 23 rules', async () => {
    const r = await cli(['--json', 'rules']);
    assert.equal(JSON.parse(r.stdout).length, 23);
  });

  test('policy validate accepts a good file and rejects a bad one', async () => {
    const good = await cli(['policy', 'validate', policyPath]);
    assert.equal(good.code, 0);

    const badPath = join(dir, 'bad.yaml');
    writeFileSync(badPath, 'version: 1\nname: bad\nlimmits:\n  maxLeverage: 3\n');
    const bad = await cli(['policy', 'validate', badPath]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /unknown key/i);
  });

  test('halt blocks the next trade, resume unblocks it', async () => {
    await cli(['halt', 'e2e test']);
    const blocked = await cli(['check', '--category', 'trade', '--venue', 'spot', '--symbol', 'BTCUSDT', '--side', 'BUY', '--quoteQuantity', '10']);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stdout, /kill-switch/);

    await cli(['resume']);
    const allowed = await cli(['check', '--category', 'trade', '--venue', 'spot', '--symbol', 'BTCUSDT', '--side', 'BUY', '--quoteQuantity', '10']);
    assert.equal(allowed.code, 0);
  });

  test('ledger verify passes on a real session and tail renders', async () => {
    await cli(['check', '{"category":"read","venue":"market-data"}']);
    await cli(['check', '{"category":"trade","venue":"spot","symbol":"BTCUSDT","side":"BUY","quoteQuantity":9000}']);

    const verify = await cli(['ledger', 'verify']);
    assert.equal(verify.code, 0);
    assert.match(verify.stdout, /Ledger intact/);

    const tail = await cli(['ledger', 'tail', '5']);
    assert.match(tail.stdout, /SEQ/);
  });

  test('ledger verify exits 1 and names the entry after tampering', async () => {
    await cli(['check', '{"category":"read","venue":"market-data"}']);
    await cli(['check', '{"category":"read","venue":"market-data","symbol":"ETHUSDT"}']);

    const ledgerPath = join(dir, 'ledger.jsonl');
    const lines = (await import('node:fs')).readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0] as string);
    first.payload.verdict = 'deny';
    lines[0] = JSON.stringify(first);
    writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

    const r = await cli(['ledger', 'verify']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /TAMPERED/);
  });

  test('an unknown command exits 2', async () => {
    assert.equal((await cli(['frobnicate'])).code, 2);
  });

  test('record advances the daily counters', async () => {
    const check = await cli(['--json', 'check', '{"id":"e2e-1","category":"trade","venue":"spot","symbol":"BTCUSDT","side":"BUY","quoteQuantity":100}']);
    assert.equal(JSON.parse(check.stdout).verdict, 'allow');

    const rec = await cli(['--json', 'record', '--actionId', 'e2e-1', '--notionalUsd', '100', '--realizedPnlUsd', '-12.5']);
    assert.equal(rec.code, 0);
    assert.equal(JSON.parse(rec.stdout).recorded, true);

    const status = JSON.parse((await cli(['--json', 'status'])).stdout);
    assert.equal(status.dailyNotionalUsd, 100);
    assert.equal(status.dailyRealizedPnlUsd, -12.5);
  });

  test('record requires an actionId', async () => {
    assert.equal((await cli(['record', '--notionalUsd', '10'])).code, 2);
  });

  test('init writes a policy and prints MCP wiring', async () => {
    const target = join(dir, 'new.policy.yaml');
    const r = await cli(['init', target]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /mcpServers/);
    assert.equal((await cli(['policy', 'validate', target])).code, 0);
  });
});

/** Drive the MCP server over real stdio, one JSON-RPC line at a time. */
class McpClient {
  private readonly child = spawn(process.execPath, [MCP, '--policy', policyPath, '--data-dir', dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  private buffer = '';
  private readonly pending = new Map<number, (v: Record<string, unknown>) => void>();
  private nextId = 1;

  constructor() {
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf('\n');
        if (line === '') continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg as Record<string, unknown>);
      }
    });
  }

  send(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout on ${method}`)), 15_000);
      this.pending.set(id, (v) => { clearTimeout(timer); res(v); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  close(): void { this.child.kill(); }
}

describe('e2e — MCP server over stdio', () => {
  test('completes a full agent session against the live server', async () => {
    const client = new McpClient();
    try {
      const init = await client.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      const initResult = init['result'] as Record<string, unknown>;
      assert.equal((initResult['serverInfo'] as Record<string, string>)['name'], 'aegis');
      assert.match(String(initResult['instructions']), /aegis_guard_action/);

      client.notify('notifications/initialized');

      const list = await client.send('tools/list');
      const tools = ((list['result'] as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
      assert.ok(tools.includes('aegis_guard_action'));
      assert.equal(tools.length, 13);
      assert.ok(tools.includes('aegis_execute'), 'gateway tool must be advertised');

      // The agent seeds a mark so the firewall can size a quantity-based order.
      const allowed = await client.send('tools/call', {
        name: 'aegis_guard_action',
        arguments: { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
      });
      const allowedBody = JSON.parse(
        ((allowed['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text,
      );
      assert.equal(allowedBody.verdict, 'allow');

      const denied = await client.send('tools/call', {
        name: 'aegis_guard_action',
        arguments: { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 9000 },
      });
      const deniedBody = JSON.parse(
        ((denied['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text,
      );
      assert.equal(deniedBody.verdict, 'deny');

      const verify = await client.send('tools/call', { name: 'aegis_verify_ledger', arguments: {} });
      const verifyBody = JSON.parse(
        ((verify['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text,
      );
      assert.equal(verifyBody.ok, true);
      assert.ok(verifyBody.entries >= 2);

      const stop = await client.send('tools/call', { name: 'aegis_emergency_stop', arguments: { reason: 'e2e' } });
      const stopBody = JSON.parse(
        ((stop['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text,
      );
      assert.equal(stopBody.killSwitch, true);

      const afterStop = await client.send('tools/call', {
        name: 'aegis_guard_action',
        arguments: { category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', quoteQuantity: 10 },
      });
      const afterStopBody = JSON.parse(
        ((afterStop['result'] as { content: Array<{ text: string }> }).content[0] as { text: string }).text,
      );
      assert.equal(afterStopBody.verdict, 'deny');
    } finally {
      client.close();
    }
  });

  test('survives malformed input without dying', async () => {
    const client = new McpClient();
    try {
      client.notify('garbage that is not json');
      const pong = await client.send('ping');
      assert.deepEqual(pong['result'], {});
    } finally {
      client.close();
    }
  });
});
