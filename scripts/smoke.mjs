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
const children=[];let passed=false;
const sleep=ms=>new Promise(res=>setTimeout(res,ms));
// Every request but icons and fonts needs the app session: the secret the app writes
// to session.json in its data folder (a window gets it as a cookie instead).
const session=dir=>{try{return JSON.parse(readFileSync(join(dir,'session.json'),'utf8'));}catch{return null;}};
const appFetch=dir=>(url,options={})=>fetch(url,{...options,headers:{'X-Agent-Ops-Session':session(dir)?.secret||'',...(options.headers||{})}});
const freePort=async()=>{const s=createServer();await new Promise((res,rej)=>{s.once('error',rej);s.listen(0,'127.0.0.1',res);});const port=s.address().port;await new Promise(res=>s.close(res));return port;};
// Starts the app on a free port and waits for /api/state. Another process (a
// parallel test, the owner's app) can take the port between the check and the
// app's listen; an app that exits before serving is started again on a new port.
async function startApp(label,exe,args,env,dataDir){
  const get=appFetch(dataDir);
  for(let attempt=1;;attempt++){
    const port=await freePort(),base='http://127.0.0.1:'+port;
    const child=spawn(exe,[...args,'--addr','127.0.0.1:'+port],{windowsHide:true,stdio:'ignore',env});children.push(child);
    for(let i=0;i<100;i++){
      try{const response=await get(base+'/api/state',{signal:AbortSignal.timeout(1000)});if(response.ok)return {child,base,response,get};}catch{/* Retry only while the isolated process is starting. */}
      if(child.exitCode!==null)break;
      await sleep(100);
    }
    if(child.exitCode===null)throw Error(label+' did not start');
    if(attempt>=3)throw Error(label+' exited before serving (exit code '+child.exitCode+', '+attempt+' attempts)');
    console.log(label+' exited before serving (exit code '+child.exitCode+'); starting it again on a new port.');
  }
}
const put=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
const run=(file,args)=>{const p=spawnSync(file,args,{encoding:'utf8',windowsHide:true});assert.equal(p.status,0,p.stderr||p.stdout||p.error?.message);};
try {
  const archive=join(root,'dist','agent-ops-windows-amd64.zip'),pkg=join(fixture,'package');
  const psArgs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
  run('powershell.exe',[...psArgs,'-Command',"Expand-Archive -LiteralPath '"+archive.replaceAll("'","''")+"' -DestinationPath '"+pkg.replaceAll("'","''")+"'"]);
  const listed=[];
  function list(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())list(file);else listed.push(file.slice(pkg.length+1).replaceAll('\\','/'));}}
  list(pkg);
  // Exactly the file set: the app (with the plan collector), two Node stubs for old commands and the installer. No Node collector.
  assert.deepEqual(listed.sort(),['agent-ops.exe','task-sync.mjs','task-report.mjs','NOTICE.md','INSTALL.md','scripts/install.ps1'].sort());
  // The manifest asset describes the package exactly: every file, its size and digest.
  const manifest=JSON.parse(readFileSync(join(root,'dist','agent-ops-windows-amd64.manifest.json'),'utf8'));
  assert.equal(manifest.format,1);assert.match(manifest.version,/^v\d+\.\d+\.\d+(-dev\.[0-9a-f]+)?$/);
  assert.deepEqual(manifest.remove.sort(),['agent-attribution.mjs','execution-reports.mjs','execution-roles.mjs','historical-executions.mjs','integrations/install-task-reporting.mjs','plan-reader.mjs','skills/task-plan/SKILL.md','tasks-overview.mjs']);
  assert.deepEqual(manifest.files.map(f=>f.path).sort(),listed.slice().sort());
  for(const f of manifest.files){const body=readFileSync(join(pkg,f.path));assert.equal(f.size,body.length,f.path);assert.equal(f.sha256,createHash('sha256').update(body).digest('hex'),f.path);}
  const reported=spawnSync('node',['-e',"process.stdout.write(require('node:child_process').execFileSync(process.argv[1],['--version'],{encoding:'utf8',windowsHide:true}))",join(pkg,'agent-ops.exe')],{encoding:'utf8',windowsHide:true}).stdout.trim();
  assert.equal(reported,manifest.version,'the manifest names the packaged version');
  const runtime=join(fixture,'installed runtime'),profile=join(fixture,'profile');
  // An earlier install: retired modules (also the Node collector), a run history registry and owner instructions.
  put(join(runtime,'execution-reports.mjs'),'retired module');put(join(runtime,'tasks-overview.mjs'),'retired collector');put(join(runtime,'integrations','install-task-reporting.mjs'),'retired shim');put(join(runtime,'agent-attributions.json'),'{"old":"history"}');
  put(join(profile,'.codex','AGENTS.md'),'# Existing instructions\nPreserve this.\n');
  const installer=[...psArgs,'-File',join(pkg,'scripts/install.ps1'),'-RuntimeDir',runtime,'-ProfileDir',profile,'-NoLaunch'];
  run('powershell.exe',installer);run('powershell.exe',installer);
  for(const name of ['execution-reports.mjs','tasks-overview.mjs','integrations/install-task-reporting.mjs'])assert.ok(!existsSync(join(runtime,name)),'retired module removed: '+name);
  assert.ok(!existsSync(join(runtime,'integrations')),'empty retired folder removed');
  assert.ok(!existsSync(join(runtime,'agent-attributions.json')),'old run history deleted');
  assert.ok(readFileSync(join(runtime,'task-sync.mjs'),'utf8').includes('no longer records runs'),'task-sync is the stub');
  assert.equal(readFileSync(join(profile,'.codex','AGENTS.md'),'utf8'),'# Existing instructions\nPreserve this.\n','owner instructions untouched');
  assert.ok(!existsSync(join(profile,'.agents','skills','task-plan','SKILL.md')),'the installer installs no skill by itself');
  // An isolated -RuntimeDir without -ProfileDir skips the migration. The default profile
  // here is a temp folder too (USERPROFILE, LOCALAPPDATA and APPDATA redirected), so even a
  // regression could not reach the real home.
  const home=join(fixture,'default-home'),hooked='{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node C:/x/task-sync.mjs --claude-hook"}]}]}}';
  put(join(home,'.claude','settings.json'),hooked);put(join(home,'AppData','Local','krik-workboard','activity.jsonl'),'{"kind":"execution-report"}\n');
  const guarded=spawnSync('powershell.exe',[...psArgs,'-File',join(pkg,'scripts/install.ps1'),'-RuntimeDir',join(fixture,'second runtime'),'-NoLaunch'],{encoding:'utf8',windowsHide:true,env:{...process.env,USERPROFILE:home,LOCALAPPDATA:join(home,'AppData','Local'),APPDATA:join(home,'AppData','Roaming'),CLAUDE_CONFIG_DIR:''}});
  assert.equal(guarded.status,0,guarded.stderr||guarded.stdout);assert.match(guarded.stdout,/Migration skipped/);
  assert.equal(readFileSync(join(home,'.claude','settings.json'),'utf8'),hooked,'default profile hooks untouched');
  assert.ok(existsSync(join(home,'AppData','Local','krik-workboard','activity.jsonl'))&&!existsSync(join(home,'AppData','Local','AgentOps','migration.json')),'default data folders untouched');
  const migrated=JSON.parse(readFileSync(join(profile,'AppData','Local','AgentOps','migration.json'),'utf8'));
  assert.ok(migrated.backup.startsWith(join(profile,'AppData','Local','AgentOps','backups')),'migration stays inside the isolated profile');
  const repos=join(fixture,'repos'),plan=join(repos,'sample','.tasks','delivery.md'),state=join(fixture,'output','state.json');
  const source='Agent: Codex\nExecutor: Codex\nStatus: Implementing\nGoal: Verify isolated delivery\nNext: Finish test\n\n## M1: Delivery\n- [doing] Validate release\n';
  put(plan,source);mkdirSync(dirname(state),{recursive:true});
  const dataDir=join(fixture,'data');
  const {child:app,base,response,get:appGet}=await startApp('Isolated app',join(runtime,'agent-ops.exe'),['--background','--no-update-check','--profile-dir',profile,'--repos-dir',repos,'--state-file',state,'--data-dir',dataDir],{...process.env,AGENT_OPS_REPOS_DIR:'',AGENT_OPS_STATE_FILE:'',AGENT_OPS_CONFIG:''},dataDir);
  const stateResponse=await response.json();assert.equal(stateResponse.error,'');assert.equal(stateResponse.state.plans.length,1);
  for(const key of ['agent','executors','executionReports','slot'])assert.equal(key in stateResponse.state.plans[0],false,key);
  // The in-process collector: no Node, per-milestone progress, repositories and diagnostics, nothing written into the repository.
  assert.deepEqual(stateResponse.state.plans[0].milestones[0].progress,{done:0,total:1});
  assert.deepEqual(stateResponse.state.diagnostics,[]);assert.equal(stateResponse.state.repos[0].name,'sample');assert.deepEqual(stateResponse.state.repos[0].worktrees,[]);
  assert.ok(!existsSync(join(repos,'sample','.tasks','tong-hop.md')),'no generated index in the repository');
  const page=await appGet(base),html=await page.text();assert.equal(page.status,200);assert.ok(html.includes('<title>Agent Ops</title>'));
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replaceAll('\r\n','\n').replaceAll('\r','\n');
  const digest=createHash('sha256').update(script).digest('base64');
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'sha256-"+digest+"'"));
  assert.ok(!page.headers.get('content-security-policy').includes('https:'),'nothing may load from another origin');
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  const rebindingStatus=await new Promise((res,rej)=>{const req=request(base+'/api/state',{headers:{Host:'rebinding.invalid'}},r=>{r.resume();res(r.statusCode);});req.on('error',rej);req.end();});
  assert.equal(rebindingStatus,403);
  assert.equal((await appGet(base+'/api/state',{headers:{Origin:'https://other.invalid'}})).status,403);
  // J5: without this session's secret nothing but icons and fonts is served, and a
  // forged launch token signs nothing in.
  const anonymous=await fetch(base+'/api/state');assert.equal(anonymous.status,403);assert.match((await anonymous.json()).error,/not signed in/);
  assert.equal((await fetch(base+'/')).status,403);
  assert.equal((await fetch(base+'/api/state',{headers:{'X-Agent-Ops-Session':'0'.repeat(64)}})).status,403);
  const forged=await fetch(base+'/open?token='+'1'.repeat(64),{redirect:'manual'});assert.equal(forged.status,403);assert.equal(forged.headers.get('set-cookie'),null);
  assert.equal((await fetch(base+'/icons/app.png')).status,200);
  const appSession=session(dataDir);assert.equal('http://'+appSession.addr,base);assert.equal(appSession.pid,app.pid);assert.match(appSession.secret,/^[0-9a-f]{64}$/);
  assert.equal((await appGet(base+'/api/refresh',{method:'POST'})).status,403);
  for(const path of ['/api/plans/status','/api/plans/agent']){
    const gone=await appGet(base+path,{method:'POST',headers:{'X-Agent-Ops':'1',Origin:base,'Content-Type':'application/json'},body:'{}'});
    assert.equal(gone.status,404,path+' is retired');
  }
  const integrations=await (await appGet(base+'/api/integrations')).json();
  assert.deepEqual(integrations.targets,[],'no folder is added without the owner');assert.equal(integrations.skillVersion,2);
  assert.ok(integrations.suggestions.length>0 && integrations.suggestions.every(s=>s.skillDir.startsWith(profile)),'suggestions come from the isolated profile only');
  const refresh=await appGet(base+'/api/refresh',{method:'POST',headers:{'X-Agent-Ops':'1',Origin:base}});
  assert.equal(refresh.status,200);assert.ok((await refresh.json()).refreshedAt);
  const controller=new AbortController(),stream=await appGet(base+'/events',{signal:controller.signal});
  assert.equal(stream.headers.get('content-type'),'text/event-stream');
  const chunk=await stream.body.getReader().read();assert.ok(new TextDecoder().decode(chunk.value).includes('retry: 3000'));controller.abort();
  assert.equal(readFileSync(plan,'utf8'),source);
  // First run without any path flags: setup mode, no collector error, then a project added through the API.
  const freshData=join(fixture,'fresh-data');
  const cleanEnv={...process.env,AGENT_OPS_REPOS_DIR:'',AGENT_OPS_STATE_FILE:'',AGENT_OPS_CONFIG:''};
  const started=await startApp('First-run app',join(runtime,'agent-ops.exe'),['--background','--no-update-check','--profile-dir',profile,'--data-dir',freshData],cleanEnv,freshData);
  const fresh=started.base,freshGet=started.get,freshState=await started.response.json();
  assert.equal(freshState.setupRequired,true);assert.equal(freshState.error,'');assert.deepEqual(freshState.state.plans,[]);assert.deepEqual(freshState.projects,[]);
  const write=(path,method,body)=>freshGet(fresh+path,{method,headers:{'X-Agent-Ops':'1',Origin:fresh,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await freshGet(fresh+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:repos})})).status,403);
  // Setup can be skipped before any project exists; the board then shows the empty state.
  assert.equal((await write('/api/settings','PUT',{setupComplete:true,theme:'dark'})).status,200);
  const skipped=await (await freshGet(fresh+'/api/state')).json();
  assert.equal(skipped.setupRequired,false);assert.equal(skipped.error,'');assert.deepEqual(skipped.projects,[]);
  const added=await write('/api/projects','POST',{path:repos});assert.equal(added.status,200);
  const addedBody=await added.json();assert.equal(addedBody.kind,'folder');assert.equal(addedBody.repos.length,1);assert.equal(addedBody.repos[0].planCount,1);
  assert.equal((await write('/api/settings','PUT',{startWithWindows:true})).status,409);
  assert.equal((await write('/api/settings','PUT',{setupComplete:true})).status,200);
  const configured=await (await freshGet(fresh+'/api/state')).json();
  assert.equal(configured.setupRequired,false);assert.equal(configured.error,'');assert.equal(configured.state.plans.length,1);assert.equal(configured.state.plans[0].project,addedBody.project.id);
  const savedConfig=JSON.parse(readFileSync(join(freshData,'config.json'),'utf8'));
  assert.equal(savedConfig.setupComplete,true);assert.equal(savedConfig.projects[0].path,repos);assert.equal(savedConfig.theme,'dark');assert.equal(savedConfig.shortcuts,true);
  assert.ok(readFileSync(join(freshData,'state','tong-hop-chung.json'),'utf8').includes('"plans"'));
  assert.equal(readFileSync(plan,'utf8'),source);
  console.log('First-run smoke passed: setup mode without flags, setup skipped with no project, protected settings writes, project added, config.json and default state under the data folder.');
  console.log('Release smoke passed: exact package allowlist and removals, session secret required on every request, repeat install with the migration inside the isolated profile, untouched owner instructions, retired write routes, integrations API, real HTTP/SSE/F5, script CSP, request protection and unchanged task source.');
  passed=true;
} finally {
  // End each app with its whole process tree (a git the collector started could
  // otherwise keep handles inside the fixture and make the cleanup fail).
  for(const child of children)if(child.exitCode===null){
    const exited=new Promise(res=>child.once('exit',res));
    spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
    if(child.exitCode===null)child.kill();
    await Promise.race([exited,sleep(10000)]);
  }
  if(dirname(fixture)!==root || !fixture.startsWith(join(root,'.test-release-')))throw Error('Unsafe cleanup path');
  if(passed)rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  else console.error('Smoke failed; the fixture is kept for diagnosis: '+fixture+' (app logs: data\\logs and fresh-data\\logs).');
}
