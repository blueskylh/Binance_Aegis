/**
 * The single source of truth for the version string.
 *
 * v2.0.0 shipped with `2.0.0` in the commit message and README while
 * package.json, the CLI, the MCP handshake and the skill manifest all still said
 * `1.0.0`. Not a security issue, but for a release that is largely *about*
 * rigour it reads badly. One constant, imported everywhere.
 */
export const VERSION = '2.2.0';
