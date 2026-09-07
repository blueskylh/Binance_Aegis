/** Terminal formatting helpers. Colour is disabled when stdout is not a TTY or NO_COLOR is set. */

const enabled = process.stdout.isTTY === true && !process.env['NO_COLOR'];

const wrap = (code: string) => (s: string): string => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');

export function verdictBadge(verdict: string): string {
  switch (verdict) {
    case 'allow': return green('✅ ALLOW ');
    case 'review': return yellow('⚠️  REVIEW');
    case 'deny': return red('⛔ DENY  ');
    default: return verdict;
  }
}

export function severityDot(severity: string): string {
  switch (severity) {
    case 'critical': return red('●');
    case 'warn': return yellow('●');
    default: return dim('●');
  }
}

/** Render a simple aligned table. */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      const len = stripAnsi(cell).length;
      if (widths[i] === undefined || len > (widths[i] as number)) widths[i] = len;
    });
  }
  const line = (row: string[], styler: (s: string) => string = (s) => s): string =>
    row.map((cell, i) => styler(cell) + ' '.repeat(Math.max(0, (widths[i] ?? 0) - stripAnsi(cell).length))).join('  ');

  const out: string[] = [];
  if (headers) {
    out.push(line(headers, bold));
    out.push(dim(widths.map((w) => '─'.repeat(w ?? 0)).join('  ')));
  }
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function usd(n: number): string {
  return `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Horizontal bar for budget consumption. */
export function bar(pct: number | null, width = 18): string {
  if (pct === null) return dim('— no limit set —');
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const body = '█'.repeat(filled) + '░'.repeat(width - filled);
  const colour = clamped >= 90 ? red : clamped >= 70 ? yellow : green;
  return `${colour(body)} ${String(Math.round(clamped))}%`;
}
