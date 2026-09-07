#!/usr/bin/env node
/**
 * Aegis MCP server — newline-delimited JSON-RPC over stdio.
 *
 * Register alongside the Binance MCP server:
 *
 *   claude mcp add aegis -- node /path/to/aegis/dist/mcp/server.js
 *
 * The agent then holds two servers: Binance for execution, Aegis for
 * authorization. stdout carries protocol frames only — every diagnostic goes to
 * stderr, because one stray console.log corrupts an MCP session.
 */

import { Aegis } from '../aegis.js';
import { BinanceAdapter } from '../adapters/binance.js';
import { ExecutionGateway } from '../gateway/executor.js';
import { createHandler, type JsonRpcResponse } from './handler.js';

function parseArgs(argv: string[]): { policyPath?: string; dataDir?: string; gateway: boolean; dryRun: boolean } {
  const out: { policyPath?: string; dataDir?: string; gateway: boolean; dryRun: boolean } =
    { gateway: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--policy' || arg === '-p') && argv[i + 1]) { out.policyPath = argv[i + 1] as string; i += 1; }
    else if ((arg === '--data-dir' || arg === '-d') && argv[i + 1]) { out.dataDir = argv[i + 1] as string; i += 1; }
    else if (arg === '--gateway') out.gateway = true;
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let aegis: Aegis;
  try {
    aegis = new Aegis({
      ...(args.policyPath ? { policyPath: args.policyPath } : {}),
      ...(args.dataDir ? { dataDir: args.dataDir } : {}),
    });
  } catch (err) {
    process.stderr.write(`[aegis] failed to start: ${(err as Error).message}\n`);
    process.exit(1);
    return;
  }

  // Gateway mode: Aegis holds the credentials and becomes the only write path.
  const adapter = new BinanceAdapter();
  const gateway = args.gateway
    ? new ExecutionGateway(aegis, adapter, { dryRun: args.dryRun, refresher: adapter, canceller: adapter })
    : undefined;

  const handle = createHandler(aegis, gateway);

  process.stderr.write(
    `[aegis] MCP server ready — policy "${aegis.policy.name}" (${aegis.policy.mode}), ` +
    `${aegis.rules().length} rules, ${args.gateway ? `GATEWAY${args.dryRun ? ' (dry-run)' : ''}` : 'advisory'} mode, ` +
    `data dir ${aegis.dataDir}\n`,
  );

  const send = (res: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(res)}\n`);
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }

      // Batch requests are legal JSON-RPC; handle them rather than choking.
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          void handle(item).then((res) => { if (res !== null) send(res); });
        }
        continue;
      }

      void handle(parsed).then((res) => { if (res !== null) send(res); });
    }
  });

  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', (err: Error) => {
    process.stderr.write(`[aegis] stdin error: ${err.message}\n`);
    process.exit(1);
  });

  // Never let an unexpected fault take the firewall down silently.
  process.on('uncaughtException', (err: Error) => {
    process.stderr.write(`[aegis] uncaught: ${err.stack ?? err.message}\n`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`[aegis] unhandled rejection: ${String(reason)}\n`);
  });
}

main();
