#!/usr/bin/env node
/**
 * Guardian entry point.
 *
 *   aegis guardian --watch BTCUSDT,ETHUSDT --interval 60 --dry-run
 *
 * Defaults to dry-run: the first thing you should do with a new risk daemon is
 * watch it be right for a while before letting it act.
 */

import { Aegis } from '../aegis.js';
import { BinanceAdapter } from '../adapters/binance.js';
import { Guardian } from './loop.js';

interface Args {
  watch: string[];
  intervalMs: number;
  dryRun: boolean;
  cancelOnBreach: boolean;
  once: boolean;
  policyPath?: string;
  dataDir?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    watch: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
    intervalMs: 60_000,
    dryRun: true,
    cancelOnBreach: false,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--watch' && next) { args.watch = next.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); i += 1; }
    else if (a === '--interval' && next) { args.intervalMs = Math.max(5, Number(next)) * 1000; i += 1; }
    else if (a === '--policy' && next) { args.policyPath = next; i += 1; }
    else if (a === '--data-dir' && next) { args.dataDir = next; i += 1; }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--live') args.dryRun = false;
    else if (a === '--cancel-on-breach') args.cancelOnBreach = true;
    else if (a === '--once') args.once = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const aegis = new Aegis({
    ...(args.policyPath ? { policyPath: args.policyPath } : {}),
    ...(args.dataDir ? { dataDir: args.dataDir } : {}),
  });
  const adapter = new BinanceAdapter();

  const available = await adapter.available();
  if (!available) {
    process.stdout.write(
      '[guardian] binance-cli not found. The guardian will keep enforcing on the last known snapshot,\n' +
      '           but it cannot refresh equity or positions. Install it with:\n' +
      '           curl --proto \'=https\' --tlsv1.2 -LsSf \\\n' +
      '             https://github.com/binance/binance-cli/releases/latest/download/binance-cli-installer.sh | sh\n',
    );
  }

  const guardian = new Guardian({
    aegis,
    adapter,
    watch: args.watch,
    intervalMs: args.intervalMs,
    dryRun: args.dryRun,
    cancelOnBreach: args.cancelOnBreach,
  });

  process.stdout.write(
    `[guardian] policy "${aegis.policy.name}" (${aegis.policy.mode}) | watching ${args.watch.join(', ')} | ` +
    `every ${args.intervalMs / 1000}s | ${args.dryRun ? 'DRY-RUN' : 'LIVE'}\n`,
  );

  if (args.once) {
    await guardian.cycle();
    return;
  }

  const shutdown = (): void => {
    guardian.stop();
    process.stdout.write('\n[guardian] stopped.\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await guardian.start();
  // Keep the process alive between unref'd timers.
  setInterval(() => { /* heartbeat */ }, 1 << 30);
}

main().catch((err: Error) => {
  process.stderr.write(`[guardian] fatal: ${err.message}\n`);
  process.exit(1);
});
