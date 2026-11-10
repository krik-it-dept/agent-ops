import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,statSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveSettings,projectIdFor,readConfig,defaultDataDir} from './plan-reader.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const put=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
const planText='Agent: Codex\nStatus: Planning\nGoal: Ship\n\n## M1: Build\n- [todo] Step\n';
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'agent-ops-config-'));
  put(join(root,'work','web','.git','HEAD'),'ref');put(join(root,'work','web','.tasks','plan.md'),planText);
  put(join(root,'oss','web','.git','HEAD'),'ref');put(join(root,'oss','web','.tasks','plan.md'),planText);
  put(join(root,'oss','web','.tasks','tong-hop.md'),'generated');
  const config=join(root,'data','config.json');
  const project=(id,path,kind,enabled=true)=>({id,path,name:id,kind,enabled,addedAt:'2026-01-01T00:00:00Z'});
  put(config,JSON.stringify({version:1,setupComplete:true,notifications:true,projects:[project('work',join(root,'work'),'folder'),project('oss',join(root,'oss','web'),'repo'),project('gone',join(root,'missing'),'folder'),project('off',join(root,'off'),'folder',false)]}));
  return {root,config};
}
const env=(extra)=>({...process.env,AGENT_OPS_REPOS_DIR:'',AGENT_OPS_STATE_FILE:'',...extra});

test('Collector reads enabled projects from AGENT_OPS_CONFIG and keeps same-named repositories apart',()=>{
  const {root,config}=fixture();
  try{
    const run=spawnSync(process.execPath,[join(here,'tasks-overview.mjs')],{env:env({AGENT_OPS_CONFIG:config}),encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,run.stderr);
    const state=JSON.parse(readFileSync(join(root,'data','state','tong-hop-chung.json'),'utf8'));
    assert.deepEqual(state.plans.map(p=>p.project+'/'+p.repo+'/'+p.name).sort(),['oss/web/plan','work/web/plan']);
    assert.deepEqual(Object.fromEntries(state.projects.map(p=>[p.id,p.status])),{work:'ok',oss:'ok',gone:'missing'});
    assert.equal(state.projects.find(p=>p.id==='work').plans,1);
    assert.ok(!state.projects.some(p=>p.id==='off'),'disabled projects are not read');
    // A ledger: no run, executor, agent or slot data, even for plans with old headers and comments.
    assert.equal('slots' in state,false);
    for(const plan of state.plans){
      for(const key of ['agent','agentSource','executors','executorSource','declaredExecutors','historicalExecutors','executionReports','executionUpdatedAt','slot'])assert.equal(key in plan,false,key);
      for(const step of plan.steps)assert.deepEqual(Object.keys(step).sort(),['index','line','milestone','status','text']);
    }
    assert.equal(state.plans[0].steps[0].text,'Step');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Precedence is flag, then environment, then config, then default (same as the Go app)',()=>{
  const {root,config}=fixture();
  try{
    const viaConfig=resolveSettings({},env({AGENT_OPS_CONFIG:config}));
    assert.deepEqual(viaConfig.projects.map(p=>p.id),['work','oss','gone']);
    assert.equal(viaConfig.stateFile,join(root,'data','state','tong-hop-chung.json'));
    const viaEnv=resolveSettings({},env({AGENT_OPS_CONFIG:config,AGENT_OPS_REPOS_DIR:join(root,'oss'),AGENT_OPS_STATE_FILE:join(root,'env.json')}));
    assert.deepEqual(viaEnv.projects.map(p=>p.id),[projectIdFor(join(root,'oss'))]);
    assert.equal(viaEnv.stateFile,join(root,'env.json'));assert.equal('slotsFile' in viaEnv,false);
    const viaFlag=resolveSettings({'repos-dir':join(root,'work'),'state-file':join(root,'flag.json')},env({AGENT_OPS_CONFIG:config}));
    assert.deepEqual(viaFlag.projects.map(p=>[p.id,p.kind]),[[projectIdFor(join(root,'work')),'folder']]);
    assert.equal(viaFlag.stateFile,join(root,'flag.json'));
    const noConfig=resolveSettings({},env({AGENT_OPS_CONFIG:join(root,'none','config.json'),AGENT_OPS_REPOS_DIR:join(root,'work'),AGENT_OPS_STATE_FILE:join(root,'other.json')}));
    assert.equal(noConfig.projects[0].path,join(root,'work'));assert.equal(noConfig.stateFile,join(root,'other.json'));
    const empty=resolveSettings({},env({AGENT_OPS_CONFIG:join(root,'none','config.json')}));
    assert.deepEqual(empty.projects,[]);
    assert.equal(defaultDataDir({LOCALAPPDATA:'C:\Users\me\AppData\Local'}),join('C:\Users\me\AppData\Local','AgentOps'));
    put(join(root,'bad.json'),'{oops');
    assert.throws(()=>readConfig(join(root,'bad.json')),/unreadable/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('A project folder that cannot be opened is a warning, not a failed refresh',()=>{
  const {root,config}=fixture();
  try{
    const parsed=JSON.parse(readFileSync(config,'utf8'));
    put(join(root,'now-a-file'),'not a folder');
    parsed.projects.push({id:'file',path:join(root,'now-a-file'),name:'file',kind:'folder',enabled:true,addedAt:'2026-01-01T00:00:00Z'});
    put(config,JSON.stringify(parsed));
    const run=spawnSync(process.execPath,[join(here,'tasks-overview.mjs')],{env:env({AGENT_OPS_CONFIG:config}),encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,run.stderr);
    const state=JSON.parse(readFileSync(join(root,'data','state','tong-hop-chung.json'),'utf8'));
    const project=state.projects.find(p=>p.id==='file');
    assert.equal(project.status,'missing');assert.match(project.message,/cannot be opened \(ENOTDIR\)/);
    assert.equal(state.plans.length,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Collector without any project writes an empty state instead of failing',()=>{
  const root=mkdtempSync(join(tmpdir(),'agent-ops-empty-'));
  try{
    const run=spawnSync(process.execPath,[join(here,'tasks-overview.mjs')],{env:env({AGENT_OPS_CONFIG:join(root,'config.json')}),encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,run.stderr);
    const state=JSON.parse(readFileSync(join(root,'state','tong-hop-chung.json'),'utf8'));
    assert.deepEqual(state.plans,[]);assert.deepEqual(state.projects,[]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

// The owner's old machine paths may only appear in the Go migration constant and tests.
test('Shipped files contain no machine-specific D:/1_PROJECTS paths',()=>{
  const legacy=/[A-Za-z]:[\\/]+1_PROJECTS/i,found=[];
  const shipped=['README.md','INSTALL.md','CHANGELOG.md','skills/task-plan/SKILL.md','scripts/install.ps1','integrations/install-task-reporting.mjs','web/index.html'];
  for(const name of readdirSync(here))if(/\.(mjs|go)$/.test(name) && !/_test\.(mjs|go)$/.test(name))shipped.push(name);
  // Every shipped or build source below these folders, not only a fixed list.
  for(const folder of ['scripts','integrations','cmd','internal','skills','docs']){
    for(const entry of readdirSync(join(here,folder),{recursive:true,withFileTypes:true})){
      const name=relative(here,join(entry.parentPath,entry.name)).replaceAll('\\','/');
      if(entry.isFile() && /\.(mjs|go|ps1|md|json)$/.test(name) && !/_test\.(mjs|go)$/.test(name) && !shipped.includes(name))shipped.push(name);
    }
  }
  assert.ok(shipped.includes('scripts/smoke.mjs') && shipped.some(n=>n.startsWith('cmd/')));
  for(const name of shipped){
    const lines=readFileSync(join(here,name),'utf8').split(/\r?\n/);
    lines.forEach((line,i)=>{
      if(!legacy.test(line))return;
      const constant=name==='config.go' && /^\s*legacy(ReposDir|SlotsFile|StateFile)\s*=/.test(line);
      if(!constant)found.push(name+':'+(i+1));
    });
  }
  assert.deepEqual(found,[]);
  assert.ok(statSync(join(here,'config.go')).isFile());
});
