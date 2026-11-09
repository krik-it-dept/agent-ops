#!/usr/bin/env node
// One-off import from reviewed evidence references. This never writes source plans.
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readPlan} from '../plan-reader.mjs';
import {taskLocator} from '../execution-reports.mjs';
import {loadHistoricalExecutions} from '../historical-executions.mjs';

const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
function plain(value){return typeof value==='string'?value:(value || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');}
export function importExecutionHistory(manifest,output){
 const cache=new Map();
 function log(file){
  file=resolve(file);if(cache.has(file))return cache.get(file);
  const calls=new Map(),results=new Map(),messages=new Map();let session=null;
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)){
   if(!line)continue;let x;try{x=JSON.parse(line);}catch{continue;}
   if(x.type==='session_meta')session=x.payload;
   if(x.type==='response_item' && x.payload?.type==='message' && x.payload.role==='assistant' && x.payload.phase==='final_answer'){
    const text=(x.payload.content || []).filter(c=>c.type==='output_text').map(c=>c.text).join('\n');
    if(x.payload.id && text)messages.set(x.payload.id,{text,at:x.timestamp,codex:true});
   }
   const content=x.message?.content;
   if((x.message?.role==='assistant' || x.type==='assistant') && Array.isArray(content) && content.some(c=>c.type==='text')){
    const old=messages.get(x.uuid);if(!old || x.timestamp)messages.set(x.uuid,{text:plain(content),at:x.timestamp});
   }
   if(!Array.isArray(content))continue;
   for(const c of content){
    if(c.type==='tool_use' && (!calls.has(c.id) || x.timestamp))calls.set(c.id,{name:c.name,input:c.input,at:x.timestamp});
    if(c.type==='tool_result' && (!results.has(c.tool_use_id) || x.timestamp))results.set(c.tool_use_id,{text:plain(c.content),error:!!c.is_error,at:x.timestamp});
   }
  }
  const parsed={calls,results,messages,session};cache.set(file,parsed);return parsed;
 }
 function proof(ref){
  const data=log(ref.log);
  if(ref.kind==='worker-handoff'){
   const call=data.calls.get(ref.call),text=call?.input?.message;
   if(call?.name!=='SubagentHandback' || typeof text!=='string' || !ref.resultPattern || !new RegExp(ref.resultPattern,'su').test(text) || data.results.get(ref.call)?.error)throw Error('Worker handoff result not verified: '+ref.call);
   return {sourceLog:resolve(ref.log),messageId:ref.call,tool:'worker-handoff',at:call.at || null,inputHash:digest(call.input),resultHash:digest(text)};
  }
  if(ref.kind==='assistant-result' || ref.kind==='codex-result'){
   const message=data.messages.get(ref.message);
   if(!message || !ref.resultPattern || !new RegExp(ref.resultPattern,'su').test(message.text))throw Error('Assistant result not verified: '+ref.message);
   if(ref.kind==='codex-result' && (!message.codex || data.session?.originator!=='codex_exec'))throw Error('Result is not from a Codex CLI execution session');
   return {sourceLog:resolve(ref.log),messageId:ref.message,tool:ref.kind,at:message.at || null,inputHash:digest(ref.kind==='codex-result'?data.session:'assistant-result'),resultHash:digest(message.text)};
  }
  const call=data.calls.get(ref.call),result=data.results.get(ref.call);
  if(!call || !result || result.error || /^(?:Command running in background|Async agent launched|Monitor started)/i.test(result.text))throw Error('Tool execution has no completed successful result: '+ref.call);
  const input=JSON.stringify(call.input);
  if(!ref.inputPattern || !new RegExp(ref.inputPattern,'su').test(input) || !ref.resultPattern || !new RegExp(ref.resultPattern,'su').test(result.text))throw Error('Execution proof does not match reviewed assertions: '+ref.call);
  return {sourceLog:resolve(ref.log),messageId:ref.call,tool:call.name,at:result.at || call.at || null,inputHash:digest(call.input),resultHash:digest(result.text)};
 }
 const records=existsSync(output)?loadHistoricalExecutions(output):[];
 let imported=0;
 for(const item of manifest.plans){
  const file=resolve(item.file),before=readFileSync(file),plan=readPlan(file);
  if(plan.revision!==item.revision)throw Error('Plan revision changed before historical import: '+basename(file));
  for(const task of item.tasks){
   const point=plan.points.find(p=>p.line===task.line);
   if(!point || point.text!==task.text)throw Error('Historical task no longer matches source: '+task.line);
   const contributions=task.contributions.map(c=>{
    const evidence=c.proofs.map(proof);
    if(c.agent==='Codex' && !c.proofs.every(p=>p.kind==='codex-result')){
     const dispatch=c.dispatch,call=dispatch && log(dispatch.log).calls.get(dispatch.call);
     const command=call?.input?.command || '';
     if(!/\bcodex(?:\.cmd|\.exe)?\s+exec\b/.test(command) || !dispatch.artifact || !command.includes(dispatch.artifact) || !c.proofs.some(p=>JSON.stringify(log(p.log).calls.get(p.call)?.input || {}).includes(dispatch.artifact.replace(/\.md$/,''))))throw Error('Codex review lacks its matching CLI invocation and output artifact');
     evidence.unshift({sourceLog:resolve(dispatch.log),messageId:dispatch.call,tool:call.name,at:call.at || null,inputHash:digest(call.input),resultHash:digest('dispatch linked to verified output: '+dispatch.artifact)});
    }else if(c.agent!=='Claude' && c.agent!=='Codex')throw Error('Unsupported historical log provider: '+c.agent);
    return {agent:c.agent,summary:c.summary,evidence};
   });
   const times=contributions.flatMap(c=>c.evidence.map(e=>e.at)).filter(t=>t && Number.isFinite(Date.parse(t))).sort();
   if(!times.length)throw Error('Historical task has no observed verification time: '+task.line);
   const record={file,revision:plan.revision,task:taskLocator(plan,point),verifiedAt:times.at(-1),contributions};
   const old=records.findIndex(r=>resolve(r.file).toLowerCase()===file.toLowerCase() && r.task.line===task.line);
   if(old>=0)records[old]=record;else records.push(record);imported++;
  }
  if(!readFileSync(file).equals(before))throw Error('Source plan changed during import: '+basename(file));
 }
 const temporary=output+'.tmp';writeFileSync(temporary,JSON.stringify({version:1,records},null,2)+'\n');
 loadHistoricalExecutions(temporary);renameSync(temporary,output);
 return {imported,total:records.length,output:resolve(output)};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  if(process.argv.length!==4)throw Error('Usage: node import-execution-history.mjs <reviewed-manifest.json> <historical-executions.json>');
  const manifest=JSON.parse(readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify(importExecutionHistory(manifest,resolve(process.argv[3]))));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
