/**
 * Policy loading, validation and normalization.
 *
 * A risk policy is a security artefact: an unnoticed typo (`maxLevrage`) that
 * silently falls back to "no limit" is exactly the failure mode this project
 * exists to prevent. So validation is strict and closed — unknown keys are hard
 * errors, not warnings.
 */

import { readFileSync } from 'node:fs';
import { parseYaml, type YamlValue } from './yaml.js';
import type {
  ActionCategory,
  Policy,
  PolicyAccess,
  PolicyGuards,
  PolicyLimits,
  PolicyMode,
  Venue,
} from '../types.js';

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'read', 'trade', 'cancel', 'transfer', 'onchain', 'withdraw',
];

export const VENUES: readonly Venue[] = [
  'spot', 'margin', 'futures-usds', 'futures-coin', 'convert', 'wallet', 'market-data',
];

const MODES: readonly PolicyMode[] = ['enforce', 'monitor', 'simulate'];

const LIMIT_KEYS = [
  'maxNotionalUsdPerOrder',
  'maxDailyNotionalUsd',
  'maxOpenNotionalUsd',
  'maxLeverage',
  'maxDailyLossUsd',
  'maxDrawdownPct',
  'maxOrdersPerMinute',
  'maxOrdersPerHour',
  'maxPositionsOpen',
  'maxPositionSnapshotAgeSec',
] as const;

const GUARD_KEYS = [
  'priceDeviationPct',
  'minAccountEquityUsd',
  'requireStopLoss',
  'tradingHoursUtc',
  'cooldownSecondsAfterLoss',
  'reviewAboveNotionalUsd',
  'blockDuplicateActionIds',
  'maxStopDistancePct',
] as const;

const ACCESS_KEYS = ['categories', 'venues', 'symbols'] as const;
const TOP_KEYS = ['version', 'name', 'mode', 'default', 'limits', 'allow', 'deny', 'guards'] as const;

/** The safe baseline every policy is layered on top of. Frozen; never mutated. */
export const DEFAULT_POLICY: Policy = Object.freeze({
  version: 1,
  name: 'unnamed',
  mode: 'enforce',
  default: 'deny',
  limits: Object.freeze({
    maxNotionalUsdPerOrder: null,
    maxDailyNotionalUsd: null,
    maxOpenNotionalUsd: null,
    maxLeverage: null,
    maxDailyLossUsd: null,
    maxDrawdownPct: null,
    maxOrdersPerMinute: null,
    maxOrdersPerHour: null,
    maxPositionsOpen: null,
    maxPositionSnapshotAgeSec: null,
  }) as PolicyLimits,
  allow: Object.freeze({ categories: null, venues: null, symbols: null }) as PolicyAccess,
  deny: Object.freeze({ categories: null, venues: null, symbols: null }) as PolicyAccess,
  guards: Object.freeze({
    priceDeviationPct: null,
    minAccountEquityUsd: null,
    requireStopLoss: false,
    tradingHoursUtc: null,
    cooldownSecondsAfterLoss: null,
    reviewAboveNotionalUsd: null,
    blockDuplicateActionIds: true,
    maxStopDistancePct: null,
  }) as PolicyGuards,
}) as Policy;

// --- helpers ---------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, YamlValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PolicyError(
        `unknown key "${key}" in ${where}. Allowed: ${allowed.join(', ')}. ` +
        `Aegis rejects unknown keys so a typo can never silently disable a control.`,
      );
    }
  }
}

function readNumberOrNull(raw: unknown, key: string, opts: { max?: number } = {}): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new PolicyError(`"${key}" must be a number or null, received ${JSON.stringify(raw)}`);
  }
  if (raw < 0) throw new PolicyError(`"${key}" must be >= 0 (negative limits are meaningless), received ${raw}`);
  if (opts.max !== undefined && raw > opts.max) {
    throw new PolicyError(`"${key}" must be <= ${opts.max}, received ${raw}`);
  }
  return raw;
}

function readBoolean(raw: unknown, key: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new PolicyError(`"${key}" must be a boolean (true/false), received ${JSON.stringify(raw)}`);
  }
  return raw;
}

function readStringList(raw: unknown, key: string): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new PolicyError(`"${key}" must be a list, received ${JSON.stringify(raw)}`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new PolicyError(`"${key}" must contain only strings, found ${JSON.stringify(item)}`);
    }
    out.push(item);
  }
  return out;
}

function dedupeUpper(list: string[] | null): string[] | null {
  if (list === null) return null;
  return [...new Set(list.map((s) => s.trim().toUpperCase()))];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function readTradingHours(raw: unknown): { from: string; to: string } | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw new PolicyError('"tradingHoursUtc" must be a map with "from" and "to"');
  assertNoUnknownKeys(raw, ['from', 'to'], 'guards.tradingHoursUtc');
  const from = raw['from'];
  const to = raw['to'];
  if (typeof from !== 'string' || !HHMM.test(from)) {
    throw new PolicyError(`"tradingHoursUtc.from" must be HH:MM in 24h UTC, received ${JSON.stringify(from)}`);
  }
  if (typeof to !== 'string' || !HHMM.test(to)) {
    throw new PolicyError(`"tradingHoursUtc.to" must be HH:MM in 24h UTC, received ${JSON.stringify(to)}`);
  }
  return { from, to };
}

function readAccess(raw: unknown, where: string): PolicyAccess {
  if (raw === undefined || raw === null) return { categories: null, venues: null, symbols: null };
  if (!isPlainObject(raw)) throw new PolicyError(`"${where}" must be a map`);
  assertNoUnknownKeys(raw, ACCESS_KEYS, where);

  const categories = readStringList(raw['categories'], `${where}.categories`);
  if (categories) {
    for (const c of categories) {
      if (!ACTION_CATEGORIES.includes(c as ActionCategory)) {
        throw new PolicyError(
          `invalid action category "${c}" in ${where}.categories. Valid: ${ACTION_CATEGORIES.join(', ')}`,
        );
      }
    }
  }

  const venues = readStringList(raw['venues'], `${where}.venues`);
  if (venues) {
    for (const v of venues) {
      if (!VENUES.includes(v as Venue)) {
        throw new PolicyError(`invalid venue "${v}" in ${where}.venues. Valid: ${VENUES.join(', ')}`);
      }
    }
  }

  return {
    categories: categories as ActionCategory[] | null,
    venues: venues as Venue[] | null,
    symbols: dedupeUpper(readStringList(raw['symbols'], `${where}.symbols`)),
  };
}

// --- entry points ----------------------------------------------------------

/** Parse and validate a policy from a YAML or JSON string. */
export function loadPolicyFromString(source: string): Policy {
  let doc: Record<string, YamlValue>;
  const trimmed = source.trim();
  if (trimmed.startsWith('{')) {
    try {
      doc = JSON.parse(trimmed) as Record<string, YamlValue>;
    } catch (err) {
      throw new PolicyError(`policy is not valid JSON: ${(err as Error).message}`);
    }
  } else {
    try {
      doc = parseYaml(source);
    } catch (err) {
      throw new PolicyError(`policy is not valid YAML: ${(err as Error).message}`);
    }
  }

  assertNoUnknownKeys(doc, TOP_KEYS, 'policy root');

  if (doc['version'] === undefined || doc['version'] === null) {
    throw new PolicyError('policy is missing required key "version" (must be 1)');
  }
  if (doc['version'] !== 1) {
    throw new PolicyError(`unsupported policy version ${JSON.stringify(doc['version'])}; this build supports version 1`);
  }

  const name = doc['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw new PolicyError('policy "name" must be a non-empty string — it is recorded in every ledger entry');
  }

  const modeRaw = doc['mode'] ?? DEFAULT_POLICY.mode;
  if (typeof modeRaw !== 'string' || !MODES.includes(modeRaw as PolicyMode)) {
    throw new PolicyError(`invalid "mode" ${JSON.stringify(modeRaw)}. Valid: ${MODES.join(', ')}`);
  }

  const defaultRaw = doc['default'] ?? DEFAULT_POLICY.default;
  if (defaultRaw !== 'allow' && defaultRaw !== 'deny') {
    throw new PolicyError(`invalid "default" ${JSON.stringify(defaultRaw)}. Valid: allow, deny`);
  }

  const limitsRaw = doc['limits'];
  if (limitsRaw !== undefined && limitsRaw !== null && !isPlainObject(limitsRaw)) {
    throw new PolicyError('"limits" must be a map');
  }
  const limitsObj = isPlainObject(limitsRaw) ? limitsRaw : {};
  assertNoUnknownKeys(limitsObj, LIMIT_KEYS, 'limits');

  const limits: PolicyLimits = {
    maxNotionalUsdPerOrder: readNumberOrNull(limitsObj['maxNotionalUsdPerOrder'], 'limits.maxNotionalUsdPerOrder'),
    maxDailyNotionalUsd: readNumberOrNull(limitsObj['maxDailyNotionalUsd'], 'limits.maxDailyNotionalUsd'),
    maxOpenNotionalUsd: readNumberOrNull(limitsObj['maxOpenNotionalUsd'], 'limits.maxOpenNotionalUsd'),
    maxLeverage: readNumberOrNull(limitsObj['maxLeverage'], 'limits.maxLeverage'),
    maxDailyLossUsd: readNumberOrNull(limitsObj['maxDailyLossUsd'], 'limits.maxDailyLossUsd'),
    maxDrawdownPct: readNumberOrNull(limitsObj['maxDrawdownPct'], 'limits.maxDrawdownPct', { max: 100 }),
    maxOrdersPerMinute: readNumberOrNull(limitsObj['maxOrdersPerMinute'], 'limits.maxOrdersPerMinute'),
    maxOrdersPerHour: readNumberOrNull(limitsObj['maxOrdersPerHour'], 'limits.maxOrdersPerHour'),
    maxPositionsOpen: readNumberOrNull(limitsObj['maxPositionsOpen'], 'limits.maxPositionsOpen'),
    maxPositionSnapshotAgeSec: readNumberOrNull(limitsObj['maxPositionSnapshotAgeSec'], 'limits.maxPositionSnapshotAgeSec'),
  };

  const guardsRaw = doc['guards'];
  if (guardsRaw !== undefined && guardsRaw !== null && !isPlainObject(guardsRaw)) {
    throw new PolicyError('"guards" must be a map');
  }
  const guardsObj = isPlainObject(guardsRaw) ? guardsRaw : {};
  assertNoUnknownKeys(guardsObj, GUARD_KEYS, 'guards');

  const guards: PolicyGuards = {
    priceDeviationPct: readNumberOrNull(guardsObj['priceDeviationPct'], 'guards.priceDeviationPct', { max: 100 }),
    minAccountEquityUsd: readNumberOrNull(guardsObj['minAccountEquityUsd'], 'guards.minAccountEquityUsd'),
    requireStopLoss: readBoolean(guardsObj['requireStopLoss'], 'guards.requireStopLoss', DEFAULT_POLICY.guards.requireStopLoss),
    tradingHoursUtc: readTradingHours(guardsObj['tradingHoursUtc']),
    cooldownSecondsAfterLoss: readNumberOrNull(guardsObj['cooldownSecondsAfterLoss'], 'guards.cooldownSecondsAfterLoss'),
    reviewAboveNotionalUsd: readNumberOrNull(guardsObj['reviewAboveNotionalUsd'], 'guards.reviewAboveNotionalUsd'),
    blockDuplicateActionIds: readBoolean(
      guardsObj['blockDuplicateActionIds'],
      'guards.blockDuplicateActionIds',
      DEFAULT_POLICY.guards.blockDuplicateActionIds,
    ),
    maxStopDistancePct: readNumberOrNull(guardsObj['maxStopDistancePct'], 'guards.maxStopDistancePct', { max: 100 }),
  };

  return {
    version: 1,
    name: name.trim(),
    mode: modeRaw as PolicyMode,
    default: defaultRaw,
    limits,
    allow: readAccess(doc['allow'], 'allow'),
    deny: readAccess(doc['deny'], 'deny'),
    guards,
  };
}

/** Read, parse and validate a policy file from disk. */
export function loadPolicyFile(path: string): Policy {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PolicyError(`cannot read policy file "${path}": ${(err as Error).message}`);
  }
  try {
    return loadPolicyFromString(raw);
  } catch (err) {
    throw new PolicyError(`in policy file "${path}": ${(err as Error).message}`);
  }
}
