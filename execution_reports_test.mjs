import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {reportTask} from './task-report.mjs';
import {publishTask} from './task-sync.mjs';
import {loadExecutionReports,reportDirectory} from './execution-reports.mjs';

const workspace=dirname(fileURLToPath(import.meta.url));
function fixture(t,source='Agent: Claude\nStatus: Implementing\n\n## M1: Delivery\n- [todo] Build\n- [todo] Verify\n'){
 const root=mkdtempSync(join(workspace,'.test-execution-'));
 t.after(()=>{if(dirname(resolve(root))!==workspace)throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});
 const repos=join(root,'repos'),file=join(repos,'sample','.tasks','work.md'),state=join(root,'output','state.json'),slots=join(root,'slots.json');
 mkdirSync(dirname(file),{recursive:true});mkdirSync(dirname(state),{recursive:true});writeFileSync(file,source);writeFileSync(slots,'{}');
 const options={'repos-dir':repos,'state-file':state,'slots-file':slots,'plan-file':file,agent:'Codex',role:'executor'};
 return {root,file,state,source,options,plan:()=>JSON.parse(readFileSync(state,'utf8')).plans[0]};
}

test('Executing clients report start and result without user assignment or changing source tasks',t=>{
 const f=fixture(t),mtime=statSync(f.file).mtimeMs;
 const start=reportTask({...f.options,event:'start','step-line':'5','session-id':'codex-session'});
 let p=f.plan();assert.equal(p.agent,'Claude');assert.deepEqual(p.executors,['Codex']);assert.equal(p.steps[0].status,'doing');assert.equal(p.steps[1].status,'todo');
 assert.equal(p.steps[0].execution.source,'Agent execution report');assert.equal(p.executionReports[0].session,'codex-session');
 // Normal shared-plan publishing also accepts an observed worker without an assignment header.
 publishTask({...f.options});
 const done=reportTask({...f.options,event:'done','run-id':start.runId,result:'Unit tests passed; commit abc123'});
 p=f.plan();assert.equal(done.coordinator,'Claude');assert.equal(p.steps[0].status,'done');assert.equal(p.steps[0].sourceStatus,'todo');
 assert.equal(p.steps[0].execution.result,'Unit tests passed; commit abc123');assert.equal(p.executionReports.length,2);
 assert.equal(readFileSync(f.file,'utf8'),f.source);assert.equal(statSync(f.file).mtimeMs,mtime);
});

test('Three clients report into one place, with Multi contributors and separate current workers',t=>{
 const f=fixture(t),runs=[];
 for(const agent of ['Claude','Codex','Anti'])runs.push(reportTask({...f.options,agent,event:'start','step-line':'5'}));
 let p=f.plan();assert.deepEqual(p.steps[0].executors,['Codex','Anti','Claude']);assert.deepEqual(p.steps[0].execution.activeAgents,['Codex','Anti','Claude']);assert.equal(p.agent,'Claude');
 reportTask({...f.options,agent:'Codex',event:'done','run-id':runs[1].runId,result:'Implementation verified'});
 p=f.plan();assert.equal(p.steps[0].status,'doing');assert.deepEqual(p.steps[0].execution.activeAgents,['Anti','Claude']);
 for(const [i,agent]of [[0,'Claude'],[2,'Anti']])reportTask({...f.options,agent,event:'done','run-id':runs[i].runId,result:'Checks passed'});
 p=f.plan();assert.equal(p.steps[0].status,'done');assert.deepEqual(p.steps[0].execution.activeAgents,[]);assert.equal(p.executionReports.length,6);
});

test('Reporter rejects false completions, stale revisions, parent relabelling and cross-client run reuse',t=>{
 const f=fixture(t);
 assert.throws(()=>reportTask({...f.options,event:'done',result:'done'}),/run-id/);
 assert.throws(()=>reportTask({...f.options,event:'start','step-line':'1'}),/actual checklist task/);
 assert.throws(()=>reportTask({...f.options,event:'start','step-line':'5',revision:'a'.repeat(64)}),/Plan changed/);
 assert.throws(()=>reportTask({...f.options,event:'start','step-line':'5',coordinator:'Codex'}),/parent coordinator/);
 const run=reportTask({...f.options,event:'start','step-line':'5'});
 assert.throws(()=>reportTask({...f.options,event:'done','run-id':run.runId}),/requires --result/);
 assert.throws(()=>reportTask({...f.options,agent:'Anti',event:'done','run-id':run.runId,result:'done'}),/same executing client/);
 assert.throws(()=>reportTask({...f.options,event:'progress','run-id':run.runId,'step-line':'6'}),/does not match/);
 assert.equal(loadExecutionReports(reportDirectory(f.state)).length,1);
 assert.equal(readFileSync(f.file,'utf8'),f.source);
});

test('A blocked run can be retried; old failures never keep a successful retry blocked',t=>{
 const f=fixture(t),first=reportTask({...f.options,event:'start','step-line':'5'});
 reportTask({...f.options,event:'blocked','run-id':first.runId,result:'CI is unavailable'});assert.equal(f.plan().steps[0].status,'blocked');
 assert.throws(()=>reportTask({...f.options,event:'progress','run-id':first.runId}),/already finished/);
 const retry=reportTask({...f.options,event:'start','step-line':'5'});
 reportTask({...f.options,event:'done','run-id':retry.runId,result:'CI passed on retry'});assert.equal(f.plan().steps[0].status,'done');
});

test('Reports survive unrelated source edits without assigning a different or ambiguous task',t=>{
 const f=fixture(t),run=reportTask({...f.options,event:'start','step-line':'5'});
 writeFileSync(f.file,'\n'+f.source);
 reportTask({...f.options,event:'done','run-id':run.runId,result:'Build verified'});
 assert.equal(f.plan().steps[0].line,6);assert.equal(f.plan().steps[0].status,'done');assert.equal(f.plan().steps[1].status,'todo');
 const other=fixture(t,'Agent: Claude\nStatus: Implementing\n\n## M1: Same\n- [todo] Duplicate\n- [todo] Duplicate\n');
 const duplicate=reportTask({...other.options,event:'start','step-line':'6'});
 assert.equal(other.plan().steps[0].status,'todo');assert.equal(other.plan().steps[1].status,'doing');
 writeFileSync(other.file,'\n'+other.source);
 assert.throws(()=>reportTask({...other.options,event:'done','run-id':duplicate.runId,result:'verified'}),/ambiguous|re-read/);
});

test('Repeated progress checks reread reports without creating work or altering evidence',t=>{
 const f=fixture(t);reportTask({...f.options,event:'start','step-line':'5'});
 const directory=reportDirectory(f.state),files=readdirSync(directory),reportBytes=files.map(n=>readFileSync(join(directory,n),'utf8'));
 for(let i=0;i<3;i++)publishTask({...f.options,agent:'Claude',role:'coordinator'});
 assert.deepEqual(readdirSync(directory),files);assert.deepEqual(files.map(n=>readFileSync(join(directory,n),'utf8')),reportBytes);
 assert.equal(f.plan().executionReports.length,1);assert.equal(readFileSync(f.file,'utf8'),f.source);
});

test('A failed refresh preserves execution evidence and never claims the overview was updated',t=>{
 const f=fixture(t),script=join(f.root,'fail.mjs');writeFileSync(script,"throw Error('collector failed')");
 assert.throws(()=>reportTask({...f.options,event:'start','step-line':'5',script}),/recorded, but overview refresh failed/);
 assert.equal(loadExecutionReports(reportDirectory(f.state)).length,1);assert.equal(readFileSync(f.file,'utf8'),f.source);
});

test('CLI reporting works without preassigned agent metadata, including a delegated parent and direct Anti',t=>{
 const f=fixture(t,'Status: Implementing\n\n- [todo] Build\n');
 const args=Object.entries({...f.options,coordinator:'Claude',event:'start','step-line':'3'}).flatMap(([k,v])=>['--'+k,v]);
 const start=spawnSync(process.execPath,[join(workspace,'task-sync.mjs'),...args],{encoding:'utf8',windowsHide:true});
 assert.equal(start.status,0,start.stderr);const runId=start.stdout.match(/run-id ([a-f0-9-]{36})/)?.[1];assert.ok(runId);
 assert.equal(f.plan().agent,'Claude');assert.deepEqual(f.plan().executors,['Codex']);
 const doneArgs=Object.entries({...f.options,event:'done','run-id':runId,result:'CLI output verified'}).flatMap(([k,v])=>['--'+k,v]);
 const done=spawnSync(process.execPath,[join(workspace,'task-report.mjs'),...doneArgs],{encoding:'utf8',windowsHide:true});
 assert.equal(done.status,0,done.stderr);assert.equal(f.plan().steps[0].status,'done');
 const anti=fixture(t,'Status: Implementing\n\n- [todo] Verify\n');
 reportTask({...anti.options,agent:'Anti',role:'coordinator',event:'start','step-line':'3'});
 assert.equal(anti.plan().agent,'Anti');assert.deepEqual(anti.plan().executors,['Anti']);
});
