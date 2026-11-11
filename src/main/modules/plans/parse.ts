import { createHash } from 'node:crypto';
import { agentList, canonicalAgent } from './agents';

export type StepStatus = 'todo' | 'doing' | 'done' | 'partial' | 'blocked';
export interface ParsedStep {
  status: StepStatus;
  text: string;
  line: number;
  /** Canonical names from a trailing `<!-- Executors: A, B -->` comment; absent when none. */
  executors?: string[];
}
export interface ParsedMilestone {
  id: string;
  title: string;
  state: StepStatus | '';
  summary: string;
  steps: ParsedStep[];
}
export interface ParsedPlan {
  revision: string;
  owner: string;
  goal: string;
  spec: string;
  next: string;
  label: string;
  /** The coordinating agent from the `Agent:` header, canonical; '' when absent or not a valid name. */
  agent: string;
  steps: ParsedStep[];
  milestones: ParsedMilestone[];
  decisions: string[];
  questions: { ask: string; answer: string; open: boolean }[];
  invalidUTF8: boolean;
  unclosedFence: number;
}

const marks: [string, StepStatus][] = [
  ['⬜', 'todo'],
  ['🔄', 'doing'],
  ['✅', 'done'],
  ['⚠', 'partial'],
  ['❌', 'blocked'],
];
const fields = {
  owner: ['Owner'],
  goal: ['Goal'],
  spec: ['Spec'],
  next: ['Next', 'Tiếp theo'],
  label: ['Status', 'Trạng thái'],
  agent: ['Agent'],
} as const;

export function stripEstimates(text: string): string {
  return text.replace(
    /\s*~\s*\d+(?:[.,]\d+)?\s*(p|ph|phút|m|min|h|g|giờ|d|ngày)(?![\p{L}])/giu,
    '',
  );
}

// Go's strings.ToValidUTF8 replaces a run of invalid bytes once, whereas
// Buffer.toString replaces individual malformed sequences. Preserve Go's rule.
function decode(source: Uint8Array): { text: string; invalid: boolean } {
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        source,
      ),
      invalid: false,
    };
  } catch {
    /* Fall back to Go-compatible replacement of invalid byte runs. */
  }
  let text = '',
    bad = false,
    invalid = false;
  for (let i = 0; i < source.length;) {
    const first = source[i]!;
    let n =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
    if (i + n > source.length) n = 0;
    for (let j = 1; j < n; j++) {
      const b = source[i + j]!;
      if (b < 0x80 || b > 0xbf) {
        n = 0;
        break;
      }
    }
    if (
      (first === 0xe0 && source[i + 1]! < 0xa0) ||
      (first === 0xed && source[i + 1]! >= 0xa0) ||
      (first === 0xf0 && source[i + 1]! < 0x90) ||
      (first === 0xf4 && source[i + 1]! >= 0x90)
    )
      n = 0;
    if (!n) {
      if (!bad) text += '�';
      bad = invalid = true;
      i++;
    } else {
      text += Buffer.from(source.subarray(i, i + n)).toString('utf8');
      bad = false;
      i += n;
    }
  }
  return { text, invalid };
}

/**
 * Read Markdown without I/O. Unknown lines and the retired `Executor:` header are ignored.
 * The step comment `<!-- Executors: ... -->` is metadata: it is removed from the step text,
 * so it never changes a step's identity.
 */
export function parseMarkdown(source: string | Uint8Array): ParsedPlan {
  const bytes = typeof source === 'string' ? Buffer.from(source) : source;
  const decoded = decode(bytes);
  const p: ParsedPlan = {
    revision: createHash('sha256').update(bytes).digest('hex'),
    owner: '',
    goal: '',
    spec: '',
    next: '',
    label: '',
    agent: '',
    steps: [],
    milestones: [],
    decisions: [],
    questions: [],
    invalidUTF8: decoded.invalid,
    unclosedFence: 0,
  };
  const header = new Map<string, string>();
  let inHeader = true,
    section = '',
    fence = '',
    fenceLine = 0;
  let milestone: ParsedMilestone | undefined;
  const lines = decoded.text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const l = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(l)?.[1];
    if (f) {
      if (!fence) {
        fence = f;
        fenceLine = index + 1;
      } else if (
        f[0] === fence[0] &&
        f.length >= fence.length &&
        l.slice(f.length).trim() === ''
      ) {
        fence = '';
        fenceLine = 0;
      }
      continue;
    }
    if (fence) continue;
    // The s flag makes "." match CR and U+2028/U+2029 inside a line, like Go's regexp.
    const head =
      /^#{2,4}\s*(M\d+[a-z]?)\s*[:.\-–]\s*(.*?)\s*(?:\[(todo|doing|done|partial|blocked)\])?\s*$/is.exec(
        l,
      );
    if (head) {
      inHeader = false;
      section = '';
      milestone = {
        id: head[1]!.toUpperCase(),
        title: head[2]!,
        state: (head[3]?.toLowerCase() ?? '') as StepStatus | '',
        summary: '',
        steps: [],
      };
      p.milestones.push(milestone);
      continue;
    }
    if (/^#{2,4}\s*decisions\b/i.test(l) || /^#{2,4}\s*questions\b/i.test(l)) {
      inHeader = false;
      section = /^#{2,4}\s*decisions\b/i.test(l) ? 'decisions' : 'questions';
      milestone = undefined;
      continue;
    }
    if (/^#{1,4}\s/.test(l)) {
      if (!l.startsWith('# ') && !l.startsWith('#\t')) inHeader = false;
      section = '';
      milestone = undefined;
      continue;
    }
    if (inHeader) {
      for (const keys of Object.values(fields))
        for (const key of keys) {
          if (
            !header.has(key) &&
            l.toLowerCase().startsWith(`${key.toLowerCase()}:`)
          ) {
            header.set(key, l.slice(key.length + 1).trim());
          }
        }
    }
    const item = /^[-*]\s+(.+)$/s.exec(l)?.[1];
    if (section === 'questions') {
      if (item !== undefined) {
        const [ask = '', ...rest] = item.split(/\s*\|\s*answer\s*:\s*/i);
        const answer = rest.join(' ').trim();
        p.questions.push({
          ask: ask.trim(),
          answer,
          open: !answer || /^open\b/i.test(answer),
        });
      }
      continue;
    }
    if (section === 'decisions') {
      if (item !== undefined) p.decisions.push(item);
      else if (l && p.decisions.length)
        p.decisions[p.decisions.length - 1] += ` ${l}`;
      continue;
    }
    if (milestone && /^summary:/i.test(l)) {
      milestone.summary = l.slice(8).trim();
      continue;
    }
    const word =
      /^(?:[-*]\s*)?\[(todo|doing|done|partial|blocked)\]\s*(.*)$/is.exec(l);
    let status: StepStatus, text: string;
    if (word) {
      status = word[1]!.toLowerCase() as StepStatus;
      text = word[2]!;
    } else {
      const mark = marks.find(([m]) => l.startsWith(m));
      if (!mark) continue;
      status = mark[1];
      text = l
        .slice(mark[0].length)
        .replace(/^\s*\uFE0F/, '')
        .trim();
    }
    let executors: string[] = [];
    text = text.replace(
      /\s*<!--\s*Executors?:\s*([^<>]*?)\s*-->\s*$/i,
      (_comment, names: string) => {
        executors = agentList(names);
        return '';
      },
    );
    const step: ParsedStep = {
      status,
      text: stripEstimates(text).trim(),
      line: index + 1,
    };
    if (executors.length) step.executors = executors;
    p.steps.push(step);
    milestone?.steps.push(step);
  }
  for (const [field, keys] of Object.entries(fields)) {
    p[field as keyof typeof fields] =
      keys.map((k) => header.get(k)).find((v) => v !== undefined) ?? '';
  }
  p.agent = canonicalAgent(p.agent) ?? '';
  p.unclosedFence = fence ? fenceLine : 0;
  return p;
}
