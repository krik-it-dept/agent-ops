// Version rules: only stable MAJOR.MINOR.PATCH versions take part in updates.
// A development build (0.0.0, x.y.z-dev.N, any prerelease) is never offered an
// update and never offered as one.

const STABLE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isStableVersion(version: string): boolean {
  return STABLE.test(version) && tagOf(version) !== 'v0.0.0';
}

/** The tag form used in the DTO and on GitHub: v1.2.3. */
export function tagOf(version: string): string {
  const v = version.trim();
  return v.startsWith('v') ? v : `v${v}`;
}

function parts(version: string): [number, number, number] | null {
  const m = STABLE.exec(version.trim());
  if (!m) {
    return null;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a > b for stable versions; false when either is not stable. */
export function isNewer(a: string, b: string): boolean {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return (pa[i] ?? 0) > (pb[i] ?? 0);
    }
  }
  return false;
}

/** Whether this build checks for updates at all. */
export function updatesAllowed(options: {
  packaged: boolean;
  version: string;
}): boolean {
  return options.packaged && isStableVersion(options.version);
}

const MAX_NOTES = 16_000;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Release notes as plain text: tags removed, entities decoded, bounded. */
export function notesToText(notes: string): string {
  const text = notes
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) {
        const n = Number.parseInt(code.slice(2), 16);
        return Number.isFinite(n) && n <= 0x10ffff
          ? String.fromCodePoint(n)
          : '';
      }
      if (code.startsWith('#')) {
        const n = Number.parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n <= 0x10ffff
          ? String.fromCodePoint(n)
          : '';
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES)}…` : text;
}
