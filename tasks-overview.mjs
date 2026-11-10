#!/usr/bin/env node
// Builds the cross-repo task overview from each configured project's .tasks/ folders.
// Next to the state file it writes:
//   tong-hop-chung.md    one line per plan (from each tong-hop.md)
//   tong-hop-chung.html  progress board (from each <plan>.md), opened via file:///
//   tong-hop-chung.json  machine-readable state for the Agent Ops app
// Plan sources are read-only; generated repository indexes and overview files are refreshed.
// Runs on demand or through the app's file watcher. No model, no tokens.
//
//   node tasks-overview.mjs [--repos-dir <folder>] [--state-file <file>]
//
// Projects come from Agent Ops config.json (AGENT_OPS_CONFIG, else the default data folder);
// see resolveSettings in plan-reader.mjs for precedence. A missing project is reported, never fatal.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {resolveSettings,projectRepos,readPlan} from './plan-reader.mjs';

function flags(args){
  const out={};
  for(let i=0;i<args.length;i++){
    const name=args[i].replace(/^--/,'');
    // --slots-file is still accepted from older launchers and ignored: slots are retired.
    if(!args[i].startsWith('--') || !['repos-dir','state-file','slots-file'].includes(name) || !args[i+1])throw Error('Usage: node tasks-overview.mjs [--repos-dir <folder>] [--state-file <file>]');
    if(name==='slots-file'){i++;continue;}
    out[name]=args[++i];
  }
  return out;
}
const SETTINGS = resolveSettings(flags(process.argv.slice(2)));
const STATE_FILE = SETTINGS.stateFile;
const OUT_DIR = dirname(STATE_FILE);
mkdirSync(OUT_DIR, { recursive: true });
const STATUSES = ['⬜', '🔄', '✅', '⚠', '❌'];
const RELOAD_SECONDS = 600;

// Index lines only: skip blanks, headings and the "(chưa có plan …)" placeholder.
const indexLines = (file) =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^-\s+/, ''))
    .filter((l) => l && !l.startsWith('#') && !/^\(.*\)$/.test(l));

// Plan format (see ~/.claude/CLAUDE.md): "Next:", "Status:", then "- [todo|doing|done|partial|blocked] step ~2h".
// The older emoji format ("Tiếp theo:", "Trạng thái:", status emoji at line start) is still read for older plans.

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*:\s*/;
function stamped(text, i) {
  const m = text.match(STAMP_RE);
  if (!m) return { key: '', when: '', text, i };
  const key = `${m[1]}${m[2]}${m[3]}${m[4] ? m[4].padStart(2, '0') + m[5] : '9999'}`;
  return { key, when: `${m[3]}/${m[2]}${m[4] ? ' ' + m[4].padStart(2, '0') + ':' + m[5] : ''}`, text: text.slice(m[0].length), i };
}
const newestFirst = (list) => list.map(stamped).sort((a, b) => (b.key > a.key ? 1 : b.key < a.key ? -1 : b.i - a.i));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ago = (d) => {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const repos = [];
const projectStates = [];
for (const project of SETTINGS.projects) {
  const result = { id: project.id, name: project.name || project.path, path: project.path, kind: project.kind, status: 'ok', message: '', repos: 0, plans: 0 };
  projectStates.push(result);
  let found;
  try { found = projectRepos(project); }
  catch (error) {
    // A project folder that cannot be opened at all (missing, unplugged or offline
    // drive, network share, no permission, now a file) is a warning, so one
    // unreachable project never fails the board or an update health check.
    // Failures inside a readable project still stop the refresh.
    result.status = 'missing';
    result.message = error.code === 'ENOENT' ? 'Folder not found.' : 'Folder cannot be opened ('+(error.code || error.message)+').';
    continue;
  }
  result.repos = found.length;
  for (const { name, root } of found) {
  const dir = join(root, '.tasks');
  const index = join(dir, 'tong-hop.md');
  const plans = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== 'tong-hop.md')
        .map((f) => ({ project: project.id, projectName: result.name, repo: name, root: root.replace(/\\/g, '/'), name: f.slice(0, -3), ...readPlan(join(dir, f)) }))
    : [];
  let gh = '';
  try {
    if (!existsSync(join(root, '.git'))) throw new Error('No Git metadata');
    const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) gh = 'https://github.com/' + m[1];
  } catch { /* A missing Git remote only disables links; task collection remains available. */ }
  const lines = plans.map((p) => {
    const c = (k) => p.points.filter((x) => x.status === k).length;
    const extra = [c('🔄') && `${c('🔄')} doing`, c('❌') && `${c('❌')} blocked`].filter(Boolean).join(', ');
    return `${p.name} | ${p.label || '-'} | ${c('✅')}/${p.points.length} done${extra ? ', ' + extra : ''} | Next: ${p.next || '-'}`;
  });
  if (existsSync(dir)) {
    writeFileSync(index, `# Task index (generated by tasks-overview.mjs from the plan files; do not edit)\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
  }
  result.plans += plans.length;
  repos.push({ project: project.id, projectName: result.name, name, gh, index: lines, plans });
  }
}

const linkPRs = (html, gh) => (gh ? html.replace(/#(\d+)\b/g, (m, n) => `<a class="pr" href="${gh}/pull/${n}" target="_blank">#${n}</a>`) : html);
const STALE_MIN = 120;
const ACTIVE = /^(planning|implementing|reviewing|fixing review|testing)$/i;

const stamp = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

// Markdown overview.
const md = repos.flatMap((r) => [
  `## ${SETTINGS.projects.length > 1 ? r.projectName + ' / ' : ''}${r.name}`,
  '',
  ...(r.index.length ? r.index.map((l) => `- ${l}`) : ['(no active plan)']),
  '',
]);
writeFileSync(
  join(OUT_DIR, 'tong-hop-chung.md'),
  `# Task overview (generated from each repo's .tasks/tong-hop.md, do not edit)\n\nUpdated: ${stamp}\n\n${md.join('\n')}`,
);

// ---------- HTML board ----------
// Fixed stages of the plan format: [name, tone, position on the main path (-1 = off the path)].
const STAGES = [
  ['Planning', 'doing', 0],
  ['Implementing', 'doing', 1],
  ['Reviewing', 'review', 2],
  ['Fixing review', 'review', 2],
  ['Testing', 'test', 3],
  ['Waiting for CI', 'test', 4],
  ['Dry run', 'test', 5],
  ['Waiting for owner', 'pending', -1],
  ['Shipping', 'doing', 5],
  ['Blocked', 'bad', -1],
  ['Done', 'ok', 6],
];
const PIPE = ['Plan', 'Code', 'Review', 'Test', 'CI', 'Ship', 'Done'];

// The agent's "Status:" stage wins; without one, derive a status from the steps.
function statusOf(p, count) {
  const label = p.label;
  const stage = label && STAGES.find(([n]) => label.toLowerCase().startsWith(n.toLowerCase()));
  if (stage) return { text: label, tone: stage[1], step: stage[2] };
  if (!label) {
    if (count['❌']) return { text: 'Blocked', tone: 'bad', step: -1 };
    if (p.points.length && count['✅'] === p.points.length) return { text: 'Done', tone: 'ok', step: 6 };
    if (count['🔄']) return { text: 'In progress', tone: 'doing', step: -1 };
    if (count['⚠']) return { text: 'Partly done', tone: 'pending', step: -1 };
    return { text: 'Not started', tone: 'idle', step: -1 };
  }
  // A free-text label from an older plan: colour it by keywords.
  const t = label.toLowerCase();
  const tone = /chặn|block|lỗi|fail/.test(t)
    ? 'bad'
    : /xong|done|merged|shipped/.test(t)
      ? 'ok'
      : /review/.test(t)
        ? 'review'
        : /wait|chờ|dở|owner|partial/.test(t)
          ? 'pending'
          : /test|\bci\b|build|dry/.test(t)
            ? 'test'
            : 'doing';
  return { text: label, tone, step: -1 };
}
const pipe = (step) =>
  step < 0
    ? ''
    : `<div class="pipe">${PIPE.map((n, i) => `<i class="${i < step ? 'past' : i === step ? 'cur' : ''}" title="${n}"></i>`).join('')}</div>`;

const plans = repos.flatMap((r) => r.plans).sort((a, b) => b.mtime - a.mtime);
const multiRepo = new Set(plans.map((p) => p.repo)).size > 1 || repos.filter((r) => r.plans.length).length > 1;
let sumDone = 0;
let sumTotal = 0;
const attention = [];
const waiting = [];
const repoGh = (p) => (repos.find((r) => r.project === p.project && r.name === p.repo) || {}).gh || '';
const allDecisions = [];
const summaries = [];
const decCards = [];

const rows = plans
  .map((p, i) => {
    const count = Object.fromEntries(STATUSES.map((s) => [s, p.points.filter((x) => x.status === s).length]));
    const total = p.points.length;
    const done = count['✅'];
    const pct = total ? Math.round((done / total) * 100) : 0;
    sumDone += done;
    sumTotal += total;
    const st = statusOf(p, count);
    for (const x of p.points.filter((y) => y.status === '❌')) attention.push({ plan: p.name, text: x.text, tone: 'bad' });
    const ageMin = Math.round((Date.now() - p.mtime.getTime()) / 60000);
    const stale = ACTIVE.test(st.text.split(' - ')[0]) && Date.now() - p.mtime.getTime() >= STALE_MIN * 60000;
    if (stale) attention.push({ plan: p.name, text: `Stale: no update for ${ago(p.mtime).replace(' ago', '')} while ${st.text.split(' - ')[0]}`, tone: 'bad' });
    if (/^waiting for owner/i.test(st.text)) waiting.push({ plan: p.name, text: st.text.replace(/^waiting for owner\s*-?\s*/i, '') || 'Waiting for your decision', gh: repoGh(p) });
    const key = `${p.project}/${p.repo}/${p.name}`;
    const stepHtml = (x) => {
        const cls = { '✅': 'done', '🔄': 'active', '⬜': 'pending', '⚠': 'warn', '❌': 'bad' }[x.status];
        const box = { '✅': '✓', '🔄': '↻', '⬜': '', '⚠': '!', '❌': '×' }[x.status];
        const pill = { '✅': 'Done', '🔄': 'Doing', '⬜': 'To do', '⚠': 'Partial', '❌': 'Blocked' }[x.status];
        return `<div class="task ${cls}"><span class="checkbox">${box}</span><span class="task-text">${esc(x.text)}</span><span class="task-pill ${cls}">${pill}</span></div>`;
    };
    const msState = (m) => {
      if (m.state) return m.state;
      const c = (k) => m.points.filter((x) => x.status === k).length;
      if (m.points.length && c('✅') === m.points.length) return 'done';
      if (c('❌')) return 'blocked';
      if (c('🔄') || c('✅')) return 'doing';
      return 'todo';
    };
    const PILL = { done: ['done', 'Done'], doing: ['active', 'Doing'], todo: ['pending', 'To do'], partial: ['warn', 'Partial'], blocked: ['bad', 'Blocked'] };
    const STEP_ORDER = { '🔄': 0, '❌': 1, '⚠': 2, '⬜': 3, '✅': 4 };
    const byRecency = (list) => list.map((x, i) => [x, i]).sort((a, b) => STEP_ORDER[a[0].status] - STEP_ORDER[b[0].status] || a[1] - b[1]).map(([x]) => x);
    const rank = (m) => {
      const stt = msState(m);
      return stt === 'done' ? 1 : stt === 'todo' ? 2 : 0;
    };
    const msOrdered = p.milestones
      .map((m, i) => [m, i])
      .sort((a, b) => rank(a[0]) - rank(b[0]) || (rank(a[0]) !== 2 ? b[1] - a[1] : a[1] - b[1]))
      .map(([m]) => m);
    const msHtml = msOrdered
      .map((m) => {
        const stt = msState(m);
        const md = m.points.filter((x) => x.status === '✅').length;
        const mp = m.points.length ? Math.round((md / m.points.length) * 100) : stt === 'done' ? 100 : 0;
        return `<section class="ms ms-${stt}"><div class="ms-head"><span class="ms-id">${esc(m.id)}</span><b>${esc(m.title)}</b><span class="task-pill ${PILL[stt][0]}">${PILL[stt][1]}</span><span class="ms-count">${md} / ${m.points.length}</span><span class="ms-bar"><i style="width:${mp}%"></i></span></div>${m.summary ? `<p class="ms-sum">${esc(m.summary)}</p>` : ''}<div class="tasks">${byRecency(m.points).map(stepHtml).join('')}</div></section>`;
      })
      .join('');
    const loose = p.points.filter((x) => !p.milestones.some((m) => m.points.includes(x)));
    const decHtml = p.decisions.length
      ? `<section class="decisions"><div class="block-title">Decisions <span>${p.decisions.length}</span></div><ol>${newestFirst(p.decisions).map((d) => `<li>${d.when ? `<span class="ddate">${d.when}</span>` : ''}${esc(d.text)}</li>`).join('')}</ol></section>`
      : '';
    const qHtml = p.questions.length
      ? `<section class="questions"><div class="block-title q">Questions <span>${p.questions.length}</span></div><ol>${newestFirst(p.questions.map((q) => q.ask))
          .map((x) => ({ ...p.questions[x.i], when: x.when, askText: x.text }))
          .map((q) => `<li class="${q.open ? 'open' : ''}"><div>${q.when ? `<span class="ddate">${q.when}</span>` : ''}${esc(q.askText)}</div><div class="answer">${q.open ? '<span class="task-pill warn">open</span>' : esc(q.answer)}</div></li>`)
          .join('')}</ol></section>`
      : '';
    for (const q of p.questions.filter((x) => x.open)) waiting.push({ plan: p.name, text: 'Question: ' + q.ask, gh: repoGh(p) });
    const tasks = qHtml + msHtml + (loose.length ? `<div class="tasks">${byRecency(loose).map(stepHtml).join('')}</div>` : '');
    const curMs = p.milestones.find((m) => msState(m) !== 'done');
    const msDone = p.milestones.filter((m) => msState(m) === 'done').length;
    const badges = [
      p.milestones.length ? `<span class="badge">${curMs ? esc(curMs.id) + ' · ' : ''}${msDone}/${p.milestones.length} milestones</span>` : '',
      p.questions.some((q) => q.open) ? `<span class="badge q">${p.questions.filter((q) => q.open).length} open question${p.questions.filter((q) => q.open).length > 1 ? 's' : ''}</span>` : '',
      p.decisions.length ? `<span class="badge dec">${p.decisions.length} decision${p.decisions.length > 1 ? 's' : ''}</span>` : '',
    ].join('');
    for (const d of p.decisions) allDecisions.push({ plan: p.name, text: d });
    const specUrl = p.spec ? 'vscode://file/' + encodeURI((/^[a-z]:/i.test(p.spec) ? p.spec : p.root + '/' + p.spec).replace(/\\/g, '/')) : '';
    const specLink = specUrl ? `<a class="spec" href="${specUrl}" title="${esc(p.spec)}">Open plan</a>` : '';
    const openQ = p.questions.filter((q) => q.open);
    if (p.decisions.length) {
      decCards.push(`<article class="dcard"><div class="sum-head"><b class="name">${esc(p.name)}</b><span class="badge dec">${p.decisions.length} decision${p.decisions.length > 1 ? 's' : ''}</span>${specLink}</div><ol>${newestFirst(p.decisions)
        .map((d) => `<li>${d.when ? `<span class="ddate">${d.when}</span>` : ''}${esc(d.text)}</li>`)
        .join('')}</ol></article>`);
    }
    summaries.push(`<article class="sum"><div class="sum-head"><b class="name">${esc(p.name)}</b><span class="status ${st.tone}">${esc(st.text)}</span><span class="sum-pct">${done} / ${total} · ${pct}%</span>${specLink}</div>
${p.goal ? `<p class="goal">${esc(p.goal)}</p>` : '<p class="goal missing">No Goal line yet</p>'}
${p.next ? `<p class="sum-line"><span>Next</span>${esc(p.next)}</p>` : ''}
${curMs ? `<p class="sum-line"><span>Now</span>${esc(curMs.id)}: ${esc(curMs.title)}</p>` : ''}
${p.milestones.filter((m) => msState(m) === 'done' && m.summary).reverse().map((m) => `<p class="sum-line done"><span>${esc(m.id)}</span>${esc(m.summary)}</p>`).join('')}
${newestFirst(openQ.map((q) => q.ask)).map((q) => `<p class="sum-line warn"><span>Open</span>${esc(q.text)}</p>`).join('')}
${p.decisions.length ? `<p class="sum-line dec"><span>Decisions</span>${p.decisions.length} settled, see the plan</p>` : ''}</article>`);
    return `<article class="wf" data-key="${esc(key)}" data-tone="${st.tone}" data-percent="${pct}" data-mtime="${p.mtime.getTime()}" aria-expanded="false">
<button class="wf-main" type="button" aria-expanded="false"><div><div class="name">${multiRepo ? `<span class="repo">${esc(p.repo)}</span>` : ''}${esc(p.name)}</div>${p.goal ? `<div class="goal-line">${esc(p.goal)}</div>` : ''}<div class="sub-line">${p.next ? 'Next: ' + linkPRs(esc(p.next), repoGh(p)) : '&nbsp;'}</div>${badges ? `<div class="badges">${badges}</div>` : ''}</div>
<div><div class="prog-flex"><span class="prog-num">${done} / ${total}</span><span class="prog-percent">${pct}%</span></div><div class="bar"><span class="bar-fill" style="width:${pct}%"></span></div></div>
<div class="st-cell">${(() => {
  const cut = st.text.indexOf(' - ');
  const stage = cut > 0 ? st.text.slice(0, cut) : st.text;
  const detail = cut > 0 ? st.text.slice(cut + 3) : '';
  return `<span class="status ${st.tone}">${esc(stage)}</span>${pipe(st.step)}${detail ? `<div class="st-detail" title="${esc(detail)}">${linkPRs(esc(detail), repoGh(p))}</div>` : ''}`;
})()}</div>
<div class="eta">${stale ? '<span class="stale">stale</span> ' : ''}<span class="${stale ? 'unknown' : ''}">${ago(p.mtime)}</span><small>${esc(p.repo)}</small></div>
<svg class="row-arrow" viewBox="0 0 24 24"><path d="m5 9 7 7 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<div class="detail" hidden><div class="detail-title"><strong>Checklist · ${esc(p.name)} ${specLink}</strong><span>${esc(p.repo)} · edited ${ago(p.mtime)}</span></div>${tasks || '<div class="tasks"><div class="task pending"><span class="checkbox"></span><span class="task-text">No steps yet</span></div></div>'}</div></article>`;
  })
  .join('\n');

const decView = decCards.length ? decCards.join('') : '<div class="empty">No decisions recorded yet</div>';
const donePct = sumTotal ? Math.round((sumDone / sumTotal) * 100) : 0;
const attentionHtml = attention.length
  ? attention
      .slice(0, 12)
      .map((a) => `<div class="${a.tone}"><span>${esc(a.plan)}</span><strong>${esc(a.text)}</strong></div>`)
      .join('')
  : '<div><span>Nothing needs attention</span></div>';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${RELOAD_SECONDS}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@8..144,400..700&family=Google+Sans+Code&display=swap"><title>Task progress</title>
<style>
:root{--ink:#001e2b;--muted:#607078;--green:#00684a;--green-mid:#008f64;--line:#e1e8e6;--line2:#eef1ef;--bg:#f9fbfa;--card:#fff;--hover:#fafdfa;--open:#f6fcf8;--track:#e6eeea;--amber:#9d6a1c;--amber-soft:#fff4db;--blue:#3465a9;--blue-soft:#eaf2ff;--purple:#8255a7;--purple-soft:#f5effc;--red:#c0392b;--red-soft:#fdecea;--gray-soft:#eef1ef}
@media (prefers-color-scheme:dark){:root{--ink:#e8eeec;--muted:#9aa9a5;--green:#3ddc97;--green-mid:#2fb87e;--line:#2c3533;--line2:#252d2b;--bg:#121816;--card:#171e1c;--hover:#1c2523;--open:#1a2421;--track:#2a3431;--amber:#f0b45c;--amber-soft:#3a2e17;--blue:#8ab4f8;--blue-soft:#1d2a3d;--purple:#c5a3ea;--purple-soft:#2c2238;--red:#ff8a80;--red-soft:#3b1f1d;--gray-soft:#252d2b}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.5 "Google Sans Flex","Google Sans","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}button,input,select{font:inherit;color:inherit}button{cursor:pointer}
.content{padding:14px 20px 28px}
.topbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;position:sticky;top:0;z-index:20;background:var(--bg);margin:-14px -20px 10px;padding:10px 20px;border-bottom:1px solid var(--line);box-shadow:0 2px 8px rgba(0,30,43,.06)}.brand{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.page-title{font-size:24px;font-weight:600;letter-spacing:-.2px;margin:0}.intro-desc{color:var(--muted);font-size:13px}
.button{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:5px 10px;font-size:14.5px;font-weight:700}.button:hover{border-color:var(--green-mid)}.button.primary{background:var(--green);border-color:var(--green);color:#fff}.actions{display:flex;gap:6px}
.name,.metric .value,.prog-num,.prog-percent,.eta,.task-est,.repo{font-family:"Google Sans Code",ui-monospace,Consolas,monospace}
.metrics{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.metric{position:relative;display:flex;align-items:baseline;gap:6px;border:1px solid var(--line);border-radius:7px;background:var(--card);padding:5px 10px 7px}.metric .meta{font-size:13px;color:var(--muted)}.metric .value{font-size:18px;font-weight:700}.metric .value small{font-weight:470;font-size:13px;color:var(--muted)}.metric.accent .value{color:var(--green)}.metric.warning .value{color:var(--amber)}.mini-bar{position:absolute;left:10px;right:10px;bottom:2px;height:2px;border-radius:2px;background:var(--track);overflow:hidden}.mini-bar i{display:block;height:100%;background:var(--green)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}.panel-top{padding:14px 16px;border-bottom:1px solid var(--line2);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.search{flex:1;min-width:180px;border:1px solid var(--line);border-radius:6px;height:34px;padding:0 10px;background:var(--card)}.search:focus{outline:2px solid var(--green-mid)}select{border:1px solid var(--line);border-radius:6px;background:var(--card);height:34px;padding:0 8px;font-size:14.5px}.compact-link{border:0;background:none;color:var(--green);font-weight:700;font-size:14.5px}
.table-head,.wf-main{display:grid;grid-template-columns:minmax(200px,1.9fr) minmax(130px,1fr) minmax(110px,.75fr) minmax(90px,.6fr) 20px;gap:14px;align-items:center}
.table-head{padding:9px 16px;color:var(--muted);font-size:12px;font-weight:770;letter-spacing:.5px;text-transform:uppercase;border-bottom:1px solid var(--line2)}
.wf{border-bottom:1px solid var(--line2)}.wf:last-child{border-bottom:0}.wf-main{width:100%;border:0;background:var(--card);text-align:left;padding:16px}.wf-main:hover{background:var(--hover)}.wf[aria-expanded="true"] .wf-main{background:var(--open)}
.name{font-weight:780}.repo{font-size:12px;font-weight:700;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-right:6px}.sub-line{margin-top:4px;font-size:13.5px;color:var(--muted)}
.prog-flex{display:flex;justify-content:space-between;margin-bottom:6px}.prog-num{font-weight:750}.prog-percent{color:var(--muted);font-size:13px}.bar{height:6px;background:var(--track);border-radius:15px;overflow:hidden}.bar-fill{display:block;height:100%;background:var(--green-mid)}
.status{display:inline-flex;align-items:center;gap:6px;border-radius:100px;font-size:12.5px;font-weight:750;padding:4px 9px;white-space:nowrap}.status:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.status.review{background:var(--purple-soft);color:var(--purple)}.status.test{background:var(--blue-soft);color:var(--blue)}.status.pending{background:var(--amber-soft);color:var(--amber)}.status.bad{background:var(--red-soft);color:var(--red)}.status.ok,.status.doing{background:var(--open);color:var(--green)}.status.idle{background:var(--gray-soft);color:var(--muted)}
.st-cell{min-width:0}.st-detail{margin-top:6px;font-size:12.5px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pipe{display:flex;gap:3px;margin-top:7px}.pipe i{width:14px;height:4px;border-radius:2px;background:var(--track)}.pipe i.past{background:var(--green-mid);opacity:.45}.pipe i.cur{background:var(--green-mid)}
.eta{font-weight:710;font-size:14px}.eta small{display:block;color:var(--muted);font-size:12px;font-weight:520;margin-top:4px}.eta .unknown{color:var(--amber)}
.row-arrow{width:16px;height:16px;color:var(--muted);transition:transform .15s}.wf[aria-expanded="true"] .row-arrow{transform:rotate(180deg);color:var(--green)}
.detail{padding:12px 18px 16px;border-top:1px solid var(--line2);background:var(--open)}.detail[hidden]{display:none}.detail-title{display:flex;justify-content:space-between;margin-bottom:6px;font-size:14.5px}.detail-title span{color:var(--muted);font-size:12px}
.task{display:grid;grid-template-columns:16px 1fr auto auto;gap:10px;align-items:start;padding:7px 0;font-size:14px;border-bottom:1px dashed var(--line)}.task:last-child{border-bottom:0}.checkbox{width:15px;height:15px;border:1px solid var(--line);border-radius:4px;display:grid;place-items:center;font-size:12px;margin-top:1px}
.task.done .checkbox{background:var(--green-mid);border-color:var(--green-mid);color:#fff}.task.done .task-text{color:var(--muted)}.task.active .checkbox{border-color:var(--green-mid);color:var(--green)}.task.warn .checkbox{border-color:var(--amber);color:var(--amber)}.task.bad .checkbox{border-color:var(--red);color:var(--red)}.task.bad .task-text{color:var(--red)}
.task-est{color:var(--muted);font-size:12.5px;white-space:nowrap}.task-pill{border-radius:4px;padding:2px 6px;font-size:12px;font-weight:660;white-space:nowrap;background:var(--gray-soft);color:var(--muted)}.task-pill.done{background:var(--open);color:var(--green)}.task-pill.active{background:var(--blue-soft);color:var(--blue)}.task-pill.warn{background:var(--amber-soft);color:var(--amber)}.task-pill.bad{background:var(--red-soft);color:var(--red)}
.badges{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}.badge{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:1px 8px;color:var(--muted)}.badge.dec{border-color:var(--purple);color:var(--purple)}
.decisions{border:1px solid var(--purple-soft);background:var(--card);border-radius:8px;padding:10px 14px;margin:6px 0 12px}.block-title{font-weight:760;color:var(--purple);font-size:14px}.block-title span{font-size:12px;background:var(--purple-soft);border-radius:10px;padding:0 7px;margin-left:4px}.decisions ol{margin:6px 0 0;padding-left:22px}.decisions li{padding:4px 0;font-size:14.5px;line-height:1.5}
.questions{border:1px solid var(--blue-soft);background:var(--card);border-radius:8px;padding:10px 14px;margin:0 0 12px}.block-title.q{color:var(--blue)}.block-title.q span{background:var(--blue-soft)}.questions ol{margin:6px 0 0;padding-left:22px}.questions li{padding:5px 0;font-size:14.5px;border-bottom:1px dashed var(--line)}.questions li:last-child{border-bottom:0}.questions .answer{color:var(--muted);margin-top:2px}.questions .answer:before{content:"→ "}.badge.q{border-color:var(--amber);color:var(--amber)}
.ms{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:10px 14px;margin:0 0 10px}.ms-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ms-id{font-family:"Google Sans Code",monospace;font-weight:700;color:var(--green)}.ms-count{font-family:"Google Sans Code",monospace;color:var(--muted);font-size:13px;margin-left:auto}.ms-bar{width:120px;height:5px;background:var(--track);border-radius:4px;overflow:hidden}.ms-bar i{display:block;height:100%;background:var(--green-mid)}.ms-sum{margin:8px 0 4px;padding:8px 10px;background:var(--open);border-left:3px solid var(--green-mid);border-radius:4px;font-size:14px}.ms-done .tasks{opacity:.75}
.goal-line{margin-top:4px;font-size:14px}.sub-line{opacity:.95}
.spec{font-size:13px;font-weight:700;color:var(--green);border:1px solid var(--green-mid);border-radius:5px;padding:1px 8px;text-decoration:none;margin-left:8px}.spec:hover{background:var(--open)}
#decView{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:12px;padding:14px 16px;align-items:start}
.dcard{border:1px solid var(--purple-soft);border-radius:8px;padding:12px 14px;background:var(--card)}.dcard .spec{margin-left:auto}.dcard ol{margin:8px 0 0;padding-left:22px}.dcard li{padding:5px 0;font-size:14.5px;line-height:1.5;border-bottom:1px dashed var(--line)}.dcard li:last-child{border-bottom:0}.ddate{display:block;font-family:"Google Sans Code",monospace;font-size:12px;color:var(--muted)}
#sumView{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:12px;padding:14px 16px}#sumView[hidden]{display:none}
.sum{border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--card)}.sum-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.sum-pct{font-family:"Google Sans Code",monospace;color:var(--muted);font-size:13px}.sum .spec{margin-left:auto}
.goal{margin:8px 0;font-size:15px}.goal.missing{color:var(--muted);font-style:italic;font-size:13px}
.sum-line{display:grid;grid-template-columns:86px 1fr;gap:8px;margin:5px 0;font-size:14px}.sum-line span{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;padding-top:2px}.sum-line.done span{color:var(--green)}.sum-line.warn span{color:var(--amber)}.sum-line.dec span{color:var(--purple)}
.waiting{border:1px solid var(--amber);background:var(--amber-soft);border-radius:8px;padding:10px 14px;margin-bottom:10px}.waiting-title{font-weight:760;color:var(--amber);font-size:15px;margin-bottom:4px}.waiting-title b{background:var(--amber);color:#fff;border-radius:10px;padding:0 8px;font-size:13px}.w-item{display:grid;grid-template-columns:220px 1fr;gap:12px;padding:5px 0;font-size:14.5px;border-top:1px dashed var(--line)}

.pr{color:var(--blue);font-weight:700;text-decoration:none}.pr:hover{text-decoration:underline}.stale{font-size:11.5px;font-weight:700;color:#fff;background:var(--red);border-radius:4px;padding:0 5px}
.views{display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}.view{border:0;background:var(--card);padding:6px 12px;font-size:14px;font-weight:700;color:var(--muted)}.view.on{background:var(--green);color:#fff}.view span{font-size:12px;opacity:.8}
.dec-item{display:grid;grid-template-columns:220px 1fr;gap:14px;padding:10px 16px;border-bottom:1px solid var(--line2);font-size:14.5px}.dec-plan{font-family:"Google Sans Code",monospace;font-weight:700;color:var(--purple);font-size:13px}
.empty{padding:30px 16px;text-align:center;color:var(--muted)}
.risk{border:1px solid var(--line);background:var(--card);border-radius:7px;margin-bottom:10px}.risk summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 12px}.risk summary::-webkit-details-marker{display:none}.risk-title{font-weight:760;font-size:14.5px;color:var(--amber)}.risk-count{font-size:14.5px;color:#fff;background:var(--amber);border-radius:10px;padding:0 7px}.risk-hint{color:var(--muted);font-size:13px}.risk[open] .risk-hint{display:none}.risk-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:4px 16px;padding:0 12px 10px}.risk-list div{display:flex;justify-content:space-between;gap:10px;font-size:13px;border-top:1px solid var(--line2);padding-top:6px;color:var(--muted)}.risk-list strong{font-weight:700;color:var(--amber);text-align:right}.risk-list .bad strong{color:var(--red)}
.foot{color:var(--muted);font-size:12.5px;margin-top:18px}
@media(max-width:900px){.metrics{margin-left:0}}
@media(max-width:640px){.content{padding:18px 16px}.table-head{display:none}.wf-main{grid-template-columns:1fr auto}.wf-main>div:nth-child(3){grid-column:2;grid-row:1}.wf-main>svg{display:none}}
</style></head><body>
<div class="content">
<div class="topbar"><div class="brand"><h1 class="page-title">Agent Ops</h1><span class="intro-desc">${repos.filter((r) => r.plans.length).length} repo(s) · updated ${stamp} · reloads every ${RELOAD_SECONDS / 60} min</span></div>
<div class="metrics">
<div class="metric"><span class="meta">Plans</span><b class="value">${plans.length}</b></div>
<div class="metric accent"><span class="meta">Steps done</span><b class="value">${sumDone}<small> / ${sumTotal} · ${donePct}%</small></b><div class="mini-bar"><i style="width:${donePct}%"></i></div></div>
<div class="metric warning"><span class="meta">Waiting for you</span><b class="value">${waiting.length}</b></div>
</div>
<div class="actions"><button class="button" id="expandAll" type="button">Expand all</button><button class="button primary" type="button" onclick="location.reload()">Reload</button></div></div>
${waiting.length ? `<section class="waiting"><div class="waiting-title">Waiting for you <b>${waiting.length}</b></div>${waiting
  .map((w) => `<div class="w-item"><span class="dec-plan">${esc(w.plan)}</span><span>${linkPRs(esc(w.text), w.gh)}</span></div>`)
  .join('')}</section>` : ''}
${attention.length ? `<details class="risk"><summary><span class="risk-title">Needs attention</span><b class="risk-count">${attention.length}</b><span class="risk-hint">show</span></summary><div class="risk-list">${attentionHtml}</div></details>` : ''}
<div class="panel">
<div class="panel-top"><div class="views"><button type="button" class="view on" data-view="plans">Plans</button><button type="button" class="view" data-view="summary">Summary</button><button type="button" class="view" data-view="decisions">Decisions <span>${allDecisions.length}</span></button></div><input class="search" id="search" type="search" placeholder="Search plans and steps…" aria-label="Search"><select id="filter" aria-label="Filter by status"><option value="all">All statuses</option><option value="doing">In progress</option><option value="review">Review</option><option value="test">Test / CI</option><option value="pending">Waiting / partial</option><option value="bad">Blocked</option><option value="ok">Done</option><option value="idle">Not started</option></select><button class="compact-link" id="sort" type="button">Sort: last edited</button></div>
<div class="table-head"><span>Plan / next step</span><span>Progress</span><span>Status</span><span>Updated / where</span><span></span></div>
<div id="list">${rows || ''}</div>
<div id="sumView" hidden>${summaries.join('') || '<div class="empty">No active plan</div>'}</div>
<div id="decView" hidden>${decView}</div>
<div class="empty" id="empty"${plans.length ? ' hidden' : ''}>${plans.length ? 'No matching plan' : 'No active plan'}</div>
</div>
<p class="foot">Generated from each repo's .tasks/ by tasks-overview.mjs. Status comes from the "Status:" line the agent keeps in the plan file; without it, it is derived from the steps.</p>
</div>
<script>
(function(){
 var rows=[].slice.call(document.querySelectorAll('.wf')),list=document.getElementById('list'),search=document.getElementById('search'),filter=document.getElementById('filter'),sort=document.getElementById('sort'),empty=document.getElementById('empty'),expand=document.getElementById('expandAll');
 var KEY='agent-ops',st={q:'',f:'all',s:0,open:[],v:'plans'};var decView=document.getElementById('decView'),sumView=document.getElementById('sumView'),decs=[].slice.call(document.querySelectorAll('.dcard,.sum')),head=document.querySelector('.table-head'),views=[].slice.call(document.querySelectorAll('.view'));
 try{st=Object.assign(st,JSON.parse(localStorage.getItem(KEY)||'{}'))}catch(e){/* Invalid preferences fall back to the defaults above. */}
 function save(){try{localStorage.setItem(KEY,JSON.stringify(st))}catch(e){/* Storage restrictions affect preferences only; the current view still works. */}}
 function toggle(r,force){var o=force===undefined?r.getAttribute('aria-expanded')!=='true':force;r.setAttribute('aria-expanded',String(o));r.querySelector('.wf-main').setAttribute('aria-expanded',String(o));r.querySelector('.detail').hidden=!o;var k=r.dataset.key;st.open=st.open.filter(function(x){return x!==k});if(o)st.open.push(k);label();}
 function label(){expand.textContent=rows.length&&rows.every(function(r){return r.getAttribute('aria-expanded')==='true'})?'Collapse all':'Expand all';}
 function setView(){var d=st.v!=='plans';views.forEach(function(b){b.classList.toggle('on',b.dataset.view===st.v)});list.hidden=d;head.hidden=d;decView.hidden=st.v!=='decisions';sumView.hidden=st.v!=='summary';filter.hidden=d;sort.hidden=d;if(d)empty.hidden=true;else apply();}
 function apply(){var q=st.q.trim().toLocaleLowerCase('vi'),n=0;decs.forEach(function(x){x.hidden=!!q&&x.textContent.toLocaleLowerCase('vi').indexOf(q)<0});if(st.v!=='plans')return;rows.forEach(function(r){var show=(!q||r.textContent.toLocaleLowerCase('vi').indexOf(q)>=0)&&(st.f==='all'||r.dataset.tone===st.f);r.hidden=!show;if(show)n++;});if(rows.length)empty.hidden=n>0;}
 var sorts=[['last edited',function(a,b){return b.dataset.mtime-a.dataset.mtime}],['progress ↓',function(a,b){return b.dataset.percent-a.dataset.percent}],['progress ↑',function(a,b){return a.dataset.percent-b.dataset.percent}]];
 function order(){var s=sorts[st.s];var o=s[1]?rows.slice().sort(s[1]):rows;o.forEach(function(r){list.appendChild(r)});sort.textContent='Sort: '+s[0];}
 rows.forEach(function(r){r.querySelector('.wf-main').addEventListener('click',function(){toggle(r);save();});if(st.open.indexOf(r.dataset.key)>=0)toggle(r,true);});
 expand.addEventListener('click',function(){var next=!rows.every(function(r){return r.getAttribute('aria-expanded')==='true'});rows.forEach(function(r){toggle(r,next)});save();});
 search.value=st.q;filter.value=st.f;search.addEventListener('input',function(){st.q=search.value;apply();save();});filter.addEventListener('change',function(){st.f=filter.value;apply();save();});
 sort.addEventListener('click',function(){st.s=(st.s+1)%sorts.length;order();save();});
 views.forEach(function(b){b.addEventListener('click',function(){st.v=b.dataset.view;setView();save();})});
 order();apply();label();setView();
})();
</script>
</body></html>
`;
writeFileSync(join(OUT_DIR, 'tong-hop-chung.html'), html);

// Machine-readable state for the Agent Ops desktop app.
const MARK = { '⬜': 'todo', '🔄': 'doing', '✅': 'done', '⚠': 'partial', '❌': 'blocked' };
const step = (x, i, p) => {
 const milestone = p.milestones.find((m) => m.points.includes(x));
 return { status: MARK[x.status], text: x.text, line:x.line, milestone: milestone ? milestone.id : '', index: milestone ? milestone.points.indexOf(x) : i };
};
writeFileSync(
  STATE_FILE,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    projects: projectStates,
    plans: plans.map((p) => {
      const count = Object.fromEntries(STATUSES.map((k) => [k, p.points.filter((x) => x.status === k).length]));
      const st = statusOf(p, count);
      return {
        project: p.project,
        projectName: p.projectName,
        repo: p.repo,
        root: p.root,
        gh: repoGh(p),
        name: p.name,
        owner: p.owner,
        goal: p.goal,
        spec: p.spec,
        next: p.next,
        status: st.text,
        tone: st.tone,
        step: st.step,
        mtime: p.mtime.toISOString(),
        revision: p.revision,
        decisions: p.decisions.map((d) => {
          const x = stamped(d, 0);
          return { key: x.key, when: x.when, text: x.text };
        }),
        questions: p.questions.map((q) => {
          const x = stamped(q.ask, 0);
          return { key: x.key, when: x.when, ask: x.text, answer: q.open ? '' : q.answer, open: q.open };
        }),
        milestones: p.milestones.map((m) => ({ id: m.id, title: m.title, state: m.state, summary: m.summary, steps: m.points.map((x, i) => step(x, i, p)) })),
        steps: p.points.map((x, i) => step(x, i, p)),
      };
    }),
  }),
);
console.log(`tasks-overview: ${plans.length} plan -> ${OUT_DIR}/tong-hop-chung.{md,html}`);
