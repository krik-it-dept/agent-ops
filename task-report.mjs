#!/usr/bin/env node
// Run by the executing client at real lifecycle changes, never by the dashboard.
import {readFileSync,realpathSync,mkdirSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {resolve,relative,sep,basename,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readPlan} from './plan-reader.mjs';
import {loadExecutionReports,reportDirectory,reportEvents,taskLocator,findReportedTask} from './execution-reports.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const agents={codex:'Codex',anti:'Anti',antigravity:'Anti',claude:'Claude'};
export function reportOptions(args){
 const allowed=['agent','role','coordinator','plan-file','step-line','event','run-id','session-id','result','revision','repos-dir','state-file','slots-file','script','record-only'];
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
  if(options.origin==='cli-runner')record.origin='cli-runner';
  // Verify again before publishing; source task files are never changed by reporting.
  if(readPlan(file).revision!==plan.revision)throw Error('Plan changed while preparing the report. Re-read before retrying.');
  const temporary=join(directory,record.id+'.tmp');
  try{writeFileSync(temporary,JSON.stringify(record),{flag:'wx'});renameSync(temporary,join(directory,record.id+'.json'));}
  finally{try{unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }finally{closeSync(fd);unlinkSync(lock);}
 if(options['record-only']==='true')return {...record,stateFile:state,message:'task-report: '+agent+' '+event+' recorded; app watcher/F5 owns refresh; run-id '+runId};
 const script=resolve(options.script || join(root,'tasks-overview.mjs'));
 const slots=resolve(options['slots-file'] || process.env.KRIK_SLOTS_FILE || 'D:/1_PROJECTS/_WORKTREES/slots.json');
 const refresh=spawnSync(process.execPath,[script],{env:{...process.env,KRIK_REPOS_DIR:repos,KRIK_STATE_FILE:state,KRIK_TASKS_OUT_DIR:dirname(state),KRIK_SLOTS_FILE:slots},encoding:'utf8',windowsHide:true,timeout:30000});
 if(refresh.error || refresh.status!==0)throw Error('Report '+record.id+' (run-id '+runId+') recorded, but overview refresh failed: '+(refresh.error?.message || refresh.stderr));
 let snapshot;try{snapshot=JSON.parse(readFileSync(state,'utf8'));}catch(e){throw Error('Report recorded, but refreshed state is invalid: '+e.message);}
 const confirmed=snapshot.plans?.find(p=>p.repo===parts[0] && p.name===basename(file,'.md'))?.executionReports?.some(r=>r.id===record.id);
 if(!confirmed)throw Error('Report recorded, but the refreshed state did not confirm it.');
 return {...record,stateFile:state,message:'task-report: '+agent+' '+event+' -> '+parts[0]+'/'+basename(file,'.md')+'; run-id '+runId};
}
export function resolveWorkerCommand(agent,command){
 const names={Codex:['codex'],Anti:['anti','antigravity'],Claude:['claude']};
 if(!names[agent]?.includes(basename(command).replace(/\.(?:exe|cmd|ps1)$/i,'').toLowerCase()))throw Error('The CLI executable must match the reported client identity.');
 if(process.platform!=='win32')return command;
 let found;
 const directories=isAbsolute(command)?[dirname(command)]:(process.env.PATH || '').split(';');
 const base=basename(command);
 for(const dir of directories){for(const ext of /\.(exe|cmd)$/i.test(base)?['']:['.exe','.cmd','']){const file=join(dir,base+ext);if(existsSync(file)){found=file;break;}}if(found)break;}
 if(!found)throw Error('The requested CLI is not installed.');
 if(/\.exe$/i.test(found))return found;
 if(agent==='Codex'){
  const packageRoot=join(dirname(found),'node_modules','@openai','codex'),triple=process.arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
  let vendor=join(packageRoot,'vendor');
  try{vendor=join(dirname(createRequire(pathToFileURL(join(packageRoot,'bin','codex.js'))).resolve('@openai/codex-win32-'+process.arch+'/package.json')),'vendor');}catch{/* Older installations bundle vendor directly. */}
  for(const subdir of ['bin','codex']){const binary=join(vendor,triple,subdir,'codex.exe');if(existsSync(binary))return binary;}
 }
 throw Error('Pass the native CLI executable. Shell launchers are not executed through a string-built command.');
}

// The host records the actual child lifecycle outside the worker's sandbox.
// A successful CLI exit closes its run; it never completes the business task.
export async function runTaskCLI(options,command,args){
 const agent=agents[String(options.agent || '').toLowerCase()],executable=resolveWorkerCommand(agent,command);
 const plan=readPlan(options['plan-file']);if(!plan.points.some(p=>p.line===Number(options['step-line'])))throw Error('Select the actual source task before launching the CLI.');
 const parent=agents[String(plan.agentLabel || '').toLowerCase()],supplied=agents[String(options.coordinator || '').toLowerCase()],coordinator=parent || supplied;
 if(!coordinator || (options.coordinator && !supplied) || (parent && supplied && parent!==supplied))throw Error('Preserve the actual parent coordinator before launching the CLI.');
 const repos=realpathSync(resolve(options['repos-dir'] || process.env.KRIK_REPOS_DIR || 'D:/1_PROJECTS/_REPOS')),parts=relative(repos,realpathSync(options['plan-file'])).split(sep);
 if(parts.length!==3 || parts[0]==='..' || parts[1]!=='.tasks' || basename(options['plan-file']).toLowerCase()==='tong-hop.md')throw Error('Select a task in the main checkout .tasks directory.');
 if(options.event || options['run-id'])throw Error('The CLI runner owns its execution lifecycle.');
 const shared={...options,agent,role:'executor',origin:'cli-runner','record-only':'true','run-id':randomUUID()};
 return new Promise((resolveRun,reject)=>{
  let started,failed=false;
  const child=spawn(executable,args,{stdio:'inherit',windowsHide:true,env:{...process.env,WORKBOARD_HOST_REPORTING:'1',WORKBOARD_RUN_ID:shared['run-id'],WORKBOARD_PLAN_FILE:options['plan-file'],WORKBOARD_STEP_LINE:String(options['step-line']),WORKBOARD_AGENT:agent,WORKBOARD_COORDINATOR:coordinator}});
  const interrupt=()=>child.kill();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const cleanup=()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);};
  child.once('spawn',()=>{try{started=reportTask({...shared,event:'start',result:agent+' execution started.'});console.error(started.message);}catch(e){failed=true;child.kill();cleanup();reject(e);}});
  child.once('error',e=>{failed=true;cleanup();reject(e);});
  child.once('close',(code,signal)=>{
   cleanup();if(failed)return;
   try{if(!started)throw Error('The CLI did not start.');const result=agent+' execution '+(code===0?'finished successfully.':'ended with '+(signal || 'exit '+code)+'.')+' Task completion follows the source plan.';const receipt=reportTask({...shared,'run-id':started.runId,event:code===0?'done':'blocked',result});console.error(receipt.message);resolveRun(code ?? 1);}catch(e){reject(e);}
  });
 });
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const args=process.argv.slice(2);
  if(args[0]==='--run-cli'){
   const divider=args.indexOf('--');if(divider<0 || !args[divider+1])throw Error('Use --run-cli <report options> -- <actual CLI> <arguments>.');
   runTaskCLI(reportOptions(args.slice(1,divider)),args[divider+1],args.slice(divider+2)).then(code=>{process.exitCode=code;}).catch(e=>{console.error('task-report: '+e.message);process.exitCode=1;});
  }else console.log(reportTask(reportOptions(args)).message);
 }catch(e){console.error('task-report: '+e.message);process.exitCode=1;}
}
