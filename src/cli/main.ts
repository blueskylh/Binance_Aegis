#!/usr/bin/env node
/**
 * The `aegis` CLI.
 *
 * Same engine as the MCP server — this is the human-facing door onto it, and the
 * way non-MCP agents (a shell script, a cron job, a LangChain tool) integrate.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Aegis, DEFAULT_POLICY_YAML, defaultDataDir } from '../aegis.js';
import { loadPolicyFile } from '../policy/schema.js';
import { bar, bold, cyan, dim, green, red, severityDot, table, usd, verdictBadge, yellow } from './format.js';
import type { ProposedAction } from '../types.js';

const VERSION = '1.0.0';

interface GlobalOpts {
  policyPath?: string;
  dataDir?: string;
  json: boolean;
}

function out(s = ''): void { process.stdout.write(`${s}\n`); }

function parseGlobals(argv: string[]): { globals: GlobalOpts; rest: string[] } {
  const globals: GlobalOpts = { json: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const next = argv[i + 1];
    if ((a === '--policy' || a === '-p') && next) { globals.policyPath = next; i += 1; }
    else if ((a === '--data-dir' || a === '-d') && next) { globals.dataDir = next; i += 1; }
    else if (a === '--json') globals.json = true;
    else rest.push(a);
  }
  return { globals, rest };
}

function makeAegis(g: GlobalOpts): Aegis {
  return new Aegis({
    ...(g.policyPath ? { policyPath: g.policyPath } : {}),
    ...(g.dataDir ? { dataDir: g.dataDir } : {}),
  });
}

/** Build an action from `--key value` flags or a single JSON argument. */
function parseAction(args: string[]): ProposedAction {
  const first = args[0];
  if (first && (first.trim().startsWith('{'))) {
    return JSON.parse(first) as unknown as ProposedAction;
  }
  const obj: Record<string, unknown> = {};
  const numeric = new Set(['quantity', 'price', 'quoteQuantity', 'leverage']);
  const boolish = new Set(['reduceOnly', 'hasStopLoss']);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (boolish.has(key)) { obj[key] = true; continue; }
    const value = args[i + 1];
    if (value === undefined) continue;
    obj[key] = numeric.has(key) ? Number(value) : value;
    i += 1;
  }
  return obj as unknown as ProposedAction;
}

const HELP = `
${bold('aegis')} — the risk firewall for Binance Agent OS  ${dim(`v${VERSION}`)}

${bold('USAGE')}
  aegis <command> [options]

${bold('COMMANDS')}
  ${cyan('check')} <action>        Evaluate a proposed action and record the decision
  ${cyan('record')} --actionId ..   Record an execution (advances the budget counters)
  ${cyan('status')}                Current risk posture and budget consumption
  ${cyan('rules')}                 List the enforced rules
  ${cyan('policy show')}           Print the active policy
  ${cyan('policy validate')} <f>   Validate a policy file and exit non-zero if invalid
  ${cyan('ledger verify')}         Cryptographically verify the audit chain
  ${cyan('ledger tail')} [n]       Show the last n ledger entries (default 20)
  ${cyan('account')}               Set the account snapshot (equity / marks)
  ${cyan('halt')} <reason>         Engage the kill-switch
  ${cyan('resume')} [--reset-peak] Disengage the kill-switch
  ${cyan('init')} [path]           Write a starter policy and print MCP wiring
  ${cyan('mcp')}                   Run the MCP server on stdio
  ${cyan('guardian')} [...]        Run the portfolio circuit-breaker daemon
  ${cyan('demo')}                  Run the scripted end-to-end demo

${bold('GLOBAL OPTIONS')}
  -p, --policy <file>     Policy file (or set AEGIS_POLICY)
  -d, --data-dir <dir>    Ledger + state directory (default ~/.aegis, or AEGIS_HOME)
      --json              Machine-readable output
  -h, --help              This help
  -v, --version           Print version

${bold('EXAMPLES')}
  ${dim('# Would this order be allowed?')}
  aegis check --category trade --venue spot --symbol BTCUSDT --side BUY --quoteQuantity 250

  ${dim('# Same thing as JSON')}
  aegis check '{"category":"trade","venue":"futures-usds","symbol":"ETHUSDT","side":"BUY","quoteQuantity":800,"leverage":20}'

  ${dim('# Prove nobody edited the audit trail')}
  aegis ledger verify
`;

function cmdCheck(g: GlobalOpts, args: string[]): number {
  const aegis = makeAegis(g);
  let action: ProposedAction;
  try {
    action = parseAction(args);
  } catch (err) {
    out(red(`Could not parse the action: ${(err as Error).message}`));
    return 2;
  }
  const result = aegis.guard(action);

  if (g.json) { out(JSON.stringify(result, null, 2)); return result.verdict === 'deny' ? 1 : 0; }

  out();
  out(`${verdictBadge(result.verdict)}  ${bold(result.summary)}`);
  out(dim(`  policy "${result.policy}" (${result.mode})  ·  action ${result.actionId}  ·  ledger #${result.ledgerSeq}`));
  if (result.findings.length > 0) {
    out();
    for (const f of result.findings) {
      out(`  ${severityDot(f.severity)} ${bold(f.ruleId)} — ${f.message}`);
      if (f.observed !== null || f.limit !== null) {
        out(dim(`     observed: ${String(f.observed)}   limit: ${String(f.limit)}`));
      }
    }
  }
  out();
  if (result.verdict === 'review') {
    out(yellow('  → Human confirmation required before this may execute.'));
    out();
  }
  return result.verdict === 'deny' ? 1 : 0;
}

function cmdRecord(g: GlobalOpts, args: string[]): number {
  const aegis = makeAegis(g);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (!a.startsWith('--')) continue;
    const value = args[i + 1];
    if (value === undefined) continue;
    opts[a.slice(2)] = value;
    i += 1;
  }

  const actionId = opts['actionId'];
  if (!actionId) {
    out(red('usage: aegis record --actionId <id> --notionalUsd <n> [--realizedPnlUsd <n>] [--symbol S] [--venue V]'));
    out(dim('   The actionId must be the one returned by `aegis check` — that is what links a decision to its outcome.'));
    return 2;
  }

  const entry = aegis.recordExecution({
    actionId,
    category: opts['category'] ?? 'trade',
    venue: opts['venue'] ?? 'spot',
    symbol: opts['symbol'] ?? null,
    notionalUsd: Number(opts['notionalUsd'] ?? 0),
    realizedPnlUsd: Number(opts['realizedPnlUsd'] ?? 0),
  });

  const payload = { recorded: true, actionId, ledgerSeq: entry.seq, ledgerHash: entry.hash };
  if (g.json) { out(JSON.stringify(payload, null, 2)); return 0; }
  out(green(`✅ execution recorded — ledger #${entry.seq}`));
  out(dim(`   ${actionId}  ·  notional ${usd(Number(opts['notionalUsd'] ?? 0))}  ·  PnL ${usd(Number(opts['realizedPnlUsd'] ?? 0))}`));
  return 0;
}

function cmdStatus(g: GlobalOpts): number {
  const aegis = makeAegis(g);
  const s = aegis.status();
  if (g.json) { out(JSON.stringify(s, null, 2)); return 0; }

  const budgets = s['budgets'] as Record<string, { used: number; cap: number | null; usedPct: number | null }>;
  const halted = s['killSwitch'] === true;

  out();
  out(bold('  AEGIS RISK POSTURE'));
  out(dim('  ' + '─'.repeat(58)));
  out(`  policy         ${bold(String(s['policy']))} ${dim(`(${String(s['mode'])})`)}`);
  out(`  kill-switch    ${halted ? red('ENGAGED — ' + String(s['killSwitchReason'] ?? '')) : green('off')}`);
  out(`  equity         ${bold(usd(Number(s['equityUsd'])))}  ${dim(`peak ${usd(Number(s['peakEquityUsd']))}`)}`);
  out(`  drawdown       ${Number(s['drawdownPct']) > 0 ? yellow(`${String(s['drawdownPct'])}%`) : green('0%')}`);
  out(`  positions      ${String(s['openPositions'])} open  ${dim(`exposure ${usd(Number(s['openExposureUsd']))}`)}`);
  out(`  today          ${String(s['ordersLastHour'])} orders/h  ${dim(`PnL ${usd(Number(s['dailyRealizedPnlUsd']))}`)}`);
  out();
  out(bold('  BUDGETS'));
  out(`  daily notional ${bar(budgets['dailyNotional']?.usedPct ?? null)}  ${dim(`${usd(budgets['dailyNotional']?.used ?? 0)} / ${budgets['dailyNotional']?.cap === null ? '∞' : usd(budgets['dailyNotional']?.cap ?? 0)}`)}`);
  out(`  open exposure  ${bar(budgets['openExposure']?.usedPct ?? null)}  ${dim(`${usd(budgets['openExposure']?.used ?? 0)} / ${budgets['openExposure']?.cap === null ? '∞' : usd(budgets['openExposure']?.cap ?? 0)}`)}`);
  out(`  daily loss     ${bar(budgets['dailyLoss']?.usedPct ?? null)}  ${dim(`${usd(budgets['dailyLoss']?.used ?? 0)} / ${budgets['dailyLoss']?.cap === null ? '∞' : usd(budgets['dailyLoss']?.cap ?? 0)}`)}`);
  out();
  out(dim(`  ledger: ${String(s['ledgerEntries'])} entries · head ${String(s['ledgerHead']).slice(0, 16)}… · ${String(s['rulesActive'])} rules active`));
  out();
  return 0;
}

function cmdRules(g: GlobalOpts): number {
  const aegis = makeAegis(g);
  const rules = aegis.rules();
  if (g.json) { out(JSON.stringify(rules, null, 2)); return 0; }
  out();
  out(bold(`  ${rules.length} RULES ENFORCED`));
  out();
  out('  ' + table(rules.map((r) => [cyan(r.id), r.about]), ['RULE', 'ENFORCES']).split('\n').join('\n  '));
  out();
  return 0;
}

function cmdPolicy(g: GlobalOpts, args: string[]): number {
  const sub = args[0];
  if (sub === 'validate') {
    const path = args[1];
    if (!path) { out(red('usage: aegis policy validate <file>')); return 2; }
    try {
      const p = loadPolicyFile(path);
      out(green(`✅ ${path} is valid — policy "${p.name}" (${p.mode}, default ${p.default})`));
      return 0;
    } catch (err) {
      out(red(`❌ ${(err as Error).message}`));
      return 1;
    }
  }
  const aegis = makeAegis(g);
  out(JSON.stringify(aegis.policy, null, 2));
  return 0;
}

function cmdLedger(g: GlobalOpts, args: string[]): number {
  const aegis = makeAegis(g);
  const sub = args[0] ?? 'verify';

  if (sub === 'verify') {
    const r = aegis.verifyLedger();
    if (g.json) { out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
    out();
    if (r.ok) {
      out(green(`  ✅ Ledger intact — ${r.entries} entries verified against the hash chain.`));
      out(dim(`     head: ${r.head}`));
    } else {
      out(red(`  ❌ LEDGER TAMPERED — ${r.reason}`));
      out(red(`     first bad entry: seq ${String(r.brokenAt)}`));
    }
    out();
    return r.ok ? 0 : 1;
  }

  if (sub === 'tail') {
    const n = Number(args[1] ?? 20) || 20;
    const entries = aegis.ledger.tail(n);
    if (g.json) { out(JSON.stringify(entries, null, 2)); return 0; }
    out();
    const rows = entries.map((e) => {
      const p = e.payload as Record<string, unknown>;
      const verdict = typeof p['verdict'] === 'string' ? String(p['verdict']) : '';
      const action = p['action'] as Record<string, unknown> | undefined;
      const label = action
        ? `${String(action['category'])} ${String(action['symbol'] ?? action['venue'])}`
        : String(p['message'] ?? p['symbol'] ?? p['reason'] ?? '');
      return [
        dim(`#${e.seq}`),
        new Date(e.ts).toISOString().slice(11, 19),
        e.type,
        verdict ? verdictBadge(verdict) : '',
        label,
        dim(e.hash.slice(0, 10)),
      ];
    });
    out('  ' + table(rows, ['SEQ', 'TIME', 'TYPE', 'VERDICT', 'SUBJECT', 'HASH']).split('\n').join('\n  '));
    out();
    return 0;
  }

  out(red(`unknown ledger subcommand "${sub}" (try: verify, tail)`));
  return 2;
}

function cmdAccount(g: GlobalOpts, args: string[]): number {
  const aegis = makeAegis(g);
  let equityUsd: number | null = null;
  const marks: Record<string, number> = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--equity' && next) { equityUsd = Number(next); i += 1; }
    else if (a === '--mark' && next) {
      const [sym, price] = next.split('=');
      if (sym && price) marks[sym.toUpperCase()] = Number(price);
      i += 1;
    }
  }
  if (equityUsd === null && Object.keys(marks).length === 0) {
    out(red('usage: aegis account --equity 10000 [--mark BTCUSDT=100000]'));
    return 2;
  }
  const current = aegis.status();
  aegis.updateAccount({
    equityUsd: equityUsd ?? Number(current['equityUsd']),
    positions: [],
    marks,
  });
  out(green('✅ account snapshot updated'));
  return cmdStatus(g);
}

function cmdInit(g: GlobalOpts, args: string[]): number {
  const path = resolve(args[0] ?? 'aegis.policy.yaml');
  if (existsSync(path)) {
    out(yellow(`${path} already exists — not overwriting.`));
  } else {
    writeFileSync(path, `${DEFAULT_POLICY_YAML}\n`, 'utf8');
    out(green(`✅ wrote starter policy to ${path}`));
  }
  const server = resolve(new URL('../mcp/server.js', import.meta.url).pathname);
  out();
  out(bold('Wire it into your agent:'));
  out();
  out(dim('  # Claude Code'));
  out(`  claude mcp add aegis -- node ${server} --policy ${path}`);
  out();
  out(dim('  # Any MCP client (.mcp.json)'));
  out(JSON.stringify({
    mcpServers: { aegis: { command: 'node', args: [server, '--policy', path] } },
  }, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  out();
  out(dim(`  data dir: ${g.dataDir ?? defaultDataDir()}`));
  out();
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) { out(HELP); return 0; }
  if (argv.includes('-v') || argv.includes('--version')) { out(VERSION); return 0; }

  const { globals, rest } = parseGlobals(argv);
  const cmd = rest[0];
  const args = rest.slice(1);

  switch (cmd) {
    case 'check': return cmdCheck(globals, args);
    case 'record': return cmdRecord(globals, args);
    case 'status': return cmdStatus(globals);
    case 'rules': return cmdRules(globals);
    case 'policy': return cmdPolicy(globals, args);
    case 'ledger': return cmdLedger(globals, args);
    case 'account': return cmdAccount(globals, args);
    case 'init': return cmdInit(globals, args);

    case 'halt': {
      const aegis = makeAegis(globals);
      const reason = args.join(' ') || 'manual halt';
      aegis.halt(reason);
      out(red(`🛑 kill-switch ENGAGED — ${reason}`));
      out(dim('   Reads and cancels still work so you can always flatten.'));
      return 0;
    }

    case 'resume': {
      const aegis = makeAegis(globals);
      aegis.resume(args.includes('--reset-peak'));
      out(green('✅ kill-switch disengaged'));
      return 0;
    }

    case 'mcp': {
      await import('../mcp/server.js');
      return 0;
    }

    case 'guardian': {
      // Re-project the globals the guardian entry point parses for itself,
      // otherwise `aegis guardian --policy X` would silently drop the policy.
      const forwarded = [...args];
      if (globals.policyPath) forwarded.push('--policy', globals.policyPath);
      if (globals.dataDir) forwarded.push('--data-dir', globals.dataDir);
      process.argv = [process.argv[0] as string, 'guardian', ...forwarded];
      await import('../guardian/run.js');
      return 0;
    }

    case 'demo': {
      await import('../demo/scenario.js');
      return 0;
    }

    default:
      out(red(`unknown command "${String(cmd)}"`));
      out(HELP);
      return 2;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err: Error) => {
    process.stderr.write(`${red('aegis error:')} ${err.message}\n`);
    process.exitCode = 1;
  });
