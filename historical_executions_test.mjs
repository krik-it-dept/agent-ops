import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readPlan} from './plan-reader.mjs';
import {taskLocator,applyExecutionReports} from './execution-reports.mjs';
import {applyHistoricalExecutions,loadHistoricalExecutions} from './historical-executions.mjs';
import {importExecutionHistory} from './integrations/import-execution-history.mjs';

const workspace=dirname(fileURLToPath(import.meta.url)),hash='a'.repeat(64);
function fixture(t){
 const root=mkdtempSync(join(workspace,'.test-history-'));t.after(()=>{if(dirname(resolve(root))!==workspace)throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});
 const repo=join(root,'repo'),file=join(repo,'.tasks','work.md');mkdirSync(dirname(file),{recursive:true});
 const source='Status: Implementing\n\n## M1: Delivery\n- [doing] Build\n- [todo] Next\n';writeFileSync(file,source);
 const p={root:repo,name:'work',...readPlan(file)};
 const record={file,revision:p.revision,task:taskLocator(p,p.points[0]),verifiedAt:'2026-11-07T10:00:00Z',contributions:[{agent:'Claude',summary:'Implemented the feature',evidence:[{sourceLog:'verified.jsonl',messageId:'actual-edit',inputHash:hash,resultHash:hash}]}]};
 return {root,file,source,p,record};
}

test('Historical contributors appear on exact tasks without changing progress, freshness or source files',t=>{
 const f=fixture(t),mtime=statSync(f.file).mtimeMs,before=f.p.points.map(p=>p.status);
 applyExecutionReports(f.p,[]);applyHistoricalExecutions(f.p,[f.record]);
 assert.deepEqual(f.p.points.map(p=>p.status),before);assert.deepEqual(f.p.points[0].executors,['Claude']);assert.equal(f.p.points[0].execution,undefined);
 assert.equal(f.p.points[1].executors,null);assert.equal(f.p.executionUpdatedAt,null);assert.deepEqual(f.p.executionReports,[]);
 assert.deepEqual(f.p.historicalExecutors,['Claude']);assert.equal(f.p.points[0].executionHistory.source,'Verified session history');
 assert.equal(readFileSync(f.file,'utf8'),f.source);assert.equal(statSync(f.file).mtimeMs,mtime);
});

test('Stale revisions and mismatching source lines or task text cannot backfill another task',t=>{
 for(const change of [{revision:hash},{task:{line:5,text:'Next',milestone:'M1'}},{task:{line:4,text:'Reworded',milestone:'M1'}}]){
  const f=fixture(t);applyHistoricalExecutions(f.p,[{...f.record,...change}]);assert.equal(f.p.points[0].executors,null);
 }
});

test('Live execution keeps its own state and active worker while retaining historical contributors',t=>{
 const f=fixture(t),at='2026-11-09T05:00:00Z';
 const report={id:'observed',runId:'actual',file:f.file,revision:f.p.revision,task:taskLocator(f.p,f.p.points[0]),agent:'Codex',coordinator:'Claude',event:'start',at,result:''};
 applyExecutionReports(f.p,[report]);applyHistoricalExecutions(f.p,[f.record]);
 const point=f.p.points[0];assert.deepEqual(point.executors,['Codex','Claude']);assert.deepEqual(point.execution.activeAgents,['Codex']);assert.equal(point.execution.state,'doing');
 assert.equal(f.p.executionUpdatedAt,at);assert.equal(point.execution.reportedAt,at);assert.equal(point.executionHistory.verifiedAt,f.record.verifiedAt);
});

test('Curated import verifies actual log results, supports native worker handoffs and is idempotent',t=>{
 const f=fixture(t),log=join(f.root,'claude.jsonl'),output=join(f.root,'history.json');
 const at='2026-11-07T10:00:00Z';
 writeFileSync(log,[{type:'assistant',timestamp:at,message:{content:[{type:'tool_use',id:'edit',name:'Edit',input:{file_path:'feature.ts',new_string:'implemented'}}]}},{type:'user',timestamp:at,message:{content:[{type:'tool_result',tool_use_id:'edit',content:'File updated',is_error:false}]}},{type:'assistant',timestamp:at,message:{content:[{type:'tool_use',id:'handoff',name:'SubagentHandback',input:{message:'Implementation committed; tests passed'}}]}}].map(x=>JSON.stringify(x)).join('\n'));
 const task={line:4,text:'Build',contributions:[{agent:'Claude',summary:'Implemented and checked',proofs:[{log,call:'edit',inputPattern:'implemented',resultPattern:'File updated'},{log,kind:'worker-handoff',call:'handoff',resultPattern:'tests passed'}]}]};
 const manifest={plans:[{file:f.file,revision:f.p.revision,tasks:[task]}]};
 assert.equal(importExecutionHistory(manifest,output).total,1);const before=readFileSync(output,'utf8');
 importExecutionHistory(manifest,output);assert.equal(readFileSync(output,'utf8'),before);assert.equal(loadHistoricalExecutions(output).length,1);
 assert.equal(readFileSync(f.file,'utf8'),f.source);
 task.contributions[0].proofs[0].resultPattern='invented success';assert.throws(()=>importExecutionHistory(manifest,output),/does not match/);assert.equal(readFileSync(output,'utf8'),before);
});

test('Historical registry rejects missing evidence, duplicate tasks and unsupported contributors',t=>{
 const f=fixture(t),file=join(f.root,'history.json');
 for(const records of [[{...f.record,contributions:[{agent:'Claude',summary:'Guess',evidence:[]}]}],[f.record,f.record],[{...f.record,contributions:[{...f.record.contributions[0],agent:'Guessed agent'}]}]]){
  writeFileSync(file,JSON.stringify({version:1,records}));assert.throws(()=>loadHistoricalExecutions(file),/evidence|contributor|Duplicate/);
 }
});

test('A Codex contributor must be backed by its CLI result; a dispatch alone is not execution evidence',t=>{
 const f=fixture(t),log=join(f.root,'codex.jsonl'),output=join(f.root,'history.json');
 const events=[{type:'session_meta',payload:{id:'observed-session',originator:'codex_exec'}},{type:'response_item',timestamp:'2026-11-07T10:00:00Z',payload:{id:'actual-result',type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Implemented Build; tests passed'}]}}];
 const write=()=>writeFileSync(log,events.map(x=>JSON.stringify(x)).join('\n'));write();
 const contribution={agent:'Codex',summary:'Implemented Build',proofs:[{log,kind:'codex-result',message:'actual-result',resultPattern:'Implemented Build'}]};
 const manifest={plans:[{file:f.file,revision:f.p.revision,tasks:[{line:4,text:'Build',contributions:[contribution]}]}]};
 importExecutionHistory(manifest,output);const before=readFileSync(output,'utf8');
 events[0].payload.originator='unverified-client';write();assert.throws(()=>importExecutionHistory(manifest,output),/not from a Codex CLI/);assert.equal(readFileSync(output,'utf8'),before);
 const asyncLog=join(f.root,'async.jsonl');writeFileSync(asyncLog,[{type:'assistant',message:{content:[{type:'tool_use',id:'spawn',name:'Bash',input:{command:'codex exec'}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'spawn',content:'Command running in background with ID: pending'}]}}].map(x=>JSON.stringify(x)).join('\n'));
 contribution.agent='Claude';contribution.proofs=[{log:asyncLog,call:'spawn',inputPattern:'codex',resultPattern:'background'}];
 assert.throws(()=>importExecutionHistory(manifest,output),/no completed successful result/);assert.equal(readFileSync(output,'utf8'),before);
});
