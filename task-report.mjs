#!/usr/bin/env node
// Run by the executing client at real lifecycle changes, never by the dashboard.
import {readFileSync,realpathSync,mkdirSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,relative,sep,basename,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readPlan} from './plan-reader.mjs';
import {loadExecutionReports,reportDirectory,reportEvents,taskLocator,findReportedTask} from './execution-reports.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const agents={codex:'Codex',anti:'Anti',antigravity:'Anti',claude:'Claude'};
export function reportOptions(args){
 const allowed=['agent','role','coordinator','plan-file','step-line','event','run-id','session-id','result','revision','repos-dir','state-file','slots-file','script'];
 const out={};for(let i=0;i<args.length;i++){
  const key=args[i].replace(/^--/,'');
  if(!args[i].startsWith('--') || !allowed.includes(key) || args[i+1]===undefined || args[i+1].startsWith('--') || Object.hasOwn(out,key))throw Error('Invalid report option: '+args[i]);
  out[key]=args[++i];
 }return out;
}
export function reportTask(options){
 const agent=agents[String(options.agent || '').toLowerCase()],event=options.event;
 if(!agent || !reportEvents.includes(event) || !isAbsolute(options['plan-file'] || ''))throw Error('Use --agent Codex|Anti|Claude --plan-file <absolute plan> --event start|progress|done|blocked|stopped.');
 if(options.role && !['coordinator','executor'].includes(options.role))throw Error('Invalid reporter role.');
 const repos=realpathSync(resolve(options['repos-dir'] || process.env.KRIK_REPOS_DIR || 'D:/1_PROJECTS/_REPOS'));
 const file=realpathSync(options['plan-file']),parts=relative(repos,file).split(sep);
 if(parts.length!==3 || parts[0]==='..' || parts[1]!=='.tasks' || !parts[2].endsWith('.md') || basename(file).toLowerCase()==='tong-hop.md')throw Error('Report a task in the main checkout .tasks directory.');
 const plan=readPlan(file);
 if(options.revision && options.revision!==plan.revision)throw Error('Plan changed. Re-read the task before reporting.');
 const state=resolve(options['state-file'] || process.env.KRIK_STATE_FILE || 'D:/1_PROJECTS/tong-hop-chung.json');
 const directory=reportDirectory(state);mkdirSync(directory,{recursive:true});
 const runId=options['run-id'] || (event==='start'?randomUUID():'');
 if(!/^[a-f0-9-]{36}$/i.test(runId))throw Error('Continue an existing --run-id returned by a start report.');
 const lock=join(directory,runId+'.lock');let fd;
 try{fd=openSync(lock,'wx');}catch{throw Error('This execution run is being reported by another call. Retry after it finishes.');}
 let record;
 try{
  const reports=loadExecutionReports(directory),run=reports.filter(r=>r.runId===runId),prior=run.at(-1);
  if(event==='start' && prior)throw Error('Run already started. Continue with progress or a terminal event.');
  if(event!=='start' && (!prior || prior.agent!==agent || resolve(prior.file).toLowerCase()!==file.toLowerCase()))throw Error('Only the same executing client can continue its own run.');
  if(prior && ['done','blocked','stopped'].includes(prior.event))throw Error('Run already finished; start a new run for new work.');
  const explicit=options['step-line']===undefined?null:Number(options['step-line']);
  let point=explicit===null?(prior?findReportedTask(plan,prior):null):plan.points.find(p=>p.line===explicit);
  if(!point || (explicit!==null && (!Number.isInteger(explicit) || explicit<1)))throw Error('Select the actual checklist task with --step-line; ambiguous or reworded tasks must be re-read.');
  if(prior && findReportedTask(plan,prior)!==point)throw Error('The selected task does not match this execution run.');
  const parent=agents[String(plan.agentLabel || '').toLowerCase()];
  const supplied=options.coordinator===undefined?null:agents[String(options.coordinator).toLowerCase()];
  if(options.coordinator!==undefined && !supplied)throw Error('Unknown coordinator.');
  const coordinator=prior?.coordinator || parent || supplied || (options.role==='executor'?null:agent);
  if(!coordinator || (parent && parent!==coordinator) || (supplied && supplied!==coordinator))throw Error('Preserve the actual parent coordinator when reporting delegated work.');
  const result=String(options.result || '').trim();
  if(['done','blocked','stopped'].includes(event) && !result)throw Error('A terminal report requires --result with observed evidence or a blocking reason.');
  if(result.length>4000)throw Error('Keep the execution result within 4000 characters.');
  const session=String(options['session-id'] || prior?.session || runId);
  if(session.length>200)throw Error('Session ID is too long.');
  const at=new Date(Math.max(Date.now(),prior?Date.parse(prior.at)+1:0)).toISOString();
  record={version:1,id:randomUUID(),runId,agent,coordinator,event,at,session,file,revision:plan.revision,task:taskLocator(plan,point),result};
  // Verify again before publishing; source task files are never changed by reporting.
  if(readPlan(file).revision!==plan.revision)throw Error('Plan changed while preparing the report. Re-read before retrying.');
  const temporary=join(directory,record.id+'.tmp');
  try{writeFileSync(temporary,JSON.stringify(record),{flag:'wx'});renameSync(temporary,join(directory,record.id+'.json'));}
  finally{try{unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }finally{closeSync(fd);unlinkSync(lock);}
 const script=resolve(options.script || join(root,'tasks-overview.mjs'));
 const slots=resolve(options['slots-file'] || process.env.KRIK_SLOTS_FILE || 'D:/1_PROJECTS/_WORKTREES/slots.json');
 const refresh=spawnSync(process.execPath,[script],{env:{...process.env,KRIK_REPOS_DIR:repos,KRIK_STATE_FILE:state,KRIK_TASKS_OUT_DIR:dirname(state),KRIK_SLOTS_FILE:slots},encoding:'utf8',windowsHide:true,timeout:30000});
 if(refresh.error || refresh.status!==0)throw Error('Report '+record.id+' (run-id '+runId+') recorded, but overview refresh failed: '+(refresh.error?.message || refresh.stderr));
 let snapshot;try{snapshot=JSON.parse(readFileSync(state,'utf8'));}catch(e){throw Error('Report recorded, but refreshed state is invalid: '+e.message);}
 const confirmed=snapshot.plans?.find(p=>p.repo===parts[0] && p.name===basename(file,'.md'))?.executionReports?.some(r=>r.id===record.id);
 if(!confirmed)throw Error('Report recorded, but the refreshed state did not confirm it.');
 return {...record,stateFile:state,message:'task-report: '+agent+' '+event+' -> '+parts[0]+'/'+basename(file,'.md')+'; run-id '+runId};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{console.log(reportTask(reportOptions(process.argv.slice(2))).message);}catch(e){console.error('task-report: '+e.message);process.exitCode=1;}
}
