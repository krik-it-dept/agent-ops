// plan-edit finds and replaces the value of a plan's top Status line on the
// raw file bytes. It is the only plan content Agent Ops may change (the owner's
// Mark as Done). Every other byte stays as it was: the BOM, line endings,
// spacing around the value, invalid UTF-8 elsewhere and the rest of the file.
//
// The top Status line is the one the plan reader uses as the plan's stage
// (src/main/modules/plans/parse.ts): the first `Status:` header line, matched
// case-insensitively after trimming, before the first level-2 to level-4
// heading, outside fenced code. Unlike the reader, editing requires the
// English `Status:` label; a legacy `Trạng thái:` line is never changed.

const LABELS = ['Status'] as const;

/** StatusSpan is the byte range of the Status value inside the file. */
export interface StatusSpan {
  /** Offset of the first value byte (after the colon and its spaces). */
  start: number;
  /** Offset just past the last value byte (before trailing spaces, CR and LF). */
  end: number;
  /** The current value as text. */
  value: string;
}

const BOM = [0xef, 0xbb, 0xbf];

interface Line {
  /** Offset of the first byte of the line content. */
  start: number;
  /** Offset just past the content, before CR LF or LF. */
  end: number;
}

function lines(bytes: Uint8Array): Line[] {
  const out: Line[] = [];
  let start =
    bytes.length >= 3 && BOM.every((b, i) => bytes[i] === b) ? BOM.length : 0;
  for (;;) {
    let nl = start;
    while (nl < bytes.length && bytes[nl] !== 0x0a) nl++;
    let end = nl;
    if (end > start && bytes[end - 1] === 0x0d) end--;
    out.push({ start, end });
    if (nl >= bytes.length) return out;
    start = nl + 1;
  }
}

/**
 * findStatus returns the span of the top Status value, or null when the plan
 * has no Status line in its header. A line whose bytes are not valid UTF-8 is
 * never treated as the Status line.
 */
export function findStatus(bytes: Uint8Array): StatusSpan | null {
  const found = new Map<string, StatusSpan>();
  let fence = '';
  for (const line of lines(bytes)) {
    const raw = Buffer.from(bytes.subarray(line.start, line.end));
    const text = raw.toString('utf8');
    const l = text.trim();
    const f = /^(`{3,}|~{3,})/.exec(l)?.[1];
    if (f) {
      if (!fence) fence = f;
      else if (
        f[0] === fence[0] &&
        f.length >= fence.length &&
        l.slice(f.length).trim() === ''
      )
        fence = '';
      continue;
    }
    if (fence) continue;
    // The reader's header ends at a milestone, Decisions or Questions heading,
    // or any heading of level 2 to 4.
    if (
      /^#{2,4}\s*(M\d+[a-z]?)\s*[:.\-–]/is.test(l) ||
      /^#{2,4}\s*(decisions|questions)\b/i.test(l) ||
      (/^#{1,4}\s/.test(l) && !l.startsWith('# ') && !l.startsWith('#\t'))
    )
      break;
    if (/^#{1,4}\s/.test(l)) continue;
    // Byte offsets below are only exact for a line that decodes losslessly.
    if (!Buffer.from(text, 'utf8').equals(raw)) continue;
    for (const label of LABELS) {
      if (found.has(label)) continue;
      if (!l.toLowerCase().startsWith(`${label.toLowerCase()}:`)) continue;
      const lead = text.length - text.trimStart().length;
      const afterColon = text.slice(lead + label.length + 1);
      const leading = afterColon.length - afterColon.trimStart().length;
      const value = afterColon.trim();
      const start =
        line.start +
        Buffer.byteLength(text.slice(0, lead + label.length + 1 + leading));
      const end = start + Buffer.byteLength(value);
      found.set(label, { start, end, value });
    }
  }
  for (const label of LABELS) {
    const span = found.get(label);
    if (span) return span;
  }
  return null;
}

/** isDone reports a Status value whose stage (before " - ") is Done. */
export function isDone(value: string): boolean {
  const i = value.indexOf(' - ');
  return (i > 0 ? value.slice(0, i) : value).trim().toLowerCase() === 'done';
}

/**
 * replaceStatus returns the bytes with the value of span replaced. A bare
 * `Status:` with nothing after the colon gets one space before the new value.
 */
export function replaceStatus(
  bytes: Uint8Array,
  span: Pick<StatusSpan, 'start' | 'end'>,
  value: string | Uint8Array,
): Buffer {
  const next =
    typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const bare =
    span.start === span.end &&
    span.start > 0 &&
    bytes[span.start - 1] === 0x3a &&
    next.length > 0;
  return Buffer.concat([
    bytes.subarray(0, span.start),
    bare ? Buffer.from(' ') : Buffer.alloc(0),
    next,
    bytes.subarray(span.end),
  ]);
}
