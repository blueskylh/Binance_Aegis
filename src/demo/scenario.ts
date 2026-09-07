#!/usr/bin/env node
/**
 * The scripted end-to-end demo.
 *
 * Runs entirely offline against a temp data dir — no API keys, no network, no
 * funds at risk — so anyone can reproduce the video in about four seconds:
 *
 *   npm run demo
 *
 * The story it tells is the pitch: a competent agent works freely inside its
 * budget, and the eight ways it can go wrong are each caught by a different
 * deterministic rule, with a cryptographic receipt for every decision.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aegis } from '../aegis.js';
import { loadPolicyFromString } from '../policy/schema.js';
import { bold, cyan, dim, green, magenta, red, severityDot, usd, verdictBadge, yellow } from '../cli/format.js';
import type { ProposedAction } from '../types.js';

const QUIET = process.argv.includes('--quiet');
const out = (s = ''): void => { if (!QUIET) process.stdout.write(`${s}\n`); };

const DEMO_POLICY = [
  'version: 1',
  'name: demo-conservative-desk',
  'mode: enforce',
  'default: deny',
  'limits:',
  '  maxNotionalUsdPerOrder: 500',
  '  maxDailyNotionalUsd: 2000',
  '  maxOpenNotionalUsd: 1500',
  '  maxLeverage: 5',
  '  maxDailyLossUsd: 200',
  '  maxDrawdownPct: 10',
  '  maxOrdersPerMinute: 3',
  '  maxOrdersPerHour: 20',
  '  maxPositionsOpen: 3',
  'allow:',
  '  categories: ["read", "trade", "cancel"]',
  '  venues: ["spot", "futures-usds", "market-data"]',
  '  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"]',
  'deny:',
  '  categories: ["withdraw"]',
  'guards:',
  '  priceDeviationPct: 5',
  '  minAccountEquityUsd: 100',
  '  requireStopLoss: true',
  '  cooldownSecondsAfterLoss: 300',
  '  reviewAboveNotionalUsd: 250',
  '  blockDuplicateActionIds: true',
].join('\n');

interface Beat {
  title: string;
  narrative: string;
  action: ProposedAction;
  /** Applied to the world before the action is evaluated. */
  setup?: (a: Aegis) => void;
  expect: 'allow' | 'review' | 'deny';
}

const MARKS = { BTCUSDT: 100_000, ETHUSDT: 4_000, BNBUSDT: 1_000 };

const BEATS: Beat[] = [
  {
    title: 'Normal operation',
    narrative: 'The agent reads the market. Reads are free — no limit, no friction, no ledger noise beyond the receipt.',
    action: { id: 'd1', category: 'read', venue: 'market-data', symbol: 'BTCUSDT' },
    expect: 'allow',
  },
  {
    title: 'A trade inside budget',
    narrative: 'A $150 spot buy. Comfortably inside every limit, so the agent proceeds autonomously.',
    action: { id: 'd2', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 150 },
    expect: 'allow',
  },
  {
    title: 'Human-in-the-loop escalation',
    narrative: 'A $400 buy is legal but above the $250 autonomy threshold. Aegis does not block it — it hands the decision back to a person.',
    action: { id: 'd3', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 400 },
    expect: 'review',
  },
  {
    title: 'Oversized order',
    narrative: 'The model decides to go big: $5,000 in one clip, 10x the per-order cap. Blocked outright.',
    action: { id: 'd4', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 5_000 },
    expect: 'deny',
  },
  {
    title: 'Hallucinated price',
    narrative: 'A limit buy at $9,000 while BTC trades at $100,000 — the classic stale-context failure. The fat-finger guard catches it.',
    action: { id: 'd5', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', quantity: 0.002, price: 9_000 },
    expect: 'deny',
  },
  {
    title: 'Unprotected leverage',
    narrative: 'A 20x futures entry with no stop attached. Two independent rules reject it: leverage cap and the mandatory-stop guard.',
    action: { id: 'd6', category: 'trade', venue: 'futures-usds', symbol: 'ETHUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 300, leverage: 20 },
    expect: 'deny',
  },
  {
    title: 'Off-mandate asset',
    narrative: 'A memecoin that is nowhere near the mandate. Deny-by-default means the agent never needed to be told about this one specifically.',
    action: { id: 'd7', category: 'trade', venue: 'spot', symbol: 'PEPEUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
    expect: 'deny',
  },
  {
    title: 'Exfiltration attempt',
    narrative: 'A withdrawal to an external address — whether from a jailbreak, a prompt injection or a bug. Structurally impossible under this policy.',
    action: { id: 'd8', category: 'withdraw', venue: 'wallet', asset: 'USDT', quantity: 5_000, destination: '0xattacker' },
    expect: 'deny',
  },
  {
    title: 'Runaway loop',
    narrative: 'The agent has already fired 3 orders this minute. The rate limiter stops the fourth — this is the brake on a looping agent.',
    setup: (a) => {
      for (let i = 0; i < 3; i += 1) {
        a.recordExecution({ actionId: `loop-${i}`, category: 'trade', venue: 'spot', symbol: 'BNBUSDT', notionalUsd: 40, realizedPnlUsd: 0 });
      }
    },
    action: { id: 'd9', category: 'trade', venue: 'spot', symbol: 'BNBUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 40 },
    expect: 'deny',
  },
  {
    title: 'Replay after a retry',
    narrative: 'The same order id resubmitted after a network timeout. Without this guard, a retry becomes a double position.',
    setup: (a) => {
      a.recordExecution({ actionId: 'd10', category: 'trade', venue: 'spot', symbol: 'ETHUSDT', notionalUsd: 100, realizedPnlUsd: 0 });
    },
    action: { id: 'd10', category: 'trade', venue: 'spot', symbol: 'ETHUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
    expect: 'deny',
  },
  {
    title: 'Revenge trading',
    narrative: 'The agent just took a loss and immediately wants back in. The cooldown holds it off — and the daily-loss breaker is now armed too.',
    setup: (a) => {
      a.recordExecution({ actionId: 'loss-1', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', notionalUsd: 200, realizedPnlUsd: -210 });
    },
    action: { id: 'd11', category: 'trade', venue: 'spot', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteQuantity: 100 },
    expect: 'deny',
  },
  {
    title: 'The exit is never blocked',
    narrative: 'Every breaker above is armed — yet a reduce-only close still passes. A risk system that traps you in a position is a risk system.',
    action: { id: 'd12', category: 'trade', venue: 'futures-usds', symbol: 'BTCUSDT', side: 'SELL', orderType: 'MARKET', quoteQuantity: 100, reduceOnly: true },
    expect: 'allow',
  },
];

function hr(): void { out(dim('─'.repeat(78))); }

function runBeats(aegis: Aegis): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;

  BEATS.forEach((beat, i) => {
    beat.setup?.(aegis);
    const result = aegis.guard(beat.action);
    const ok = result.verdict === beat.expect;
    if (ok) pass += 1; else fail += 1;

    out();
    out(`${dim(`[${String(i + 1).padStart(2, '0')}/${BEATS.length}]`)} ${bold(beat.title)}`);
    out(dim(`      ${beat.narrative}`));
    out();
    out(`      ${verdictBadge(result.verdict)} ${dim(`(expected ${beat.expect})`)} ${ok ? green('✓') : red('✗ MISMATCH')}`);
    for (const f of result.findings.slice(0, 3)) {
      out(`      ${severityDot(f.severity)} ${cyan(f.ruleId)} ${dim('—')} ${f.message}`);
    }
    out(dim(`      ledger #${result.ledgerSeq}  ${result.ledgerHash.slice(0, 24)}…`));
  });

  return { pass, fail };
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-demo-'));
  let exitCode = 0;

  try {
    const aegis = new Aegis({ dataDir: dir, policy: loadPolicyFromString(DEMO_POLICY) });
    aegis.updateAccount({ equityUsd: 10_000, positions: [], marks: MARKS });

    out();
    out(bold(magenta('  ╔══════════════════════════════════════════════════════════════════════════╗')));
    out(bold(magenta('  ║   AEGIS — the risk firewall for Binance Agent OS                          ║')));
    out(bold(magenta('  ║   Every agent action is judged by 20 deterministic rules,                 ║')));
    out(bold(magenta('  ║   then hash-chained into a tamper-evident audit ledger.                   ║')));
    out(bold(magenta('  ╚══════════════════════════════════════════════════════════════════════════╝')));
    out();
    out(`  policy   ${bold(aegis.policy.name)} ${dim(`(${aegis.policy.mode}, default ${aegis.policy.default})`)}`);
    out(`  equity   ${bold(usd(10_000))}   ${dim('marks: BTC $100,000 · ETH $4,000 · BNB $1,000')}`);
    out(`  rules    ${bold(String(aegis.rules().length))} active`);
    out();
    hr();

    const { pass, fail } = runBeats(aegis);

    out();
    hr();
    out();
    out(bold('  SCENARIO RESULT'));
    out(`  ${pass}/${BEATS.length} beats behaved exactly as specified. ${fail === 0 ? green('All correct.') : red(`${fail} mismatch(es).`)}`);
    if (fail > 0) exitCode = 1;

    // --- Audit trail ------------------------------------------------------
    out();
    out(bold('  AUDIT LEDGER'));
    const verify = aegis.verifyLedger();
    out(`  ${verify.ok ? green('✅ chain intact') : red('❌ chain broken')} — ${verify.entries} entries verified`);
    out(dim(`     head ${verify.head}`));

    // --- Tamper demonstration --------------------------------------------
    out();
    out(bold('  TAMPER TEST'));
    out(dim('     Rewriting one historical DENY into an ALLOW, the way a bad actor would…'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const targetIdx = lines.findIndex((l) => l.includes('"verdict":"deny"'));
    if (targetIdx >= 0) {
      const entry = JSON.parse(lines[targetIdx] as string) as { payload: Record<string, unknown> };
      entry.payload['verdict'] = 'allow';
      lines[targetIdx] = JSON.stringify(entry);
      writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

      const after = new Aegis({ dataDir: dir, policy: loadPolicyFromString(DEMO_POLICY) }).verifyLedger();
      if (after.ok) {
        out(`     ${red('✗ tampering went undetected — this is a bug')}`);
        exitCode = 1;
      } else {
        out(`     ${green('✅ DETECTED')} — ${after.reason}`);
        out(dim(`        The forgery is caught at seq ${String(after.brokenAt)}; every later hash no longer matches.`));
      }
    }

    out();
    hr();
    out();
    out(bold('  WHY THIS MATTERS'));
    out(dim('     Binance Agent OS gives an agent real market power. Aegis is the layer that'));
    out(dim('     decides what it may do with it — deterministically, before execution, with a'));
    out(dim('     cryptographic receipt for every call. No LLM in the enforcement path.'));
    out();
    out(`  ${cyan('Next:')} aegis init  ·  aegis status  ·  aegis ledger verify  ·  aegis mcp`);
    out();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (QUIET) process.stdout.write(`demo: ok\n`);
  process.exitCode = exitCode;
}

main();
