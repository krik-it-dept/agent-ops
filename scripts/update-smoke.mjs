// Optional real-GitHub round trip after publishing VERSION. Never targets the live installation.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),target=readFileSync(join(root,'VERSION'),'utf8').trim();
const fixture=mkdtempSync(join(root,'.test-update-'));let app,newPID;
const ps=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
function run(file,args){const p=spawnSync(file,args,{encoding:'utf8',windowsHide:true});assert.equal(p.status,0,p.stderr||p.stdout||p.error?.message);}
function put(file,text){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
async function until(read,accept,timeout=120000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await read();if(accept(last))return last;}catch(e){if(e.fatal)throw e;}await new Promise(r=>setTimeout(r,200));}throw Error('Update test timed out: '+JSON.stringify(last));}
try{
  const build=join(fixture,'bootstrap-build');
  // v0.0.0 is explicitly a test build of the current updater, not a historical release.
  run('powershell.exe',[...ps,'-File',join(root,'scripts/build.ps1'),'-Version','v0.0.0','-OutputDir',build]);
  const pkg=join(build,readdirSync(build).find(n=>n.startsWith('package-'))),runtime=join(fixture,'runtime'),profile=join(fixture,'profile');
  put(join(profile,'.codex','AGENTS.md'),'# Owner instructions\nKeep the existing user rule.\n');
  run('powershell.exe',[...ps,'-File',join(pkg,'scripts/install.ps1'),'-RuntimeDir',runtime,'-ProfileDir',profile,'-NoLaunch']);
  const privateFile=join(runtime,'historical-executions.json'),dataDir=join(fixture,'data'),preference=join(dataDir,'owner-preference.json');put(privateFile,'{"private":"keep"}');put(preference,'{"preference":"keep"}');
  const repos=join(fixture,'repos'),plan=join(repos,'sample','.tasks','check.md'),source='Agent: Codex\nStatus: Testing\nGoal: Isolated update verification\nNext: Verify update\n\n## M1: Work\n- [doing] Verify the app\n';put(plan,source);
  const slots=join(fixture,'slots.json'),state=join(fixture,'output','state.json');put(slots,'{}');mkdirSync(dirname(state),{recursive:true});
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const base='http://127.0.0.1:'+port;
  app=spawn(join(runtime,'agent-ops.exe'),['--background','--no-update-check','--profile-dir',profile,'--addr','127.0.0.1:'+port,'--repos-dir',repos,'--slots-file',slots,'--state-file',state,'--script',join(runtime,'tasks-overview.mjs'),'--data-dir',dataDir],{windowsHide:true,stdio:'ignore',env:{...process.env,KRIK_AGENT_MAP:join(fixture,'missing-agent.json'),KRIK_HISTORY_MAP:join(fixture,'missing-history.json'),KRIK_EXECUTION_DIR:join(fixture,'executions')}});
  const get=async()=>{const r=await fetch(base+'/api/updates',{signal:AbortSignal.timeout(1000)});assert.equal(r.status,200);const s=await r.json();if(Number.isInteger(s.processId) && s.processId!==app.pid)newPID=s.processId;return s;};
  const initial=await until(get,s=>s.current==='v0.0.0');assert.equal(initial.processId,app.pid);
  const post=async(action,body={})=>{const r=await fetch(base+'/api/updates/'+action,{method:'POST',headers:{'X-Workboard':'1','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,202,await r.clone().text());return r.json();};
  await post('check');const available=await until(get,s=>{if(s.phase==='error')throw Object.assign(Error(s.error),{fatal:true});return s.available;});assert.equal(available.latest,target,'Publish VERSION as the latest stable release before running this test');
  await post('apply',{version:target});
  const installed=await until(get,s=>{if(s.phase==='error')throw Object.assign(Error(s.error),{fatal:true});return s.current===target && s.processId!==initial.processId;});newPID=installed.processId;
  await until(async()=>existsSync(join(dataDir,'update-result.json'))?JSON.parse(readFileSync(join(dataDir,'update-result.json'),'utf8')):{},s=>s.phase==='updated');
  const snapshot=await (await fetch(base+'/api/state')).json();assert.equal(snapshot.appVersion,target);assert.equal(snapshot.error,'');assert.equal(snapshot.state.plans.length,1);
  assert.equal(readFileSync(plan,'utf8'),source);assert.equal(readFileSync(privateFile,'utf8'),'{"private":"keep"}');assert.equal(readFileSync(preference,'utf8'),'{"preference":"keep"}');
  const instructions=readFileSync(join(profile,'.codex','AGENTS.md'),'utf8');assert.ok(instructions.startsWith('# Owner instructions\nKeep the existing user rule.\n'));
  assert.ok(readFileSync(join(profile,'.agents','skills','task-plan','SKILL.md'),'utf8').includes(runtime.replaceAll('\\','/')));
  console.log(JSON.stringify({update:'passed',from:'v0.0.0 test fixture',to:target,source:'private GitHub release',restart:'new process verified',tasks:'unchanged',privateData:'preserved',profile:'isolated and preserved'}));
}finally{
  if(app && app.exitCode===null){const exited=new Promise(r=>app.once('exit',r));app.kill();await exited;}
  if(newPID){try{process.kill(newPID);}catch(e){if(e.code!=='ESRCH')throw e;}await until(async()=>{try{process.kill(newPID,0);return false;}catch{return true;}},Boolean,10000);}
  if(dirname(fixture)!==root || !fixture.startsWith(join(root,'.test-update-')))throw Error('Unsafe fixture cleanup path');
  rmSync(fixture,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
