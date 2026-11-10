#!/usr/bin/env node
// The same explicit publishing command for Codex, Antigravity and Claude.
// This command validates, then regenerates the overview; it never edits a plan.
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve, basename, join, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseExecutors} from './execution-roles.mjs';
import {reportTask} from './task-report.mjs';
import {loadExecutionReports,reportDirectory} from './execution-reports.mjs';
import {resolveSettings,locatePlan,planNotFound,collectorRun,sameProjectPlan} from './plan-reader.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const agents={codex:'Codex',anti:'Anti',antigravity:'Anti',claude:'Claude'};
const stages=['Planning','Implementing','Reviewing','Fixing review','Testing','Waiting for CI','Waiting for owner','Shipping','Blocked','Done'];
export function optionsFrom(args){
  const out={};
  const flags=new Set(['agent','role','plan-file','repos-dir','slots-file','state-file','script','event','step-line','run-id','session-id','result','revision','coordinator']);
  for(let i=0;i<args.length;i++){
    const key=args[i].replace(/^--/,'');
    if(!args[i].startsWith('--') || !flags.has(key) || !args[i+1] || args[i+1].startsWith('--'))throw Error('Use --agent Codex|Anti|Claude --plan-file <absolute plan path>.');
    out[key]=args[++i];
  }
  return out;
}
export function publishTask(options){
  if(options.event)return reportTask(options);
  const agent=agents[String(options.agent || '').toLowerCase()];
  const role=options.role || 'coordinator';
  if(!['coordinator','executor'].includes(role))throw Error('Role must be coordinator or executor.');
  if(!agent || !options['plan-file'] || !isAbsolute(options['plan-file']))throw Error('Agent and absolute plan-file are required.');
  const settings=resolveSettings(options);
  const located=locatePlan(options['plan-file'],settings.projects);
  if(!located)throw Error(planNotFound(settings));
  const file=located.file;
  const before=readFileSync(file);
  const lines=before.toString('utf8').replace(/^\uFEFF/,'').split(/\r?\n/);
  const header=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim();
    if((i>0 && line.startsWith('#')) || line.startsWith('```') || line.startsWith('~~~'))break;
    header.push(line);
  }
  const values=key=>header.filter(l=>l.toLowerCase().startsWith(key.toLowerCase()+':')).map(l=>l.slice(l.indexOf(':')+1).trim());
  const declared=values('Agent'), status=values('Status').length?values('Status'):values('Trạng thái');
  const coordinator=declared.length===1?agents[declared[0].toLowerCase()]:null;
  if(!coordinator || (role==='coordinator' && coordinator!==agent))throw Error('Set exactly one Agent: '+agent+' header in your own plan before publishing.');
  const workerHeaders=values('Executor').concat(values('Executors'));
  if(workerHeaders.length>1)throw Error('Set exactly one Executor: header.');
  const executors=workerHeaders.length?parseExecutors(workerHeaders[0]):null;
  if(workerHeaders.length && executors===null && workerHeaders[0].toLowerCase()!=='unknown')throw Error('Unsupported Executor: value.');
  const state=settings.stateFile;
  if(role==='executor' && (!executors || !executors.includes(agent)) && !loadExecutionReports(reportDirectory(state)).some(r=>r.agent===agent && resolve(r.file).toLowerCase()===file.toLowerCase()))throw Error('The parent plan must list '+agent+' in Executor: or have an actual execution report from this client.');
  if(status.length!==1 || !stages.includes(status[0].split(' - ')[0]))throw Error('Set exactly one supported Status: stage before publishing.');
  const script=resolve(options.script || join(root,'tasks-overview.mjs'));
  if(!existsSync(script))throw Error('Overview script not found: '+script);
  const run=collectorRun(settings,options);
  const result=spawnSync(process.execPath,[script,...run.args],{
    env:run.env,
    encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024,
  });
  if(result.error || result.status!==0)throw Error('Overview refresh failed: '+(result.error?.message || result.stderr?.trim() || 'exit '+result.status));
  let snapshot;
  try{snapshot=JSON.parse(readFileSync(state,'utf8'));}catch(error){throw Error('Generated state is invalid: '+error.message);}
  const name=basename(file,'.md');
  const plan=snapshot.plans?.find(p=>sameProjectPlan(p,located,name));
  const declaredResult=plan && Object.hasOwn(plan,'declaredExecutors')?plan.declaredExecutors:plan?.executors ?? null;
  if(!plan || plan.agent!==coordinator || JSON.stringify(declaredResult)!==JSON.stringify(executors) || plan.revision!==createHash('sha256').update(before).digest('hex'))throw Error('The generated state did not confirm this plan, agent roles and revision. Re-read the plan before retrying.');
  if(!readFileSync(file).equals(before))throw Error('Plan changed while publishing; re-read it and sync again.');
  return {agent,role,coordinator,executors,repo:located.repo,project:located.project.id,plan:name,stateFile:state,message:'task-sync: '+agent+' ('+role+'; coordinator '+coordinator+') -> '+located.repo+'/'+name+' -> '+state};
}
export function claudeReportingHook(event){
  const kind=event.hook_event_name,runtime=root.replaceAll('\\','/');
  const context='Workboard reporting: read the shared task-plan skill. For a directly controlled plan use Agent: Claude; preserve the actual parent Agent for delegated work. Report the actual executor, never infer it from the coordinator. For Codex/Anti/Claude CLI work, run the host wrapper: node "'+runtime+'/task-report.mjs" --run-cli --agent <actual CLI client> --coordinator <actual controller> --plan-file <absolute main-checkout plan> --step-line <source task line> -- <native CLI> <original arguments>. The host records execution outside the worker sandbox; do not widen the worker sandbox or write another session\'s plan. A CLI exit does not complete the business task.';
  if(kind==='SessionStart')return {hookSpecificOutput:{hookEventName:kind,additionalContext:context}};
  const input=event.tool_input || {},file=input.file_path || input.path || '';
  const task=isAbsolute(file) && /[\\/]\.tasks[\\/][^\\/]+\.md$/i.test(file) && basename(file).toLowerCase()!=='tong-hop.md';
  if(kind==='PreToolUse' && task && ['Write','Edit'].includes(event.tool_name)){
    let candidate=event.tool_name==='Write'?input.content:null;
    if(event.tool_name==='Edit' && existsSync(file)){
      const before=readFileSync(file,'utf8');
      if(typeof input.old_string==='string' && before.includes(input.old_string))candidate=input.replace_all?before.split(input.old_string).join(input.new_string || ''):before.replace(input.old_string,input.new_string || '');
    }
    if(typeof candidate==='string' && !/^Agent:\s*(?:Codex|Anti|Claude)\s*$/mi.test(candidate.split(/^##\s/m)[0]))return {hookSpecificOutput:{hookEventName:kind,permissionDecision:'deny',permissionDecisionReason:'This task plan is missing an explicit Agent header. Add the actual coordinator identity using the shared task-plan protocol; do not infer or assign the executor. '+context}};
  }
  if(kind==='PostToolUse' && (task || event.tool_name==='Bash' && /(?:\.tasks[\\/]|\bcodex(?:\.exe|\.cmd)?\s+exec\b|\bantigravity\b)/i.test(input.command || '')))return {hookSpecificOutput:{hookEventName:kind,additionalContext:context}};
  return {};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{if(process.argv[2]==='--claude-hook'){const raw=readFileSync(0,'utf8');console.log(JSON.stringify(raw.length<=524288?claudeReportingHook(JSON.parse(raw)):{}));}else console.log(publishTask(optionsFrom(process.argv.slice(2))).message);}
  catch(error){console.error('task-sync: '+error.message);process.exitCode=1;}
}
