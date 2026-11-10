import {createHash} from 'node:crypto';
import {readFileSync,statSync,existsSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,dirname,basename,relative,sep} from 'node:path';
import {homedir} from 'node:os';
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

// ---------- Project settings ----------
// Shared Agent Ops settings for every Node helper (kept in this module so the
// release package file list, which the in-app updater validates, is unchanged). The desktop app passes
// AGENT_OPS_CONFIG to its children; an agent running a helper directly uses the
// default location, so no machine-specific flags are needed.
// Precedence: flag > config.json > KRIK_* environment (only without a config) > default.
export function defaultDataDir(env=process.env){
  return join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'krik-workboard');
}
export function configPath(env=process.env){
  return resolve(env.AGENT_OPS_CONFIG || join(defaultDataDir(env),'config.json'));
}

// Matches projectIDFor in config.go: the same folder always has the same ID.
export function projectIdFor(path){
  return createHash('sha256').update(resolve(path).toLowerCase()).digest('hex').slice(0,8);
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
  const full=resolve(path);
  return {id:projectIdFor(full),path:full,name:basename(full) || full,kind:'folder',enabled:true};
}

export function resolveSettings(options={},env=process.env){
  const configFile=configPath(env);
  // Read lazily: explicit flags never depend on (or fail because of) the config file.
  let cached;const config=()=>cached===undefined?(cached=readConfig(configFile)):cached;
  let projects=[];
  if(options['repos-dir'])projects=[overrideProject(options['repos-dir'])];
  else if(config())projects=config().projects.filter(p=>p.enabled).map(p=>({...p,path:resolve(p.path)}));
  else if(env.KRIK_REPOS_DIR)projects=[overrideProject(env.KRIK_REPOS_DIR)];
  const legacyEnv=name=>config()?'':(env[name] || '');
  const stateFile=resolve(options['state-file'] || config()?.stateFile || legacyEnv('KRIK_STATE_FILE') || join(dirname(configFile),'state','tong-hop-chung.json'));
  const slotsSource=options['slots-file'] || config()?.slotsFile || legacyEnv('KRIK_SLOTS_FILE');
  return {configFile,projects,stateFile,slotsFile:slotsSource?resolve(slotsSource):''};
}

// Runs the collector with the same resolved settings as the calling helper.
export function collectorRun(settings,options={}){
  const args=['--state-file',settings.stateFile];
  if(settings.slotsFile)args.push('--slots-file',settings.slotsFile);
  if(options['repos-dir'])args.push('--repos-dir',resolve(options['repos-dir']));
  const env={...process.env,AGENT_OPS_CONFIG:settings.configFile,KRIK_STATE_FILE:settings.stateFile,KRIK_TASKS_OUT_DIR:dirname(settings.stateFile),KRIK_SLOTS_FILE:settings.slotsFile,KRIK_REPOS_DIR:options['repos-dir']?resolve(options['repos-dir']):''};
  return {args,env};
}
// A state entry confirms a located plan; states from older collectors have no project.
export function sameProjectPlan(entry,located,name){
  return entry.repo===located.repo && entry.name===name && (entry.project===undefined || entry.project===located.project.id);
}

const isDir=path=>{try{return statSync(path).isDirectory();}catch{return false;}};
const isRepo=path=>existsSync(join(path,'.git')) || existsSync(join(path,'.tasks'));

// The repositories a project contributes; mirrors projectRepos in config.go.
// Throws (with the fs error code) when the project folder cannot be read.
export function projectRepos(project){
  if(!statSync(project.path).isDirectory())throw Object.assign(Error(project.path+' is not a folder'),{code:'ENOTDIR'});
  if(project.kind==='repo')return [{name:basename(project.path),root:project.path}];
  return readdirSync(project.path).sort()
    .map(name=>({name,root:join(project.path,name)}))
    .filter(r=>isDir(r.root) && isRepo(r.root));
}

// Finds the configured project that holds a plan file in a main checkout:
// <folder project>/<repo>/.tasks/<plan>.md or <repo project>/.tasks/<plan>.md.
export function locatePlan(file,projects){
  const real=realpathSync(resolve(file));
  if(basename(real).toLowerCase()==='tong-hop.md' || !real.toLowerCase().endsWith('.md'))return null;
  for(const project of projects){
    let root;try{root=realpathSync(project.path);}catch{continue;}
    const parts=relative(root,real).split(sep);
    if(parts[0]==='..' || parts[0]==='' )continue;
    if(project.kind==='folder' && parts.length===3 && parts[1]==='.tasks')return {project,repo:parts[0],file:real};
    if(project.kind==='repo' && parts.length===2 && parts[0]==='.tasks')return {project,repo:basename(project.path),file:real};
  }
  return null;
}
export function planNotFound(settings){
  if(!settings.projects.length)return 'No Agent Ops projects are configured ('+settings.configFile+'). Open Agent Ops and add the project folder in Settings.';
  return 'Use a plan in <repository>/.tasks/<plan>.md in the main checkout of a project configured in Agent Ops ('+settings.projects.map(p=>p.path).join('; ')+').';
}
