// Run only against an extracted release in an isolated profile and task root.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=mkdtempSync(join(root,'.test-release-'));
let app,firstRun;
const put=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
const run=(file,args)=>{const p=spawnSync(file,args,{encoding:'utf8',windowsHide:true});assert.equal(p.status,0,p.stderr||p.stdout||p.error?.message);};
try {
  const archive=join(root,'dist','agent-ops-windows-amd64.zip'),pkg=join(fixture,'package');
  const psArgs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
  run('powershell.exe',[...psArgs,'-Command',"Expand-Archive -LiteralPath '"+archive.replaceAll("'","''")+"' -DestinationPath '"+pkg.replaceAll("'","''")+"'"]);
  const listed=[];
  function list(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())list(file);else listed.push(file.slice(pkg.length+1).replaceAll('\\','/'));}}
  list(pkg);
  // Exactly the v0.3.0 file set: the app, the collector, two stubs, the migration shim and the installer.
  assert.deepEqual(listed.sort(),['agent-ops.exe','tasks-overview.mjs','task-sync.mjs','task-report.mjs','plan-reader.mjs','NOTICE.md','INSTALL.md','scripts/install.ps1','integrations/install-task-reporting.mjs'].sort());
  // The manifest asset describes the package exactly: every file, its size and digest.
  const manifest=JSON.parse(readFileSync(join(root,'dist','agent-ops-windows-amd64.manifest.json'),'utf8'));
  assert.equal(manifest.format,1);assert.match(manifest.version,/^v\d+\.\d+\.\d+(-dev\.[0-9a-f]+)?$/);
  assert.deepEqual(manifest.remove.sort(),['agent-attribution.mjs','execution-reports.mjs','execution-roles.mjs','historical-executions.mjs','skills/task-plan/SKILL.md']);
  assert.deepEqual(manifest.files.map(f=>f.path).sort(),listed.slice().sort());
  for(const f of manifest.files){const body=readFileSync(join(pkg,f.path));assert.equal(f.size,body.length,f.path);assert.equal(f.sha256,createHash('sha256').update(body).digest('hex'),f.path);}
  const reported=spawnSync('node',['-e',"process.stdout.write(require('node:child_process').execFileSync(process.argv[1],['--version'],{encoding:'utf8',windowsHide:true}))",join(pkg,'agent-ops.exe')],{encoding:'utf8',windowsHide:true}).stdout.trim();
  assert.equal(reported,manifest.version,'the manifest names the packaged version');
  const runtime=join(fixture,'installed runtime'),profile=join(fixture,'profile');
  // An earlier install: a retired module, a run history registry and owner instructions.
  put(join(runtime,'execution-reports.mjs'),'retired module');put(join(runtime,'agent-attributions.json'),'{"old":"history"}');
  put(join(profile,'.codex','AGENTS.md'),'# Existing instructions\nPreserve this.\n');
  const installer=[...psArgs,'-File',join(pkg,'scripts/install.ps1'),'-RuntimeDir',runtime,'-ProfileDir',profile,'-NoLaunch'];
  run('powershell.exe',installer);run('powershell.exe',installer);
  assert.ok(!existsSync(join(runtime,'execution-reports.mjs')),'retired module removed');
  assert.ok(!existsSync(join(runtime,'agent-attributions.json')),'old run history deleted');
  assert.ok(readFileSync(join(runtime,'task-sync.mjs'),'utf8').includes('no longer records runs'),'task-sync is the stub');
  assert.equal(readFileSync(join(profile,'.codex','AGENTS.md'),'utf8'),'# Existing instructions\nPreserve this.\n','owner instructions untouched');
  assert.ok(!existsSync(join(profile,'.agents','skills','task-plan','SKILL.md')),'the installer installs no skill by itself');
  const migrated=JSON.parse(readFileSync(join(profile,'AppData','Local','AgentOps','migration.json'),'utf8'));
  assert.ok(migrated.backup.startsWith(join(profile,'AppData','Local','AgentOps','backups')),'migration stays inside the isolated profile');
  const repos=join(fixture,'repos'),plan=join(repos,'sample','.tasks','delivery.md'),state=join(fixture,'output','state.json');
  const source='Agent: Codex\nExecutor: Codex\nStatus: Implementing\nGoal: Verify isolated delivery\nNext: Finish test\n\n## M1: Delivery\n- [doing] Validate release\n';
  put(plan,source);mkdirSync(dirname(state),{recursive:true});
  const server=createServer();await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
  const port=server.address().port;await new Promise(res=>server.close(res));
  const base='http://127.0.0.1:'+port;
  app=spawn(join(runtime,'agent-ops.exe'),['--background','--no-update-check','--profile-dir',profile,'--addr','127.0.0.1:'+port,'--repos-dir',repos,'--state-file',state,'--script',join(runtime,'tasks-overview.mjs'),'--data-dir',join(fixture,'data')],{windowsHide:true,stdio:'ignore',env:{...process.env,AGENT_OPS_REPOS_DIR:'',AGENT_OPS_STATE_FILE:'',AGENT_OPS_CONFIG:''}});
  let response;
  for(let i=0;i<100;i++){
    try{response=await fetch(base+'/api/state',{signal:AbortSignal.timeout(1000)});if(response.ok)break;}catch{/* Retry only while the isolated process is starting. */}
    if(app.exitCode!==null)throw Error('Isolated app exited before serving');
    await new Promise(res=>setTimeout(res,100));
  }
  assert.ok(response?.ok,'Isolated app did not start');
  const stateResponse=await response.json();assert.equal(stateResponse.error,'');assert.equal(stateResponse.state.plans.length,1);
  for(const key of ['agent','executors','executionReports','slot'])assert.equal(key in stateResponse.state.plans[0],false,key);
  const page=await fetch(base),html=await page.text();assert.equal(page.status,200);assert.ok(html.includes('<title>Agent Ops</title>'));
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replaceAll('\r\n','\n').replaceAll('\r','\n');
  const digest=createHash('sha256').update(script).digest('base64');
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'sha256-"+digest+"'"));
  assert.ok(!page.headers.get('content-security-policy').includes('https:'),'nothing may load from another origin');
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  const rebindingStatus=await new Promise((res,rej)=>{const req=request(base+'/api/state',{headers:{Host:'rebinding.invalid'}},r=>{r.resume();res(r.statusCode);});req.on('error',rej);req.end();});
  assert.equal(rebindingStatus,403);
  assert.equal((await fetch(base+'/api/state',{headers:{Origin:'https://other.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/refresh',{method:'POST'})).status,403);
  for(const path of ['/api/plans/status','/api/plans/agent']){
    const gone=await fetch(base+path,{method:'POST',headers:{'X-Agent-Ops':'1',Origin:base,'Content-Type':'application/json'},body:'{}'});
    assert.equal(gone.status,404,path+' is retired');
  }
  const integrations=await (await fetch(base+'/api/integrations')).json();
  assert.deepEqual(integrations.clients.map(c=>c.id),['claude','codex','gemini']);assert.equal(integrations.skillVersion,2);
  assert.ok(integrations.clients.every(c=>c.skill.path.startsWith(profile)),'integrations use the isolated profile');
  const refresh=await fetch(base+'/api/refresh',{method:'POST',headers:{'X-Agent-Ops':'1',Origin:base}});
  assert.equal(refresh.status,200);assert.ok((await refresh.json()).refreshedAt);
  const controller=new AbortController(),stream=await fetch(base+'/events',{signal:controller.signal});
  assert.equal(stream.headers.get('content-type'),'text/event-stream');
  const chunk=await stream.body.getReader().read();assert.ok(new TextDecoder().decode(chunk.value).includes('retry: 3000'));controller.abort();
  assert.equal(readFileSync(plan,'utf8'),source);
  // First run without any path flags: setup mode, no collector error, then a project added through the API.
  const freshServer=createServer();await new Promise((res,rej)=>{freshServer.once('error',rej);freshServer.listen(0,'127.0.0.1',res);});
  const freshPort=freshServer.address().port;await new Promise(res=>freshServer.close(res));
  const fresh='http://127.0.0.1:'+freshPort,freshData=join(fixture,'fresh-data');
  const cleanEnv={...process.env,AGENT_OPS_REPOS_DIR:'',AGENT_OPS_STATE_FILE:'',AGENT_OPS_CONFIG:''};
  firstRun=spawn(join(runtime,'agent-ops.exe'),['--background','--no-update-check','--profile-dir',profile,'--addr','127.0.0.1:'+freshPort,'--script',join(runtime,'tasks-overview.mjs'),'--data-dir',freshData],{windowsHide:true,stdio:'ignore',env:cleanEnv});
  let freshState;
  for(let i=0;i<100;i++){
    try{const r=await fetch(fresh+'/api/state',{signal:AbortSignal.timeout(1000)});if(r.ok){freshState=await r.json();break;}}catch{/* Retry only while the isolated process is starting. */}
    if(firstRun.exitCode!==null)throw Error('First-run app exited before serving');
    await new Promise(res=>setTimeout(res,100));
  }
  assert.ok(freshState,'First-run app did not start');
  assert.equal(freshState.setupRequired,true);assert.equal(freshState.error,'');assert.deepEqual(freshState.state.plans,[]);assert.deepEqual(freshState.projects,[]);
  const write=(path,method,body)=>fetch(fresh+path,{method,headers:{'X-Agent-Ops':'1',Origin:fresh,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(fresh+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:repos})})).status,403);
  // Setup can be skipped before any project exists; the board then shows the empty state.
  assert.equal((await write('/api/settings','PUT',{setupComplete:true,theme:'dark'})).status,200);
  const skipped=await (await fetch(fresh+'/api/state')).json();
  assert.equal(skipped.setupRequired,false);assert.equal(skipped.error,'');assert.deepEqual(skipped.projects,[]);
  const added=await write('/api/projects','POST',{path:repos});assert.equal(added.status,200);
  const addedBody=await added.json();assert.equal(addedBody.kind,'folder');assert.equal(addedBody.repos.length,1);assert.equal(addedBody.repos[0].planCount,1);
  assert.equal((await write('/api/settings','PUT',{startWithWindows:true})).status,409);
  assert.equal((await write('/api/settings','PUT',{setupComplete:true})).status,200);
  const configured=await (await fetch(fresh+'/api/state')).json();
  assert.equal(configured.setupRequired,false);assert.equal(configured.error,'');assert.equal(configured.state.plans.length,1);assert.equal(configured.state.plans[0].project,addedBody.project.id);
  const savedConfig=JSON.parse(readFileSync(join(freshData,'config.json'),'utf8'));
  assert.equal(savedConfig.setupComplete,true);assert.equal(savedConfig.projects[0].path,repos);assert.equal(savedConfig.theme,'dark');assert.equal(savedConfig.shortcuts,true);
  assert.ok(readFileSync(join(freshData,'state','tong-hop-chung.json'),'utf8').includes('"plans"'));
  assert.equal(readFileSync(plan,'utf8'),source);
  console.log('First-run smoke passed: setup mode without flags, setup skipped with no project, protected settings writes, project added, config.json and default state under the data folder.');
  console.log('Release smoke passed: exact package allowlist and removals, repeat install with the migration inside the isolated profile, untouched owner instructions, retired write routes, integrations API, real HTTP/SSE/F5, script CSP, request protection and unchanged task source.');
} finally {
  for(const child of [app,firstRun])if(child && child.exitCode===null){const exited=new Promise(res=>child.once('exit',res));child.kill();await exited;}
  if(dirname(fixture)!==root || !fixture.startsWith(join(root,'.test-release-')))throw Error('Unsafe cleanup path');
  rmSync(fixture,{recursive:true,force:true});
}
