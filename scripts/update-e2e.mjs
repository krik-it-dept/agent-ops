// N-1 to N in-app update test, fully isolated: no GitHub, no live install, no real
// task folders, no real AI client configuration. It builds each previous release
// from its Git tag, installs it in a temp runtime and profile, then serves the
// current build from a local release feed. By default it runs two scenarios: from
// the newest earlier release and from v0.2.1, the bridge release (an owner may be
// on either). With --from vX.Y.Z it runs the first scenario from that release only.
//
// Scenario 1 (newest earlier release, isolated --data-dir):
//   1. previous tag -> N (current source as VERSION) with N's real package manifest,
//      which removes the retired run reporting modules. Releases up to v0.2.0 use gh,
//      so a fake gh on PATH answers from the local feed. The one-time migration must
//      remove the reporting hooks (also from an Orca Claude profile) and instruction
//      blocks the previous installer wrote, replace an unedited old skill, keep an
//      owner-edited one ("modified locally"), and delete the old run history.
//   2. N -> N+1 over the anonymous HTTP feed (--update-feed), with a manifest that adds
//      a file and removes one.
//   3. N+1 -> N+2 whose plan collector fails (a build linked with
//      -X main.testFault=collector) and whose manifest removes a file: the helper must
//      roll back to N+1, including the removed file.
// Scenario 2 (v0.2.1, LOCALAPPDATA redirected to the temp profile for both apps, no
// --data-dir, so the previous release uses its default data folder):
//   1. v0.2.1 -> a broken N (same version, failing collector): the helper migrates the
//      client files, the start fails, and the rollback restores v0.2.1, the hooks,
//      the blocks and the replaced skill, and removes the config.json copy.
//   2. v0.2.1 -> N: the default data folder moves to the Agent Ops folder, config.json
//      is copied, the update log and migration result land there, and the old data
//      folder's run history is deleted.
// The previous release is rebuilt from its tag with today's toolchain, not downloaded
// from GitHub, so the test runs offline; the binary differs from the published asset
// but its updater code is the tagged source. An owner-edited task-plan SKILL.md is
// seeded after the old install and must survive every step unchanged.
// Usage: node scripts/update-e2e.mjs [--from vX.Y.Z]
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,existsSync,cpSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const repo='krik-it-dept/agent-ops',zipName='agent-ops-windows-amd64.zip',manifestName='agent-ops-windows-amd64.manifest.json';
const version=readFileSync(join(root,'VERSION'),'utf8').trim();
const [major,minor,patch]=version.slice(1).split('.').map(Number);
const next=`v${major}.${minor}.${patch+1}`,broken=`v${major}.${minor}.${patch+2}`;
const bridge='v0.2.1';
const ps=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
const fixture=mkdtempSync(join(root,'.test-e2e-'));
const pids=new Set();
// Windows PowerShell 5.1 started from pwsh 7 (the CI default shell) inherits pwsh's PSModulePath and
// then cannot load its own core modules (Get-FileHash missing), so it gets a clean module path.
const ps51Env=env=>{const e={...env};for(const k of Object.keys(e))if(k.toUpperCase()==='PSMODULEPATH')delete e[k];return e;};
function run(file,args,options={}){if(/^powershell(\.exe)?$/i.test(file))options={...options,env:ps51Env(options.env||process.env)};const p=spawnSync(file,args,{encoding:'utf8',windowsHide:true,maxBuffer:64<<20,...options});assert.equal(p.status,0,(p.stderr||'')+(p.stdout||'')+(p.error?.message||''));return p.stdout;}
function put(file,text){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
const sha=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,accept,timeout=180000,what='condition'){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await read();if(accept(last))return last;}catch(e){if(e.fatal)throw e;}await sleep(250);}throw Error('Timed out waiting for '+what+': '+JSON.stringify(last));}
function semver(t){return t.slice(1).split('.').map(Number);}
function older(a,b){const x=semver(a),y=semver(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i];return false;}
function previousTags(){
  const i=process.argv.indexOf('--from');if(i>0)return [process.argv[i+1]];
  const tags=run('git',['-C',root,'tag','--list','v*']).split(/\r?\n/).filter(t=>/^v\d+\.\d+\.\d+$/.test(t)&&older(t,version));
  tags.sort((a,b)=>older(a,b)?1:-1);
  assert.ok(tags.length,'No earlier release tag. Fetch tags first (git fetch --tags).');
  assert.ok(tags.includes(bridge),`The bridge release ${bridge} tag is missing. Fetch tags first (git fetch --tags).`);
  return tags[0]===bridge?[bridge]:[tags[0],bridge];
}
function build(source,out,versionArg){run('powershell.exe',[...ps,'-File',join(source,'scripts','build.ps1'),'-OutputDir',out,...(versionArg?['-Version',versionArg]:[])],{cwd:source});return join(out,readdirSync(out).find(n=>n.startsWith('package-')));}
// Re-packs a package directory as a release: ZIP, checksum and manifest.
function release(tag,pkg,out,remove=[]){
  mkdirSync(out,{recursive:true});const zip=join(out,zipName);
  run('powershell.exe',[...ps,'-Command',`. '${join(root,'scripts','common.ps1').replaceAll("'","''")}'; New-PackageZip -Source '${pkg.replaceAll("'","''")}' -Destination '${zip.replaceAll("'","''")}'`]);
  run('go',['run','./cmd/manifest','-dir',pkg,'-version',tag,'-o',join(out,manifestName),...(remove.length?['-remove',remove.join(',')]:[])],{cwd:root,env:{...process.env,GOTELEMETRY:'off'}});
  const body=readFileSync(zip);writeFileSync(zip+'.sha256',sha(body)+'  '+zipName+'\n');
  const assets={};for(const name of [zipName,zipName+'.sha256',manifestName])assets[name]=readFileSync(join(out,name));
  return {tag,assets};
}
// A build of this source whose plan collector always fails, so its startup check
// fails and the updater rolls back. Release builds never set main.testFault.
function brokenExe(tag,dest){run('go',['build','-trimpath','-ldflags',`-s -w -H windowsgui -X main.appVersion=${tag} -X main.appCommit=fixture -X main.testFault=collector`,'-o',dest,'.'],{cwd:root,env:{...process.env,GOTELEMETRY:'off'}});}
async function freePort(){const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const readJSON=file=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};

try{
  const froms=previousTags();
  console.log(`Update E2E: ${froms.join(' and ')} -> ${version} -> ${next} -> ${broken} (rollback)`);
  // Current source as N, N+1, N+2 and a broken N.
  const pkgN=build(root,join(fixture,'build-n'),version);
  const pkgNext=build(root,join(fixture,'build-next'),next);
  const pkgBroken=build(root,join(fixture,'build-broken'),broken);
  // N ships with the remove list of its real build.
  const builtRemove=JSON.parse(readFileSync(join(fixture,'build-n',manifestName),'utf8')).remove;
  assert.ok(builtRemove.includes('execution-reports.mjs'),'N removes the retired modules');
  const relN=release(version,pkgN,join(fixture,'release-n'),builtRemove);
  const brokenN=join(fixture,'package-broken-n');cpSync(pkgN,brokenN,{recursive:true});
  brokenExe(version,join(brokenN,'agent-ops.exe'));
  const relBrokenN=release(version,brokenN,join(fixture,'release-broken-n'),builtRemove);
  const custom=join(fixture,'package-next');cpSync(pkgNext,custom,{recursive:true});
  rmSync(join(custom,'INSTALL.md'));put(join(custom,'CHANGELOG.md'),'# Fixture changelog\n');
  const relNext=release(next,custom,join(fixture,'release-next'),['INSTALL.md']);
  const bad=join(fixture,'package-broken');cpSync(pkgBroken,bad,{recursive:true});
  rmSync(join(bad,'INSTALL.md'));
  brokenExe(broken,join(bad,'agent-ops.exe'));
  // N+2 also removes CHANGELOG.md, so the rollback must bring a removed file back.
  const relBroken=release(broken,bad,join(fixture,'release-broken'),['CHANGELOG.md']);

  // Local release feed: the GitHub latest-release API and asset downloads.
  let current=relN;const seen={latest:0,downloads:[]};
  const feed=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname===`/repos/${repo}/releases/latest`){
      seen.latest++;
      const assets=Object.entries(current.assets).map(([name,b])=>({name,size:b.length,digest:'sha256:'+sha(b)}));
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tag_name:current.tag,body:'Fixture release '+current.tag,draft:false,prerelease:false,assets}));return;
    }
    const prefix=`/${repo}/releases/download/${current.tag}/`;
    if(url.pathname.startsWith(prefix)&&current.assets[url.pathname.slice(prefix.length)]){seen.downloads.push(url.pathname);res.end(current.assets[url.pathname.slice(prefix.length)]);return;}
    res.statusCode=404;res.end('not found');
  });
  await new Promise(r=>feed.listen(0,'127.0.0.1',r));
  const feedURL='http://127.0.0.1:'+feed.address().port;
  // Fake gh for updaters up to v0.2.0: "api ... releases/latest" and "release download".
  const bin=join(fixture,'bin');
  put(join(bin,'fake-gh.mjs'),`const a=process.argv.slice(2),feed=process.env.FAKE_GH_FEED;
if(a[0]==='api'){const r=await fetch(feed+'/'+a[a.length-1]);if(!r.ok)process.exit(1);process.stdout.write(await r.text());}
else if(a[0]==='release'&&a[1]==='download'){const tag=a[2],repo=a[a.indexOf('--repo')+1],dir=a[a.indexOf('--dir')+1],{writeFileSync}=await import('node:fs'),{join}=await import('node:path');
for(let i=0;i<a.length;i++)if(a[i]==='--pattern'){const r=await fetch(feed+'/'+repo+'/releases/download/'+tag+'/'+a[i+1]);if(!r.ok)process.exit(1);writeFileSync(join(dir,a[i+1]),Buffer.from(await r.arrayBuffer()));}}
else process.exit(2);
`);
  put(join(bin,'gh.cmd'),`@"${process.execPath}" "%~dp0fake-gh.mjs" %*\r\n`);

  async function scenario(from,{redirect}){
    const dir=join(fixture,from);
    // Previous release, built from its tag in a throwaway clone (no change to this repository).
    const oldSource=join(dir,'old-source');
    run('git',['clone','--quiet','--shared','--no-checkout',root,oldSource]);
    run('git',['-C',oldSource,'-c','advice.detachedHead=false','checkout','--quiet',from]);
    const oldPkg=build(oldSource,join(dir,'old-build'));

    // Previous release installed in an isolated runtime and profile. Its installer
    // writes the reporting hooks, instruction blocks and skills into the temp profile.
    const runtime=join(dir,'runtime'),profile=join(dir,'profile'),local=join(profile,'AppData','Local');
    // Redirected: both apps use their default data folders inside the temp profile.
    const oldData=redirect?join(local,'krik-workboard'):join(dir,'data'),dataDir=redirect?join(local,'AgentOps'):oldData;
    const ownerAgents='# Owner instructions\nKeep the existing user rule.\n';
    put(join(profile,'.codex','AGENTS.md'),ownerAgents);
    run('powershell.exe',[...ps,'-File',join(oldPkg,'scripts','install.ps1'),'-RuntimeDir',runtime,'-ProfileDir',profile,'-NoLaunch']);
    const ownerFile=join(runtime,'owner-notes.json');put(ownerFile,'{"private":"keep"}');
    const registry=join(runtime,'historical-executions.json');put(registry,'{"old":"history"}');
    const claudeSettings=join(profile,'.claude','settings.json');
    assert.match(readFileSync(claudeSettings,'utf8'),/task-sync\.mjs/,'the previous installer wrote its hooks');
    const blockedAgents=readFileSync(join(profile,'.codex','AGENTS.md'),'utf8');
    assert.match(blockedAgents,/workboard-task-reporting:start/,'the previous installer wrote its block');
    // An Orca Claude profile holds a copy of the settings with the same hooks.
    const orcaSettings=join(profile,'AppData','Roaming','orca','claude-profiles','fixture','home','settings.json');
    put(orcaSettings,readFileSync(claudeSettings,'utf8'));
    const hookedSettings=readFileSync(claudeSettings,'utf8');
    // The owner edits the shared skill; the Claude copy stays as installed.
    const skill=join(profile,'.agents','skills','task-plan','SKILL.md'),claudeSkill=join(profile,'.claude','skills','task-plan','SKILL.md');
    assert.ok(existsSync(skill)&&existsSync(claudeSkill),'the previous installer wrote both skills');
    const ownerSkill=readFileSync(skill,'utf8')+'\n## Owner rule\n- Keep this local rule.\n';put(skill,ownerSkill);
    const oldClaudeSkill=readFileSync(claudeSkill,'utf8');
    // Run history the previous release recorded next to its state file.
    const history=join(oldData,'state','workboard-executions','run.json');put(history,'{"event":"start"}');
    const repos=join(dir,'repos'),plan=join(repos,'sample','.tasks','check.md'),source='Agent: Codex\nStatus: Testing\nGoal: Isolated update verification\nNext: Verify update\n\n## M1: Work\n- [doing] Verify the app\n';put(plan,source);
    const stateFile=join(dir,'output','tong-hop-chung.json');mkdirSync(dirname(stateFile),{recursive:true});
    // With its default data folder v0.2.x would adopt the first release's fixed folders
    // (legacyDefaults in config.go) when it has no config.json; a seeded config and explicit temp
    // state and slots files keep it on temp files.
    if(redirect)put(join(oldData,'config.json'),JSON.stringify({version:1,setupComplete:true,notifications:false,shortcuts:true,stateFile,projects:[]}));
    const port=await freePort(),base='http://127.0.0.1:'+port;
    // The previous releases still read KRIK_* (run history, attribution, folders): point
    // them at nothing so they never reach the owner's real files.
    const env=ps51Env({...process.env,PATH:bin+';'+process.env.PATH,FAKE_GH_FEED:feedURL,KRIK_AGENT_MAP:join(dir,'missing-agent.json'),KRIK_HISTORY_MAP:join(dir,'missing-history.json'),KRIK_EXECUTION_DIR:'',KRIK_REPOS_DIR:'',KRIK_STATE_FILE:'',KRIK_SLOTS_FILE:'',KRIK_SCRIPT:'',KRIK_ADDR:'',AGENT_OPS_REPOS_DIR:'',AGENT_OPS_STATE_FILE:'',AGENT_OPS_CONFIG:'',
      ...(redirect?{LOCALAPPDATA:local,APPDATA:join(profile,'AppData','Roaming'),CLAUDE_CONFIG_DIR:''}:{})});
    const args=['--background','--no-update-check','--profile-dir',profile,'--addr','127.0.0.1:'+port,'--repos-dir',repos,'--script',join(runtime,'tasks-overview.mjs'),
      ...(redirect?['--state-file',stateFile,'--slots-file',join(dir,'slots.json')]:['--data-dir',dataDir])];
    const start=extra=>{const p=spawn(join(runtime,'agent-ops.exe'),[...args,...extra],{windowsHide:true,stdio:'ignore',env,detached:true});pids.add(p.pid);p.unref();return p.pid;};
    // Releases after v0.3.x require the session secret from session.json; earlier ones ignore the header.
    const sessionHeader=()=>{try{return {'X-Agent-Ops-Session':JSON.parse(readFileSync(join(dataDir,'session.json'),'utf8')).secret};}catch{return {};}};
    const status=async()=>{const r=await fetch(base+'/api/updates',{signal:AbortSignal.timeout(2000),headers:sessionHeader()});assert.equal(r.status,200);const s=await r.json();if(Number.isInteger(s.processId))pids.add(s.processId);return s;};
    // Releases before v0.3.0 check X-Workboard; later ones X-Agent-Ops.
    const post=async(action,body={})=>{const r=await fetch(base+'/api/updates/'+action,{method:'POST',headers:{'X-Workboard':'1','X-Agent-Ops':'1','Content-Type':'application/json',...sessionHeader()},body:JSON.stringify(body)});assert.equal(r.status,202,await r.clone().text());};
    // After a rolled-back update the previous release keeps showing that error; only a new one is fatal.
    let staleError=null;
    const fatal=s=>{if(s.phase==='error'&&s.error!==staleError)throw Object.assign(Error('Update error: '+s.error),{fatal:true});};
    const result=()=>readJSON(join(dataDir,'update-result.json'));
    async function update(to){
      const before=await status();
      await post('check');const offered=await until(status,s=>{fatal(s);return s.available;},60000,'update offer');assert.equal(offered.latest,to);
      await post('apply',{version:to});
      const after=await until(status,s=>{fatal(s);return s.current===to&&s.processId!==before.processId;},180000,'restart on '+to);
      await until(async()=>result(),r=>r.phase==='updated'&&r.version===to,30000,'update receipt');
      const snapshot=await (await fetch(base+'/api/state',{headers:sessionHeader()})).json();assert.equal(snapshot.appVersion,to);assert.equal(snapshot.error,'');assert.equal(snapshot.state.plans.length,1);
      assert.equal(readFileSync(plan,'utf8'),source,'task source unchanged');assert.equal(readFileSync(ownerFile,'utf8'),'{"private":"keep"}','owner runtime file preserved');
      assert.equal(readFileSync(join(profile,'.codex','AGENTS.md'),'utf8'),ownerAgents,'owner instructions kept, reporting block removed');
      assert.equal(readFileSync(skill,'utf8'),ownerSkill,'owner-edited SKILL.md preserved');
      for(const file of [claudeSettings,orcaSettings])assert.doesNotMatch(readFileSync(file,'utf8'),/task-sync/,'reporting hooks removed from '+file);
      assert.match(readFileSync(claudeSkill,'utf8'),/^agent-ops-skill: 2$/m,'the unedited old skill was replaced');
      return after;
    }

    // Releases since v0.2.1 use the HTTP client, so their initial process needs the local feed too.
    const oldUsesGh=older(from,bridge);
    start(oldUsesGh?[]:['--update-feed',feedURL]);
    const initial=await until(status,s=>s.current===from,60000,'previous release');
    const initialFeedCalls=seen.latest;

    if(redirect){
      // 0. A broken N: the client migration runs, the start fails, everything comes back.
      current=relBrokenN;
      await post('check');await until(status,s=>{fatal(s);return s.available&&s.latest===version;},60000,'broken N offer');
      await post('apply',{version});
      const back=await until(status,s=>{if(s.phase==='error'&&s.processId===initial.processId)fatal(s);return s.current===from&&s.processId!==initial.processId;},240000,'rollback to '+from);
      await until(async()=>readJSON(join(oldData,'update-result.json')),r=>r.phase==='error'&&r.version===version,30000,'rollback receipt');
      assert.equal(back.phase,'error');
      for(const file of [claudeSettings,orcaSettings])assert.equal(readFileSync(file,'utf8'),hookedSettings,'hooks restored in '+file);
      assert.equal(readFileSync(join(profile,'.codex','AGENTS.md'),'utf8'),blockedAgents,'instruction block restored');
      assert.equal(readFileSync(claudeSkill,'utf8'),oldClaudeSkill,'replaced skill restored');
      assert.equal(readFileSync(skill,'utf8'),ownerSkill,'owner-edited SKILL.md untouched');
      assert.ok(!existsSync(join(dataDir,'config.json')),'the config.json copy of the failed start was removed');
      assert.ok(!existsSync(join(dataDir,'migration.json')),'no migration recorded for a failed start');
      assert.ok(existsSync(history)&&existsSync(registry),'run history kept until a healthy start');
      assert.ok(existsSync(join(dataDir,'logs','update.log')),'the helper logs in the new data folder');
      staleError=back.error;
      console.log(`  ${from} -> ${version} (broken): startup check failed; ${from}, hooks, blocks and the replaced skill restored, config copy removed`);
      current=relN;
    }

    await update(version);
    assert.ok(seen.latest>initialFeedCalls,'the previous release checked the isolated feed');
    assert.ok(existsSync(join(dataDir,'logs','update.log')),'the N helper logs its steps in the new data folder');
    assert.match(result().message,/Run reporting is retired[^]*Your changes were kept[^]*SKILL\.md \(modified locally\)/,'migration and kept SKILL.md reported');
    for(const name of builtRemove)assert.ok(!existsSync(join(runtime,name)),'retired file removed: '+name);
    assert.ok(readFileSync(join(runtime,'task-sync.mjs'),'utf8').includes('no longer records runs'),'task-sync is the stub');
    assert.ok(!existsSync(history)&&!existsSync(registry),'old run history deleted');
    const migration=JSON.parse(readFileSync(join(dataDir,'migration.json'),'utf8'));
    assert.equal(migration.done,true,'migration recorded as done');
    assert.ok(existsSync(join(migration.backup,'data'))&&existsSync(join(migration.backup,'profile','.claude','settings.json')),'history and client files backed up');
    assert.ok(!existsSync(join(profile,'.agents','workboard-integrations.json')),'old integration record carried into config.json and deleted');
    const config=JSON.parse(readFileSync(join(dataDir,'config.json'),'utf8'));
    assert.ok(Array.isArray(config.integrations)&&config.integrations.some(t=>t.skillDir===dirname(dirname(claudeSkill))&&t.sha256&&t.source==='detected')&&config.integrations.some(t=>t.skillDir===dirname(dirname(skill))&&!t.sha256),'the folder list is seeded from the skill folders found; the edited one stays Modified locally');
    if(redirect){
      assert.equal(config.stateFile,stateFile,'config.json copied from the previous default data folder');
      assert.ok(!existsSync(join(oldData,'state'))&&!existsSync(join(oldData,'activity.jsonl')),'the previous data folder\'s run data deleted');
    }
    console.log(`  ${from} -> ${version}: installed through the ${from} updater (${oldUsesGh?'gh':'anonymous HTTP'} fixture${redirect?', default data folders moved':''}); hooks, blocks and run history removed, owner SKILL.md kept`);
    if(redirect)return {from,initialPid:initial.processId};

    // Restart N against the HTTP feed (the restart keeps --update-feed for later relaunches).
    const n=await status();process.kill(n.processId);await until(async()=>{try{await status();return false;}catch{return true;}},Boolean,30000,'N to stop');
    start(['--update-feed',feedURL]);
    const migratedAt=readFileSync(join(dataDir,'migration.json'),'utf8');await until(status,s=>s.current===version,60000,'N restart');
    const ghCallsBefore=seen.latest;

    // 2. N -> N+1 over HTTP: CHANGELOG.md added, INSTALL.md removed.
    current=relNext;
    await update(next);
    assert.ok(seen.latest>ghCallsBefore,'N checked the HTTP feed');
    assert.ok(existsSync(join(runtime,'CHANGELOG.md')),'new file installed');assert.ok(!existsSync(join(runtime,'INSTALL.md')),'removed file deleted');
    assert.equal(readFileSync(join(dataDir,'migration.json'),'utf8'),migratedAt,'the migration runs once');
    console.log(`  ${version} -> ${next}: anonymous HTTP feed, manifest added CHANGELOG.md and removed INSTALL.md`);

    // 3. N+1 -> N+2 with a failing collector: rollback to N+1. A client file edited
    // while N+2 starts must keep that edit (the rollback never touches client files).
    current=relBroken;
    const beforeBroken=await status();
    await post('check');await until(status,s=>{fatal(s);return s.available&&s.latest===broken;},60000,'broken offer');
    const clientEdit=readFileSync(claudeSettings,'utf8').replace('{','{\n  "model": "edited-during-update",');
    const stagedBefore=new Set(readdirSync(join(dataDir,'updates')));
    await post('apply',{version:broken});
    await until(async()=>readdirSync(join(dataDir,'updates')).some(n=>!stagedBefore.has(n)&&existsSync(join(dataDir,'updates',n,'backup','files.json'))),Boolean,120000,'N+2 installing');
    put(claudeSettings,clientEdit);
    const restored=await until(status,s=>{if(s.phase==='error'&&s.processId===beforeBroken.processId)fatal(s);return s.current===next&&s.processId!==beforeBroken.processId;},240000,'rollback restart');
    await until(async()=>result(),r=>r.phase==='error'&&r.version===broken,30000,'rollback receipt');
    assert.equal(restored.phase,'error');assert.match(restored.error,/previous version/);
    assert.ok(readFileSync(join(runtime,'agent-ops.exe')).equals(readFileSync(join(custom,'agent-ops.exe'))),'the N+1 app restored');
    assert.ok(existsSync(join(runtime,'CHANGELOG.md'))&&!existsSync(join(runtime,'INSTALL.md')),'N+1 file set restored');
    assert.equal(readFileSync(join(runtime,'CHANGELOG.md'),'utf8'),'# Fixture changelog\n','file removed by N+2 restored');
    assert.equal(readFileSync(skill,'utf8'),ownerSkill,'owner-edited SKILL.md preserved through the rollback');
    assert.equal(readFileSync(claudeSettings,'utf8'),clientEdit,'a client edit made during the failed update survives the rollback');
    for(const file of [claudeSettings,orcaSettings])assert.doesNotMatch(readFileSync(file,'utf8'),/task-sync/,'no hook comes back after the rollback');
    const stages=readdirSync(join(dataDir,'updates')).filter(n=>/^update-\d+$/.test(n));assert.ok(stages.length<=3,'staging pruned: '+stages.length);
    console.log(`  ${next} -> ${broken}: startup check failed, ${next} restored (incl. removed CHANGELOG.md) and restarted; a client edit and owner SKILL.md kept`);
    return {from,initialPid:initial.processId};
  }

  try{
    const results=[];
    for(const [i,from] of froms.entries())results.push(await scenario(from,{redirect:i>0}));
    console.log(JSON.stringify({updateE2E:'passed',from:froms,to:version,then:[next,broken+' (rolled back)'],scenarios:results}));
  }finally{await new Promise(r=>feed.close(r));}
}finally{
  for(const pid of pids){try{process.kill(pid);}catch{/* already exited */}}
  await sleep(1000);
  if(dirname(fixture)!==root||!fixture.startsWith(join(root,'.test-e2e-')))throw Error('Unsafe fixture cleanup path');
  rmSync(fixture,{recursive:true,force:true,maxRetries:20,retryDelay:200});
}
