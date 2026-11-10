// Agent-authored execution evidence. Workboard only reads this append-only store.
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {executorAgents} from './execution-roles.mjs';

export const reportEvents=['start','progress','done','blocked','stopped'];
export const reportDirectory=state=>resolve(process.env.KRIK_EXECUTION_DIR || join(dirname(state),'workboard-executions'));
const pathKey=value=>resolve(value).replaceAll('\\','/').toLowerCase();
const terminal=event=>['done','blocked','stopped'].includes(event);
export function loadExecutionReports(directory){
 if(!existsSync(directory))return [];
 const reports=[];
 for(const name of readdirSync(directory).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n)).sort()){
  let r;try{r=JSON.parse(readFileSync(join(directory,name),'utf8'));}catch(e){throw Error('Invalid execution report '+name+': '+e.message);}
  if(r.version!==1 || r.id+'.json'!==name || !/^[a-f0-9-]{36}$/i.test(r.runId || '') || !executorAgents.includes(r.agent) || !executorAgents.includes(r.coordinator) ||
   !reportEvents.includes(r.event) || !Number.isFinite(Date.parse(r.at)) || typeof r.file!=='string' || !/^[a-f0-9]{64}$/.test(r.revision || '') ||
   typeof r.task?.text!=='string' || !r.task.text || !Number.isInteger(r.task.index) || r.task.index<0 || typeof r.task.milestone!=='string' || !Number.isInteger(r.task.line) || r.task.line<1 ||
   typeof r.result!=='string' || typeof r.session!=='string')throw Error('Invalid execution report '+name);
  reports.push(r);
 }
 return reports.sort((a,b)=>a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export function taskLocator(plan,point){
 const milestone=plan.milestones.find(m=>m.points.includes(point));
 return {text:point.text,milestone:milestone?.id || '',index:milestone?milestone.points.indexOf(point):plan.points.indexOf(point),line:point.line};
}

// Exact task text within a milestone can survive unrelated edits. Duplicate text
// is only resolved by a source line when the complete source revision still matches.
export function findReportedTask(plan,report){
 const matches=plan.points.filter(p=>p.text===report.task.text && taskLocator(plan,p).milestone===report.task.milestone);
 if(matches.length===1)return matches[0];
 if(plan.revision===report.revision)return matches.find(p=>p.line===report.task.line) || null;
 return null;
}

export function applyExecutionReports(plan,reports){
 const file=pathKey(join(plan.root,'.tasks',plan.name+'.md'));
 const own=reports.filter(r=>pathKey(r.file)===file);
 plan.executionReports=own;
 let allAgents=[];
 for(const point of plan.points){
  const matched=own.filter(r=>findReportedTask(plan,r)===point);
  point.executionReports=matched;
  if(!matched.length)continue;
  const runs=new Map();for(const r of matched)runs.set(r.runId,r);
  const latest=[...runs.values()],last=matched.at(-1);
  point.executors=executorAgents.filter(a=>matched.some(r=>r.agent===a));
  allAgents.push(...point.executors);
  point.sourceStatus=point.status;
  const active=latest.filter(r=>!terminal(r.event));
  const business=matched.filter(r=>r.origin!=='cli-runner');
  const perAgent=new Map();for(const r of business)perAgent.set(r.agent,r);
  const current=[...perAgent.values()];
  const sourceState={'\u2b1c':'todo','\ud83d\udd04':'doing','\u2705':'done','\u26a0':'partial','\u274c':'blocked'}[point.sourceStatus] || point.sourceStatus;
  const state=!business.length && sourceState==='done'?'done':active.length?'doing':!current.length?sourceState:current.some(r=>r.event==='blocked')?'blocked':current.every(r=>r.event==='done')?'done':'partial';
  // Preserve the collector's legacy marker representation until JSON export.
  point.status={todo:'\u2b1c',doing:'🔄',done:'✅',blocked:'❌',partial:'⚠'}[state];
  point.execution={state,reportedAt:last.at,result:last.result,activeAgents:executorAgents.filter(a=>active.some(r=>r.agent===a)),source:business.length?'Agent execution report':'CLI runner execution'};
 }
 plan.recordedExecutors=allAgents.length?executorAgents.filter(a=>allAgents.includes(a)):null;
 plan.executionUpdatedAt=own.at(-1)?.at || null;
 plan.reportedCoordinator=own.at(-1)?.coordinator || null;
 return plan;
}
