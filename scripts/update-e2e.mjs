// N-1 to N in-app update test, fully isolated: no GitHub, no live install, no real
// task folders. It builds the previous release from its Git tag, installs it in a
// temp runtime, then serves the current build from a local release feed:
//   1. previous tag -> N (current source as VERSION). Releases up to v0.2.0 use gh, so
//      a fake gh on PATH answers from the local feed.
//   2. N -> N+1 over the anonymous HTTP feed (--update-feed), with a manifest that adds
//      a file and removes one.
//   3. N+1 -> N+2 whose plan collector fails: the helper must roll back to N+1.
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
const ps=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
const fixture=mkdtempSync(join(root,'.test-e2e-'));
const pids=new Set();
function run(file,args,options={}){const p=spawnSync(file,args,{encoding:'utf8',windowsHide:true,maxBuffer:64<<20,...options});assert.equal(p.status,0,(p.stderr||'')+(p.stdout||'')+(p.error?.message||''));return p.stdout;}
function put(file,text){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
const sha=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,accept,timeout=180000,what='condition'){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await read();if(accept(last))return last;}catch(e){if(e.fatal)throw e;}await sleep(250);}throw Error('Timed out waiting for '+what+': '+JSON.stringify(last));}
function semver(t){return t.slice(1).split('.').map(Number);}
function older(a,b){const x=semver(a),y=semver(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i];return false;}
function previousTag(){
  const i=process.argv.indexOf('--from');if(i>0)return process.argv[i+1];
  const tags=run('git',['-C',root,'tag','--list','v*']).split(/\r?\n/).filter(t=>/^v\d+\.\d+\.\d+$/.test(t)&&older(t,version));
  tags.sort((a,b)=>older(a,b)?1:-1);
  assert.ok(tags.length,'No earlier release tag. Fetch tags first (git fetch --tags).');return tags[0];
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
async function freePort(){const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

try{
  const from=previousTag();
  console.log(`Update E2E: ${from} -> ${version} -> ${next} -> ${broken} (rollback)`);
  // Previous release, built from its tag in a throwaway clone (no change to this repository).
  const oldSource=join(fixture,'old-source');
  run('git',['clone','--quiet','--shared','--no-checkout',root,oldSource]);
  run('git',['-C',oldSource,'-c','advice.detachedHead=false','checkout','--quiet',from]);
  const oldPkg=build(oldSource,join(fixture,'old-build'));
  // Current source as N, N+1 and N+2.
  const pkgN=build(root,join(fixture,'build-n'),version);
  const pkgNext=build(root,join(fixture,'build-next'),next);
  const pkgBroken=build(root,join(fixture,'build-broken'),broken);
  const relN=release(version,pkgN,join(fixture,'release-n'));
  const custom=join(fixture,'package-next');cpSync(pkgNext,custom,{recursive:true});
  rmSync(join(custom,'INSTALL.md'));put(join(custom,'CHANGELOG.md'),'# Fixture changelog\n');
  const relNext=release(next,custom,join(fixture,'release-next'),['INSTALL.md']);
  const bad=join(fixture,'package-broken');cpSync(pkgBroken,bad,{recursive:true});
  rmSync(join(bad,'INSTALL.md'));put(join(bad,'CHANGELOG.md'),'# Fixture changelog\n');
  put(join(bad,'tasks-overview.mjs'),"process.stderr.write('broken collector fixture');process.exit(3);\n");
  const relBroken=release(broken,bad,join(fixture,'release-broken'));

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
  try{
    // Fake gh for updaters up to v0.2.0: "api ... releases/latest" and "release download".
    const bin=join(fixture,'bin');
    put(join(bin,'fake-gh.mjs'),`const a=process.argv.slice(2),feed=process.env.FAKE_GH_FEED;
if(a[0]==='api'){const r=await fetch(feed+'/'+a[a.length-1]);if(!r.ok)process.exit(1);process.stdout.write(await r.text());}
else if(a[0]==='release'&&a[1]==='download'){const tag=a[2],repo=a[a.indexOf('--repo')+1],dir=a[a.indexOf('--dir')+1],{writeFileSync}=await import('node:fs'),{join}=await import('node:path');
for(let i=0;i<a.length;i++)if(a[i]==='--pattern'){const r=await fetch(feed+'/'+repo+'/releases/download/'+tag+'/'+a[i+1]);if(!r.ok)process.exit(1);writeFileSync(join(dir,a[i+1]),Buffer.from(await r.arrayBuffer()));}}
else process.exit(2);
`);
    put(join(bin,'gh.cmd'),`@"${process.execPath}" "%~dp0fake-gh.mjs" %*\r\n`);

    // Previous release installed in an isolated runtime and profile.
    const runtime=join(fixture,'runtime'),profile=join(fixture,'profile'),dataDir=join(fixture,'data');
    put(join(profile,'.codex','AGENTS.md'),'# Owner instructions\nKeep the existing user rule.\n');
    run('powershell.exe',[...ps,'-File',join(oldPkg,'scripts','install.ps1'),'-RuntimeDir',runtime,'-ProfileDir',profile,'-NoLaunch']);
    const privateFile=join(runtime,'historical-executions.json');put(privateFile,'{"private":"keep"}');
    const repos=join(fixture,'repos'),plan=join(repos,'sample','.tasks','check.md'),source='Agent: Codex\nStatus: Testing\nGoal: Isolated update verification\nNext: Verify update\n\n## M1: Work\n- [doing] Verify the app\n';put(plan,source);
    const port=await freePort(),base='http://127.0.0.1:'+port;
    const env={...process.env,PATH:bin+';'+process.env.PATH,FAKE_GH_FEED:feedURL,KRIK_AGENT_MAP:join(fixture,'missing-agent.json'),KRIK_HISTORY_MAP:join(fixture,'missing-history.json'),KRIK_EXECUTION_DIR:join(fixture,'executions')};
    const args=['--background','--no-update-check','--profile-dir',profile,'--addr','127.0.0.1:'+port,'--repos-dir',repos,'--script',join(runtime,'tasks-overview.mjs'),'--data-dir',dataDir];
    const start=extra=>{const p=spawn(join(runtime,'agent-ops.exe'),[...args,...extra],{windowsHide:true,stdio:'ignore',env,detached:true});pids.add(p.pid);p.unref();return p.pid;};
    const status=async()=>{const r=await fetch(base+'/api/updates',{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);const s=await r.json();if(Number.isInteger(s.processId))pids.add(s.processId);return s;};
    const post=async(action,body={})=>{const r=await fetch(base+'/api/updates/'+action,{method:'POST',headers:{'X-Workboard':'1','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,202,await r.clone().text());};
    const fatal=s=>{if(s.phase==='error')throw Object.assign(Error('Update error: '+s.error),{fatal:true});};
    const result=()=>existsSync(join(dataDir,'update-result.json'))?JSON.parse(readFileSync(join(dataDir,'update-result.json'),'utf8')):{};
    async function update(to){
      const before=await status();
      await post('check');const offered=await until(status,s=>{fatal(s);return s.available;},60000,'update offer');assert.equal(offered.latest,to);
      await post('apply',{version:to});
      const after=await until(status,s=>{fatal(s);return s.current===to&&s.processId!==before.processId;},180000,'restart on '+to);
      await until(async()=>result(),r=>r.phase==='updated'&&r.version===to,30000,'update receipt');
      const snapshot=await (await fetch(base+'/api/state')).json();assert.equal(snapshot.appVersion,to);assert.equal(snapshot.error,'');assert.equal(snapshot.state.plans.length,1);
      assert.equal(readFileSync(plan,'utf8'),source,'task source unchanged');assert.equal(readFileSync(privateFile,'utf8'),'{"private":"keep"}','runtime data preserved');
      assert.ok(readFileSync(join(profile,'.codex','AGENTS.md'),'utf8').startsWith('# Owner instructions\nKeep the existing user rule.\n'),'owner instructions preserved');
      return after;
    }

    // 1. Previous release (gh) -> N, the bridge.
    start([]);
    const initial=await until(status,s=>s.current===from,60000,'previous release');
    await update(version);
    assert.ok(existsSync(join(dataDir,'logs','update.log')),'the N helper logs its steps');
    console.log(`  ${from} -> ${version}: installed through the ${from} updater (gh fixture)`);

    // Restart N against the HTTP feed (the restart keeps --update-feed for later relaunches).
    const n=await status();process.kill(n.processId);await until(async()=>{try{await status();return false;}catch{return true;}},Boolean,30000,'N to stop');
    start(['--update-feed',feedURL]);await until(status,s=>s.current===version,60000,'N restart');
    const ghCallsBefore=seen.latest;

    // 2. N -> N+1 over HTTP: CHANGELOG.md added, INSTALL.md removed.
    current=relNext;
    await update(next);
    assert.ok(seen.latest>ghCallsBefore,'N checked the HTTP feed');
    assert.ok(existsSync(join(runtime,'CHANGELOG.md')),'new file installed');assert.ok(!existsSync(join(runtime,'INSTALL.md')),'removed file deleted');
    console.log(`  ${version} -> ${next}: anonymous HTTP feed, manifest added CHANGELOG.md and removed INSTALL.md`);

    // 3. N+1 -> N+2 with a failing collector: rollback to N+1.
    current=relBroken;
    const beforeBroken=await status();
    await post('check');await until(status,s=>{fatal(s);return s.available&&s.latest===broken;},60000,'broken offer');
    await post('apply',{version:broken});
    const restored=await until(status,s=>{if(s.phase==='error'&&s.processId===beforeBroken.processId)fatal(s);return s.current===next&&s.processId!==beforeBroken.processId;},240000,'rollback restart');
    await until(async()=>result(),r=>r.phase==='error'&&r.version===broken,30000,'rollback receipt');
    assert.equal(restored.phase,'error');assert.match(restored.error,/previous version/);
    assert.equal(readFileSync(join(runtime,'tasks-overview.mjs'),'utf8'),readFileSync(join(custom,'tasks-overview.mjs'),'utf8'),'collector restored');
    assert.ok(existsSync(join(runtime,'CHANGELOG.md'))&&!existsSync(join(runtime,'INSTALL.md')),'N+1 file set restored');
    const stages=readdirSync(join(dataDir,'updates')).filter(n=>/^update-\d+$/.test(n));assert.ok(stages.length<=3,'staging pruned: '+stages.length);
    console.log(`  ${next} -> ${broken}: startup check failed, ${next} restored and restarted`);
    console.log(JSON.stringify({updateE2E:'passed',from,to:version,then:[next,broken+' (rolled back)'],initialPid:initial.processId}));
  }finally{await new Promise(r=>feed.close(r));}
}finally{
  for(const pid of pids){try{process.kill(pid);}catch{/* already exited */}}
  await sleep(1000);
  if(dirname(fixture)!==root||!fixture.startsWith(join(root,'.test-e2e-')))throw Error('Unsafe fixture cleanup path');
  rmSync(fixture,{recursive:true,force:true,maxRetries:20,retryDelay:200});
}
