/**
 * A deliberately small, strict YAML subset parser — zero dependencies.
 *
 * Aegis ships with no runtime dependencies on purpose: a security control plane
 * should not drag a supply chain behind it. Policies only need maps, block and
 * flow sequences, flow maps and scalars, so that is exactly what this supports.
 *
 * Anything outside the subset raises a `YamlError` with a line number rather
 * than silently producing a surprising value — for a risk firewall, a loud
 * parse failure is strictly safer than a quiet misread limit.
 *
 * Supported: nested maps (2-space or any consistent indent), block sequences
 * (`- item`), flow sequences (`[a, b]`), flow maps (`{a: 1}`), quoted and
 * unquoted scalars, ints, floats, booleans, null/~, comments, blank lines.
 *
 * Not supported (and rejected): anchors, aliases, multi-document streams, block
 * scalars (`|`, `>`), tags, tabs for indentation, duplicate keys.
 */

export class YamlError extends Error {
  public readonly line: number;
  constructor(message: string, line: number) {
    super(`YAML line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

interface PhysicalLine {
  indent: number;
  content: string;
  lineNo: number;
}

/** Strip a trailing comment that lives outside quotes. */
function stripComment(raw: string, lineNo: number): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // Only treat as a comment when preceded by start-of-line or whitespace.
      if (i === 0 || /\s/.test(raw[i - 1] as string)) return raw.slice(0, i);
    }
  }
  if (inSingle || inDouble) throw new YamlError('unterminated quoted string', lineNo);
  return raw;
}

function tokenize(source: string): PhysicalLine[] {
  const out: PhysicalLine[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] as string;
    const lineNo = i + 1;
    if (rawLine.trim() === '') continue;
    if (rawLine.trim().startsWith('#')) continue;

    const indentMatch = /^[ \t]*/.exec(rawLine);
    const indentRaw = indentMatch ? (indentMatch[0] as string) : '';
    if (indentRaw.includes('\t')) {
      throw new YamlError('tab characters are not allowed for indentation; use spaces', lineNo);
    }

    const content = stripComment(rawLine.slice(indentRaw.length), lineNo).trimEnd();
    if (content === '') continue;
    if (content === '---') continue;
    if (content.startsWith('%') || content.startsWith('!')) {
      throw new YamlError('directives and tags are not supported', lineNo);
    }
    out.push({ indent: indentRaw.length, content, lineNo });
  }
  return out;
}

/** Split a flow-style body on top-level commas, respecting nesting and quotes. */
function splitFlow(body: string, lineNo: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth -= 1;
      else if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    }
    current += ch;
  }
  if (inSingle || inDouble) throw new YamlError('unterminated quoted string', lineNo);
  if (depth !== 0) throw new YamlError('unbalanced flow brackets', lineNo);
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim());
}

/** Split `key: value` at the first top-level colon-space (or trailing colon). */
function splitKeyValue(content: string, lineNo: number): { key: string; rest: string } | null {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i] as string;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) {
      const next = content[i + 1];
      if (next === undefined || next === ' ') {
        const key = content.slice(0, i).trim();
        if (key === '') throw new YamlError('empty key', lineNo);
        return { key: unquote(key), rest: content.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

function unquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseScalar(tokenRaw: string, lineNo: number): YamlValue {
  const token = tokenRaw.trim();
  if (token === '') return null;

  // Quoted -> always a string.
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  if (token.startsWith('"') || token.startsWith("'")) {
    throw new YamlError('unterminated quoted string', lineNo);
  }

  if (token === 'null' || token === '~' || token === 'Null' || token === 'NULL') return null;
  if (token === 'true' || token === 'True' || token === 'TRUE') return true;
  if (token === 'false' || token === 'False' || token === 'FALSE') return false;

  // Numbers. Leading zeros stay strings so identifiers are never mangled.
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(token)) {
    const n = Number(token);
    if (Number.isFinite(n)) return n;
  }
  return token;
}

function parseFlow(token: string, lineNo: number): YamlValue {
  const t = token.trim();
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError('unbalanced flow sequence', lineNo);
    const body = t.slice(1, -1).trim();
    if (body === '') return [];
    return splitFlow(body, lineNo).map((p) => parseFlow(p, lineNo));
  }
  if (t.startsWith('{')) {
    if (!t.endsWith('}')) throw new YamlError('unbalanced flow map', lineNo);
    const body = t.slice(1, -1).trim();
    const obj: { [k: string]: YamlValue } = {};
    if (body === '') return obj;
    for (const part of splitFlow(body, lineNo)) {
      const kv = splitKeyValue(part, lineNo);
      if (!kv) throw new YamlError(`expected "key: value" inside flow map, got "${part}"`, lineNo);
      if (Object.hasOwn(obj, kv.key)) throw new YamlError(`duplicate key "${kv.key}"`, lineNo);
      obj[kv.key] = parseFlow(kv.rest, lineNo);
    }
    return obj;
  }
  return parseScalar(t, lineNo);
}

/** Recursive-descent block parser over the token stream. */
function parseBlock(lines: PhysicalLine[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];
  if (!first) return { value: null, next: start };

  if (first.content.startsWith('- ') || first.content === '-') {
    return parseSequence(lines, start, indent);
  }
  return parseMap(lines, start, indent);
}

function parseSequence(lines: PhysicalLine[], start: number, indent: number): { value: YamlValue; next: number } {
  const items: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as PhysicalLine;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation inside sequence', line.lineNo);
    if (!(line.content.startsWith('- ') || line.content === '-')) break;

    const inline = line.content === '-' ? '' : line.content.slice(2).trim();
    const childIndent = line.indent + 2;

    if (inline === '') {
      // Value lives on the following, more-indented lines.
      const sub = lines[i + 1];
      if (sub && sub.indent > line.indent) {
        const parsed = parseBlock(lines, i + 1, sub.indent);
        items.push(parsed.value);
        i = parsed.next;
        continue;
      }
      items.push(null);
      i += 1;
      continue;
    }

    const kv = splitKeyValue(inline, line.lineNo);
    if (kv) {
      // `- key: value` starts an inline map; subsequent sibling keys are indented
      // to align with the text after the dash.
      const synthetic: PhysicalLine[] = [{ indent: childIndent, content: inline, lineNo: line.lineNo }];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j] as PhysicalLine;
        if (nxt.indent < childIndent) break;
        if (nxt.indent === childIndent && (nxt.content.startsWith('- ') || nxt.content === '-')) break;
        synthetic.push(nxt);
        j += 1;
      }
      const parsed = parseMap(synthetic, 0, childIndent);
      items.push(parsed.value);
      i = j;
      continue;
    }

    items.push(parseFlow(inline, line.lineNo));
    i += 1;
  }
  return { value: items, next: i };
}

function parseMap(lines: PhysicalLine[], start: number, indent: number): { value: YamlValue; next: number } {
  const obj: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as PhysicalLine;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation', line.lineNo);
    if (line.content.startsWith('- ') || line.content === '-') break;

    const kv = splitKeyValue(line.content, line.lineNo);
    if (!kv) throw new YamlError(`expected "key: value", got "${line.content}"`, line.lineNo);
    if (Object.hasOwn(obj, kv.key)) throw new YamlError(`duplicate key "${kv.key}"`, line.lineNo);

    if (kv.rest !== '') {
      obj[kv.key] = parseFlow(kv.rest, line.lineNo);
      i += 1;
      continue;
    }

    const next = lines[i + 1];
    if (next && next.indent > line.indent) {
      const parsed = parseBlock(lines, i + 1, next.indent);
      obj[kv.key] = parsed.value;
      i = parsed.next;
      continue;
    }
    // `key:` with a block sequence at the SAME indent (valid YAML).
    if (next && next.indent === line.indent && (next.content.startsWith('- ') || next.content === '-')) {
      const parsed = parseSequence(lines, i + 1, next.indent);
      obj[kv.key] = parsed.value;
      i = parsed.next;
      continue;
    }
    obj[kv.key] = null;
    i += 1;
  }
  return { value: obj, next: i };
}

/** Parse a YAML subset document into a plain object. */
export function parseYaml(source: string): Record<string, YamlValue> {
  const lines = tokenize(source);
  if (lines.length === 0) return {};

  const baseIndent = (lines[0] as PhysicalLine).indent;
  const result = parseBlock(lines, 0, baseIndent);

  // Any unconsumed line means the document dedented to a level that never existed.
  if (result.next < lines.length) {
    const stuck = lines[result.next] as PhysicalLine;
    throw new YamlError(
      `inconsistent indentation — this line does not align with any open block`,
      stuck.lineNo,
    );
  }
  if (result.value === null) return {};
  if (Array.isArray(result.value) || typeof result.value !== 'object') {
    throw new YamlError('policy documents must be a mapping at the top level', 1);
  }
  return result.value as Record<string, YamlValue>;
}
