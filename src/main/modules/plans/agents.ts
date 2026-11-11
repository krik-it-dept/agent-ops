// Agent names as plans and run reports carry them. Known agents get one
// spelling; any other name is kept as written when it is short and plain.

export const KNOWN_AGENTS = [
  'Claude',
  'Codex',
  'Gemini',
  'Antigravity',
  'Cursor',
  'Copilot',
] as const;

const aliases: Readonly<Record<string, string>> = {
  ...Object.fromEntries(KNOWN_AGENTS.map((name) => [name.toLowerCase(), name])),
  anti: 'Antigravity',
};

export const MAX_AGENT_NAME = 40;

/**
 * canonicalAgent returns the canonical name, '' for "none" or an empty value,
 * and undefined for a name that is not plain (letters, digits, space, `.`,
 * `-`, `_`, starting with a letter or digit) or longer than 40 characters.
 * Inner spaces collapse to one.
 */
export function canonicalAgent(value: string): string | undefined {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name === '' || name.toLowerCase() === 'none') return '';
  const known = aliases[name.toLowerCase()];
  if (known) return known;
  if (
    Array.from(name).length > MAX_AGENT_NAME ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)
  )
    return undefined;
  return name;
}

/** agentList reads "A, B" into canonical names: invalid and repeated names are dropped, "none" gives none. */
export function agentList(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(',')) {
    const name = canonicalAgent(part);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
