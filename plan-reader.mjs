import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {parseExecutors} from './execution-roles.mjs';
const STATUSES = ['⬜', '🔄', '✅', '⚠', '❌'];
const MARKERS = { todo: '⬜', doing: '🔄', done: '✅', partial: '⚠', blocked: '❌' };
const EST_RE = /\s*~\s*\d+(?:[.,]\d+)?\s*(p|ph|phút|m|min|h|g|giờ|d|ngày)(?![\p{L}])/iu;
export function readPlan(file) {
  const source = readFileSync(file);
  const revision = createHash('sha256').update(source).digest('hex');
  const lines = source.toString('utf8').split(/\r?\n/);
  const field = (...keys) => {
    for (const key of keys) {
      const l = lines.find((x) => x.trim().toLowerCase().startsWith(`${key.toLowerCase()}:`));
      if (l) return l.trim().slice(key.length + 1).trim();
    }
    return '';
  };
  const points = [];
  const milestones = [];
  const decisions = [];
  const questions = [];
  let ms = null;
  let inDecisions = false;
  let inQuestions = false;
  let fence = '';
  for (const [lineIndex,raw] of lines.entries()) {
    const l = raw.trim();
    const fenced=l.match(/^(`{3,}|~{3,})/);
    if(fenced){if(!fence)fence=fenced[1];else if(fenced[1][0]===fence[0] && fenced[1].length>=fence.length)fence='';continue;}
    if(fence)continue;
    const head = l.match(/^#{2,4}\s*(M\d+[a-z]?)\s*[:.\-–]\s*(.*?)\s*(?:\[(todo|doing|done|partial|blocked)\])?\s*$/i);
    if (head) {
      ms = { id: head[1].toUpperCase(), title: head[2], state: (head[3] || '').toLowerCase(), summary: '', points: [] };
      milestones.push(ms);
      inDecisions = false;
      inQuestions = false;
      continue;
    }
    if (/^#{2,4}\s*decisions\b/i.test(l)) {
      inDecisions = true;
      inQuestions = false;
      ms = null;
      continue;
    }
    if (/^#{2,4}\s*questions\b/i.test(l)) {
      inQuestions = true;
      inDecisions = false;
      ms = null;
      continue;
    }
    if (/^#{1,4}\s/.test(l)) {
      inDecisions = false;
      inQuestions = false;
      ms = null;
      continue;
    }
    if (inQuestions) {
      const q = l.match(/^[-*]\s+(.+)$/);
      if (q) {
        const [ask, ...rest] = q[1].split(/\s*\|\s*answer\s*:\s*/i);
        const answer = rest.join(' ').trim();
        questions.push({ ask: ask.trim(), answer, open: !answer || /^open\b/i.test(answer) });
      }
      continue;
    }
    if (inDecisions) {
      const d = l.match(/^[-*]\s+(.+)$/);
      if (d) decisions.push(d[1]);
      else if (l && decisions.length) decisions[decisions.length - 1] += ' ' + l;
      continue;
    }
    if (ms && /^summary:/i.test(l)) {
      ms.summary = l.slice(8).trim();
      continue;
    }
    let status;
    let text;
    const m = l.match(/^(?:[-*]\s*)?\[(todo|doing|done|partial|blocked)\]\s*(.*)$/i);
    if (m) {
      status = MARKERS[m[1].toLowerCase()];
      text = m[2];
    } else {
      status = STATUSES.find((s) => l.startsWith(s));
      if (!status) continue;
      text = l.slice(status.length).replace(/^\s*\uFE0F/, '').trim();
    }
    const assignment=text.match(/\s*<!--\s*Executors?:\s*([^<>]*?)\s*-->\s*$/i);
    const executors=assignment?parseExecutors(assignment[1]):null;
    if(assignment)text=text.slice(0,assignment.index);
    const point = { status, text: text.replace(new RegExp(EST_RE.source, 'giu'), '').trim(), executors, line:lineIndex+1 };
    points.push(point);
    if (ms) ms.points.push(point);
  }
  return { revision, agentLabel: field('Agent'), executorLabel: field('Executor','Executors'), owner: field('Owner'), goal: field('Goal'), spec: field('Spec'), next: field('Next', 'Tiếp theo'), label: field('Status', 'Trạng thái'), points, milestones, decisions, questions, mtime: statSync(file).mtime };
}
