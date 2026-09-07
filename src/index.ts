/** Public library surface. */
export { Aegis, DEFAULT_POLICY_YAML, defaultDataDir, type AegisOptions, type GuardResult } from './aegis.js';
export { evaluate, aggregate, RULES } from './core/engine.js';
export { normalizeAction, isRiskReducing, NormalizationError } from './core/normalize.js';
export { loadPolicyFile, loadPolicyFromString, PolicyError, DEFAULT_POLICY } from './policy/schema.js';
export { parseYaml, YamlError } from './policy/yaml.js';
export { Ledger, GENESIS_HASH, canonicalize, type VerifyResult } from './ledger/ledger.js';
export { RiskStore, utcDayStart } from './state/store.js';
export { BinanceAdapter } from './adapters/binance.js';
export { Guardian } from './guardian/loop.js';
export { assessBreakers, type Breach, type GuardianSnapshot } from './guardian/breakers.js';
export { createHandler, TOOLS, PROTOCOL_VERSION } from './mcp/handler.js';
export type * from './types.js';
