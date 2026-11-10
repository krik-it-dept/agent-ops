// Run only against an extracted release in an isolated profile and task root.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=mkdtempSync(join(root,'.test-release-'));
let app;
const put=(file,text)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
const run=(file,args)=>{const p=spawnSync(file,args,{encoding:'utf8',windowsHide:true});assert.equal(p.status,0,p.stderr||p.stdout||p.error?.message);};
try {
  const archive=join(root,'dist','agent-ops-windows-amd64.zip'),pkg=join(fixture,'package');
  const psArgs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
  run('powershell.exe',[...psArgs,'-Command',"Expand-Archive -LiteralPath '"+archive.replaceAll("'","''")+"' -DestinationPath '"+pkg.replaceAll("'","''")+"'"]);
  const listed=[];
  function list(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())list(file);else listed.push(file.slice(pkg.length+1).replaceAll('\\','/'));}}
  list(pkg);
  assert.deepEqual(listed.sort(),['agent-ops.exe','tasks-overview.mjs','task-sync.mjs','task-report.mjs','plan-reader.mjs','execution-roles.mjs','execution-reports.mjs','historical-executions.mjs','agent-attribution.mjs','NOTICE.md','INSTALL.md','scripts/install.ps1','integrations/install-task-reporting.mjs','skills/task-plan/SKILL.md'].sort());
  const runtime=join(fixture,'installed runtime'),profile=join(fixture,'profile');
  put(join(runtime,'historical-executions.json'),'private fixture sentinel');
  put(join(profile,'.codex','AGENTS.md'),'# Existing instructions\nPreserve this.\n');
  const installer=[...psArgs,'-File',join(pkg,'scripts/install.ps1'),'-RuntimeDir',runtime,'-ProfileDir',profile];
  run('powershell.exe',installer);run('powershell.exe',installer);
  assert.equal(readFileSync(join(runtime,'historical-executions.json'),'utf8'),'private fixture sentinel');
  const instructions=readFileSync(join(profile,'.codex','AGENTS.md'),'utf8');
  assert.ok(instructions.startsWith('# Existing instructions\nPreserve this.\n'));
  assert.equal(instructions.split('<!-- workboard-task-reporting:start -->').length,2);
  const skill=readFileSync(join(profile,'.agents','skills','task-plan','SKILL.md'),'utf8');
  assert.ok(skill.includes(runtime.replaceAll('\\','/')));assert.ok(!skill.includes('{{WORKBOARD_DIR}}'));
  const repos=join(fixture,'repos'),plan=join(repos,'sample','.tasks','delivery.md'),state=join(fixture,'output','state.json'),slots=join(fixture,'slots.json');
  const source='Agent: Codex\nExecutor: Codex\nStatus: Implementing\nGoal: Verify isolated delivery\nNext: Finish test\n\n## M1: Delivery\n- [doing] Validate release\n';
  put(plan,source);put(slots,'{}');mkdirSync(dirname(state),{recursive:true});
  const server=createServer();await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
  const port=server.address().port;await new Promise(res=>server.close(res));
  const base='http://127.0.0.1:'+port;
  app=spawn(join(runtime,'agent-ops.exe'),['--background','--no-update-check','--profile-dir',profile,'--addr','127.0.0.1:'+port,'--repos-dir',repos,'--slots-file',slots,'--state-file',state,'--script',join(runtime,'tasks-overview.mjs'),'--data-dir',join(fixture,'data')],{windowsHide:true,stdio:'ignore',env:{...process.env,KRIK_AGENT_MAP:join(fixture,'no-agent-map.json'),KRIK_HISTORY_MAP:join(fixture,'no-history-map.json'),KRIK_EXECUTION_DIR:join(fixture,'executions')}});
  let response;
  for(let i=0;i<100;i++){
    try{response=await fetch(base+'/api/state',{signal:AbortSignal.timeout(1000)});if(response.ok)break;}catch{/* Retry only while the isolated process is starting. */}
    if(app.exitCode!==null)throw Error('Isolated app exited before serving');
    await new Promise(res=>setTimeout(res,100));
  }
  assert.ok(response?.ok,'Isolated app did not start');
  const stateResponse=await response.json();assert.equal(stateResponse.error,'');assert.equal(stateResponse.state.plans.length,1);assert.equal(stateResponse.state.plans[0].agent,'Codex');
  const page=await fetch(base),html=await page.text();assert.equal(page.status,200);assert.ok(html.includes('<title>Agent Ops</title>'));
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1].replaceAll('\r\n','\n').replaceAll('\r','\n');
  const digest=createHash('sha256').update(script).digest('base64');
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'sha256-"+digest+"'"));
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  const rebindingStatus=await new Promise((res,rej)=>{const req=request(base+'/api/state',{headers:{Host:'rebinding.invalid'}},r=>{r.resume();res(r.statusCode);});req.on('error',rej);req.end();});
  assert.equal(rebindingStatus,403);
  assert.equal((await fetch(base+'/api/state',{headers:{Origin:'https://other.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/refresh',{method:'POST'})).status,403);
  const refresh=await fetch(base+'/api/refresh',{method:'POST',headers:{'X-Workboard':'1',Origin:base}});
  assert.equal(refresh.status,200);assert.ok((await refresh.json()).refreshedAt);
  const controller=new AbortController(),stream=await fetch(base+'/events',{signal:controller.signal});
  assert.equal(stream.headers.get('content-type'),'text/event-stream');
  const chunk=await stream.body.getReader().read();assert.ok(new TextDecoder().decode(chunk.value).includes('retry: 3000'));controller.abort();
  assert.equal(readFileSync(plan,'utf8'),source);
  console.log('Release smoke passed: exact package allowlist, repeat install, preserved data/instructions, portable paths, real HTTP/SSE/F5, script CSP, request protection and unchanged task source.');
} finally {
  if(app && app.exitCode===null){const exited=new Promise(res=>app.once('exit',res));app.kill();await exited;}
  if(dirname(fixture)!==root || !fixture.startsWith(join(root,'.test-release-')))throw Error('Unsafe cleanup path');
  rmSync(fixture,{recursive:true,force:true});
}
