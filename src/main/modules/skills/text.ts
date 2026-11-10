// Text helpers shared by the Skills actions: hashes, the skill version, the
// managed instruction block and the line diff.
//
// Client files are handled as bytes. Text operations decode them as latin1
// (one character per byte), so writing the result back reproduces every byte
// outside the managed markers exactly, even in a file that is not valid UTF-8.
// The markers and the instruction line are ASCII, so finding them is unaffected.

import { createHash } from 'node:crypto';

export const INSTRUCTION_START = '<!-- agent-ops:start -->';
export const INSTRUCTION_END = '<!-- agent-ops:end -->';
export const INSTRUCTION_LINE =
  'For substantial work, keep a plan with the task-plan skill in the Agent Ops Tasks folder (`AGENT_OPS_TASKS`).';

/** The managed block with LF line endings, markers included. */
export function instructionBlock(): string {
  return `${INSTRUCTION_START}\n${INSTRUCTION_LINE}\n${INSTRUCTION_END}`;
}

/** Bytes as a lossless one-character-per-byte string. */
export function byteText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'latin1',
  );
}

/** The inverse of byteText. */
export function textBytes(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

/** Line endings normalised to LF, for comparisons and hashes. */
export function lfText(bytes: Uint8Array): string {
  return byteText(bytes).replaceAll('\r\n', '\n');
}

export function sha256Hex(data: Uint8Array | string): string {
  const input = typeof data === 'string' ? textBytes(data) : data;
  return createHash('sha256').update(input).digest('hex');
}

/** The hash recorded for a skill or block: SHA-256 of its LF text. */
export function contentHash(bytes: Uint8Array): string {
  return sha256Hex(lfText(bytes));
}

export function bytesEqual(
  a: Uint8Array | null,
  b: Uint8Array | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return Buffer.compare(a, b) === 0;
}

const SKILL_VERSION_LINE = /^agent-ops-skill:\s*(\d+)\s*$/m;

/** Reads "agent-ops-skill: N" from the front matter; 0 when absent. */
export function skillVersionOf(bytes: Uint8Array): number {
  const text = lfText(bytes);
  if (!text.startsWith('---\n')) {
    return 0;
  }
  const end = text.indexOf('\n---', 4);
  if (end < 0) {
    return 0;
  }
  const match = SKILL_VERSION_LINE.exec(text.slice(4, end));
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

export interface BlockLocation {
  /** Index of the start marker, -1 when absent. */
  start: number;
  /** Index just after the end marker. */
  end: number;
  found: boolean;
  /** False for an incomplete or reversed pair, or more than one block. */
  ok: boolean;
}

/** Locates the start..end markers. */
export function findBlock(
  text: string,
  start: string,
  end: string,
): BlockLocation {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 && b < 0) {
    return { start: -1, end: -1, found: false, ok: true };
  }
  if (
    a < 0 ||
    b < 0 ||
    b < a ||
    count(text, start) > 1 ||
    count(text, end) > 1
  ) {
    return { start: a, end: b, found: true, ok: false };
  }
  return { start: a, end: b + end.length, found: true, ok: true };
}

/**
 * Deletes the text between a and b (a marked block) with its line break. When
 * the block ends the file, the blank lines before it (the separator added when
 * the block was appended) go too; that is the only text outside the markers it
 * changes.
 */
export function removeBlock(text: string, a: number, b: number): string {
  const before = text.slice(0, a);
  let after = text.slice(b);
  if (after.startsWith('\r\n')) {
    after = after.slice(2);
  } else if (after.startsWith('\n')) {
    after = after.slice(1);
  }
  if (isBlank(after)) {
    const trimmed = before.replace(/[\r\n]+$/, '');
    if (trimmed === '') {
      return '';
    }
    const ending = before.slice(trimmed.length).includes('\r\n')
      ? '\r\n'
      : '\n';
    return trimmed + ending;
  }
  return before + after;
}

/** Only ASCII white space: a file is treated as empty only when it surely is. */
export function isBlank(text: string): boolean {
  return /^[ \t\n\v\f\r]*$/.test(text);
}

export interface DiffLine {
  /** " " unchanged, "-" on disk, "+" what Agent Ops would write. */
  op: ' ' | '-' | '+';
  text: string;
}

const MAX_DIFF_CELLS = 4_000_000;

/** A longest-common-subsequence line diff, bounded for large files. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const split = (s: string): string[] => {
    const lf = s.replaceAll('\r\n', '\n');
    const body = lf.endsWith('\n') ? lf.slice(0, -1) : lf;
    return body === '' ? [] : body.split('\n');
  };
  const a = split(oldText);
  const b = split(newText);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ op: '-', text })),
      ...b.map((text): DiffLine => ({ op: '+', text })),
    ];
  }
  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] ?? '';
    const right = b[j] ?? '';
    if (left === right) {
      out.push({ op: ' ', text: left });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ op: '-', text: left });
      i++;
    } else {
      out.push({ op: '+', text: right });
      j++;
    }
  }
  for (; i < a.length; i++) {
    out.push({ op: '-', text: a[i] ?? '' });
  }
  for (; j < b.length; j++) {
    out.push({ op: '+', text: b[j] ?? '' });
  }
  return out;
}
