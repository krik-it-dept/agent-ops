import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishTask} from './task-sync.mjs';
import {installReporting} from './integrations/install-task-reporting.mjs';

const workspace=dirname(fileURLToPath(import.meta.url));
function isolated(t){
  const root=mkdtempSync(join(workspace,'.test-reporting-'));
  t.after(()=>{
    if(dirname(resolve(root))!==workspace || !root.startsWith(join(workspace,'.test-reporting-')))throw Error('Unsafe fixture cleanup path');
    rmSync(root,{recursive:true,force:true});
  });
  return root;
}
function put(file,text){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text,'utf8');}
function fixture(t){
  const root=isolated(t),repos=join(root,'repos'),state=join(root,'out','state.json'),slots=join(root,'slots.json');
  mkdirSync(repos,{recursive:true});mkdirSync(dirname(state),{recursive:true});put(slots,'{}');
  const options={'repos-dir':repos,'state-file':state,'slots-file':slots};
  return {root,repos,state,options};
}
test('Installer connects all clients to one shared skill and preserves existing instructions with backups',t=>{
  const root=isolated(t),home=join(root,'profile');
  const codex=join(home,'.codex','AGENTS.md'),claude=join(home,'.claude','CLAUDE.md');
  put(codex,'# Existing Codex instructions\nKeep my conventions.\n');
  put(claude,'# Existing owner instructions\nKeep all production constraints.\n');
  const result=installReporting(home);
  assert.equal(result.changed.length,5);assert.ok(result.backup);
  for(const [client,file]of [['Codex',codex],['Claude',claude],['Anti',join(home,'.gemini','GEMINI.md')]]){
    const text=readFileSync(file,'utf8');
    assert.ok(text.includes('Agent: '+client));
    assert.ok(text.includes(result.shared.replaceAll('\\','/')));
  }
  assert.ok(readFileSync(codex,'utf8').startsWith('# Existing Codex instructions\nKeep my conventions.\n'));
  assert.equal(readFileSync(join(result.backup,'.claude','CLAUDE.md'),'utf8'),'# Existing owner instructions\nKeep all production constraints.\n');
  const skill=readFileSync(result.shared,'utf8');
  assert.ok(skill.includes('task-sync.mjs'));assert.ok(skill.includes('Agent: <Codex | Anti | Claude>'));
  assert.equal(readFileSync(join(home,'.claude','skills','task-plan','SKILL.md'),'utf8'),skill);
});
test('Installer renders an explicit portable runtime and rejects missing files before touching profiles',t=>{
  const root=isolated(t),home=join(root,'profile'),runtime=join(root,'custom runtime');
  assert.throws(()=>installReporting(home,runtime),/Runtime directory/);
  assert.ok(!existsSync(home));
  for(const name of ['task-sync.mjs','task-report.mjs','tasks-overview.mjs'])put(join(runtime,name),'// Fixture');
  const result=installReporting(home,runtime),skill=readFileSync(result.shared,'utf8');
  assert.ok(skill.includes(runtime.replaceAll('\\','/')));
  assert.ok(!skill.includes('{{WORKBOARD_DIR}}'));
  assert.deepEqual(installReporting(home,runtime).changed,[]);
});

test('Installing twice makes no duplicate rules or extra edits',t=>{
  const home=join(isolated(t),'profile');
  installReporting(home);
  const before=readFileSync(join(home,'.codex','AGENTS.md'),'utf8');
  const again=installReporting(home);
  assert.deepEqual(again.changed,[]);assert.equal(again.backup,null);
  assert.equal(readFileSync(join(home,'.codex','AGENTS.md'),'utf8'),before);
  assert.equal((before.match(/workboard-task-reporting:start/g)||[]).length,1);
});
test('Malformed managed blocks are rejected before any file is changed',t=>{
  const home=join(isolated(t),'profile'),file=join(home,'.gemini','GEMINI.md');
  put(file,'Owner text\n<!-- workboard-task-reporting:start -->\nUnfinished manual edit');
  assert.throws(()=>installReporting(home),/Incomplete managed block/);
  assert.ok(!existsSync(join(home,'.agents','skills','task-plan','SKILL.md')));
  assert.ok(!existsSync(join(home,'.codex','AGENTS.md')));
});
test('Codex, Anti and Claude publish real plan content into one state without rewriting any plan',t=>{
  const f=fixture(t),files=[];
  for(const agent of ['Codex','Anti','Claude']){
    const file=join(f.repos,agent.toLowerCase(),'.tasks','delivery.md');
    const text='Agent: '+agent+'\nStatus: Implementing\nNext: Verify results\nGoal: Shared reporting\n\n## M1: Work\n- [doing] Build\n- [todo] Test\n';
    put(file,text);files.push([agent,file,text]);
  }
  for(const [agent,file]of files){
    const receipt=publishTask({...f.options,agent,'plan-file':file});
    assert.equal(receipt.agent,agent);assert.equal(receipt.stateFile,f.state);
  }
  const state=JSON.parse(readFileSync(f.state,'utf8'));
  assert.deepEqual(state.plans.map(p=>p.agent).sort(),['Anti','Claude','Codex']);
  assert.equal(state.plans.length,3);
  for(const [,file,text]of files)assert.equal(readFileSync(file,'utf8'),text);
});

test('Task assignments are independent of the coordinator and plan executors and survive shared sync',t=>{
 const f=fixture(t),file=join(f.repos,'sample','.tasks','work.md');
 const source='Agent: Claude\nExecutor: Codex, Anti\nStatus: Implementing\n\n## M1: Tasks\n- [doing] Build <!-- Executor: Codex -->\n- [todo] Review <!-- Executor: Anti, Codex -->\n- [done] Previous work <!-- Executor: Claude -->\n- [todo] Not assigned <!-- Executor: None -->\n- [todo] Unknown\n\n```md\n- [todo] Example <!-- Executor: Anti -->\n```\n';
 put(file,source);publishTask({...f.options,agent:'Codex',role:'executor','plan-file':file});
 const p=JSON.parse(readFileSync(f.state,'utf8')).plans[0];
 assert.equal(p.agent,'Claude');assert.deepEqual(p.executors,['Codex','Anti']);
 assert.equal(p.steps.length,5);
 assert.deepEqual(p.steps.map(s=>s.executors),[['Codex'],['Codex','Anti'],['Claude'],[],null]);
 assert.deepEqual(p.steps.map(s=>s.line),[6,7,8,9,10]);
 assert.deepEqual(p.milestones[0].steps,p.steps);
 assert.ok(p.steps.every(s=>!s.text.includes('<!--')));assert.equal(readFileSync(file,'utf8'),source);
});
test('Wrong or missing agent identity fails before refreshing the overview',t=>{
  const f=fixture(t),file=join(f.repos,'sample','.tasks','work.md');
  put(file,'Agent: Claude\nStatus: Implementing\n');
  assert.throws(()=>publishTask({...f.options,agent:'Codex','plan-file':file}),/Agent: Codex/);
  assert.ok(!existsSync(f.state));assert.equal(readFileSync(file,'utf8'),'Agent: Claude\nStatus: Implementing\n');
  put(file,'Status: Implementing\n');
  assert.throws(()=>publishTask({...f.options,agent:'Anti','plan-file':file}),/Agent: Anti/);
});
test('Private brain artifacts and generated indexes are never published as shared plans',t=>{
  const f=fixture(t),brain=join(f.root,'brain','session','task.md');
  put(brain,'Agent: Anti\nStatus: Implementing\n- [todo] Build\n');
  assert.throws(()=>publishTask({...f.options,agent:'Anti','plan-file':brain}),/main checkout/);
  const index=join(f.repos,'sample','.tasks','tong-hop.md');
  put(index,'Agent: Claude\nStatus: Done\n');
  assert.throws(()=>publishTask({...f.options,agent:'Claude','plan-file':index}),/main checkout/);
});
test('An unsupported stage is rejected without publishing or altering the plan',t=>{
  const f=fixture(t),file=join(f.repos,'sample','.tasks','work.md');
  put(file,'Agent: Codex\nStatus: Almost done\n');
  assert.throws(()=>publishTask({...f.options,agent:'Codex','plan-file':file}),/supported Status/);
  assert.ok(!existsSync(f.state));assert.equal(readFileSync(file,'utf8'),'Agent: Codex\nStatus: Almost done\n');
});
test('Generator failure, invalid JSON and an unconfirmed revision never report success',t=>{
  const f=fixture(t),file=join(f.repos,'sample','.tasks','work.md'),script=join(f.root,'fake.mjs');
  put(file,'Agent: Codex\nStatus: Implementing\n');
  const options={...f.options,agent:'Codex','plan-file':file,script};
  put(script,"throw Error('deliberate generator failure')");
  assert.throws(()=>publishTask(options),/Overview refresh failed.*deliberate generator failure/s);
  put(script,"import fs from 'node:fs';fs.writeFileSync(process.env.KRIK_STATE_FILE,'broken')");
  assert.throws(()=>publishTask(options),/Generated state is invalid/);
  put(script,"import fs from 'node:fs';fs.writeFileSync(process.env.KRIK_STATE_FILE,JSON.stringify({plans:[{repo:'sample',name:'work',agent:'Codex',revision:'wrong'}]}))");
  assert.throws(()=>publishTask(options),/did not confirm.*revision/);
});
test('Claude can coordinate Codex and Anti CLI workers without losing parent ownership',t=>{
 const f=fixture(t),file=join(f.repos,'sample','.tasks','parent.md');
 const original='Agent: Claude\nExecutor: Codex, Anti\nStatus: Implementing\nNext: Review worker results\n\n- [doing] Codex implements\n- [doing] Anti verifies\n';
 put(file,original);
 for(const agent of ['Codex','Anti']){
  const receipt=publishTask({...f.options,agent,role:'executor','plan-file':file});
  assert.equal(receipt.coordinator,'Claude');assert.equal(receipt.role,'executor');
  assert.deepEqual(receipt.executors,['Codex','Anti']);
 }
 const state=JSON.parse(readFileSync(f.state,'utf8'));
 assert.equal(state.plans[0].agent,'Claude');assert.deepEqual(state.plans[0].executors,['Codex','Anti']);
 assert.equal(readFileSync(file,'utf8'),original);
 assert.throws(()=>publishTask({...f.options,agent:'Codex','plan-file':file}),/Agent: Codex/);
 put(file,original.replace('Executor: Codex, Anti','Executor: Codex'));
 assert.throws(()=>publishTask({...f.options,agent:'Anti',role:'executor','plan-file':file}),/must list Anti/);
});
test('Direct execution keeps coordinator and executor as the same client',t=>{
 const f=fixture(t),file=join(f.repos,'sample','.tasks','direct.md');
 put(file,'Agent: Claude\nExecutor: Claude\nStatus: Implementing\n');
 const receipt=publishTask({...f.options,agent:'Claude','plan-file':file});
 assert.equal(receipt.coordinator,'Claude');assert.deepEqual(receipt.executors,['Claude']);
});
