import {createHash} from 'node:crypto';
import {readFileSync,statSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
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
    // Plans from earlier releases may end a step with <!-- Executor: ... -->; it is not shown.
    const comment=text.match(/\s*<!--\s*Executors?:\s*([^<>]*?)\s*-->\s*$/i);
    if(comment)text=text.slice(0,comment.index);
    const point = { status, text: text.replace(new RegExp(EST_RE.source, 'giu'), '').trim(), line:lineIndex+1 };
    points.push(point);
    if (ms) ms.points.push(point);
  }
  return { revision, owner: field('Owner'), goal: field('Goal'), spec: field('Spec'), next: field('Next', 'Tiếp theo'), label: field('Status', 'Trạng thái'), points, milestones, decisions, questions, mtime: statSync(file).mtime };
}

// ---------- Project settings ----------
// Agent Ops settings for the collector. The desktop app passes AGENT_OPS_CONFIG to
// its child; a direct run uses the default location, so no machine-specific flags
// are needed. Precedence, identical to the Go app (config() and initSettings):
// flag > AGENT_OPS_* environment > config.json > default.
export function defaultDataDir(env=process.env){
  return join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'AgentOps');
}
export function configPath(env=process.env){
  return resolve(env.AGENT_OPS_CONFIG || join(defaultDataDir(env),'config.json'));
}

// Matches projectPathForID in config.go. resolve() keeps a trailing separator on a
// share root (\\server\share\) where Go's Clean does not; only a drive root keeps it.
function projectPathForId(path){
  const full=resolve(path);
  return /^[A-Za-z]:[\\/]$/.test(full)?full:full.replace(/[\\/]+$/,'');
}
// Matches projectIDFor in config.go: the same folder always has the same ID.
export function projectIdFor(path){
  return createHash('sha256').update(projectPathForId(path).toLowerCase()).digest('hex').slice(0,8);
}
// The repository name of a repo project; matches repoNameOf in config.go. A drive
// or share root has no folder name, so its drive letter or share name is used.
export function repoNameOf(path){
  const full=projectPathForId(path);
  return basename(full) || full.replace(/[\\/:]+$/,'').split(/[\\/]/).filter(Boolean).pop() || 'root';
}

export function readConfig(file){
  if(!existsSync(file))return null;
  let parsed;
  try{parsed=JSON.parse(readFileSync(file,'utf8').replace(/^﻿/,''));}
  catch(error){throw Error('Agent Ops settings '+file+' are unreadable: '+error.message+'. Open Agent Ops to repair them.');}
  if(parsed?.version!==1 || !Array.isArray(parsed.projects))throw Error('Agent Ops settings '+file+' have an unsupported format.');
  for(const p of parsed.projects){
    if(typeof p?.id!=='string' || typeof p.path!=='string' || !['repo','folder'].includes(p.kind) || typeof p.enabled!=='boolean')throw Error('Agent Ops settings '+file+' contain an invalid project.');
  }
  return parsed;
}

function overrideProject(path){
  const full=projectPathForId(path);
  return {id:projectIdFor(full),path:full,name:basename(full) || full,kind:'folder',enabled:true};
}

export function resolveSettings(options={},env=process.env){
  const configFile=configPath(env);
  // Read lazily: explicit flags never depend on (or fail because of) the config file.
  let cached;const config=()=>cached===undefined?(cached=readConfig(configFile)):cached;
  const reposOverride=options['repos-dir'] || env.AGENT_OPS_REPOS_DIR;
  let projects=[];
  if(reposOverride)projects=[overrideProject(reposOverride)];
  else if(config())projects=config().projects.filter(p=>p.enabled).map(p=>({...p,path:resolve(p.path)}));
  const stateFile=resolve(options['state-file'] || env.AGENT_OPS_STATE_FILE || config()?.stateFile || join(dirname(configFile),'state','tong-hop-chung.json'));
  return {configFile,projects,stateFile};
}

const isDir=path=>{try{return statSync(path).isDirectory();}catch{return false;}};
const isRepo=path=>existsSync(join(path,'.git')) || existsSync(join(path,'.tasks'));

// The repositories a project contributes; mirrors projectRepos in config.go.
// Throws (with the fs error code) when the project folder cannot be read.
export function projectRepos(project){
  if(!statSync(project.path).isDirectory())throw Object.assign(Error(project.path+' is not a folder'),{code:'ENOTDIR'});
  if(project.kind==='repo')return [{name:repoNameOf(project.path),root:project.path}];
  return readdirSync(project.path).sort()
    .map(name=>({name,root:join(project.path,name)}))
    .filter(r=>isDir(r.root) && isRepo(r.root));
}
