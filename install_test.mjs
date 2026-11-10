import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const installerPath=fileURLToPath(new URL('./scripts/install.ps1',import.meta.url));
const runtimeFiles=[...readFileSync(installerPath,'utf8').match(/\$files = @\((.*)\)/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
const powershell=(args,env={})=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args],{encoding:'utf8',timeout:90000,env:{...process.env,...env}});
const marked=dir=>{
  const out=powershell(['-Command',"Get-ChildItem -LiteralPath $env:AO_DIR -Recurse -File | Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue } | ForEach-Object { $_.FullName }"],{AO_DIR:dir});
  assert.equal(out.status,0,out.stderr);return out.stdout.split(/\r?\n/).filter(Boolean);
};

// A fake extracted release package whose files all carry the browser's download mark.
function fakePackage(root){
  const pkg=join(root,'package');
  for(const name of runtimeFiles){
    const file=join(pkg,name);mkdirSync(dirname(file),{recursive:true});
    // A short-lived console program stands in for the app so the launch can be observed.
    if(name==='agent-ops.exe')copyFileSync(join(process.env.SystemRoot,'System32','whoami.exe'),file);else writeFileSync(file,'placeholder '+name);
  }
  mkdirSync(join(pkg,'scripts'),{recursive:true});copyFileSync(installerPath,join(pkg,'scripts','install.ps1'));
  const mark=powershell(['-Command',"Get-ChildItem -LiteralPath $env:AO_DIR -Recurse -File | ForEach-Object { Set-Content -LiteralPath $_.FullName -Stream Zone.Identifier -Value \"[ZoneTransfer]`r`nZoneId=3\" }"],{AO_DIR:pkg});
  assert.equal(mark.status,0,mark.stderr);
  return pkg;
}
function withFixture(run){
  const root=mkdtempSync(join(tmpdir(),'agent-ops-install-'));
  try{return run(root,fakePackage(root));}finally{rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
}
const install=(pkg,root,...extra)=>powershell(['-File',join(pkg,'scripts','install.ps1'),'-RuntimeDir',join(root,'runtime'),'-ProfileDir',join(root,'profile'),'-SkipSkills',...extra]);

test('The installer clears the download mark on every installed file',()=>withFixture((root,pkg)=>{
  assert.equal(marked(pkg).length,runtimeFiles.length+1,'every packaged file starts marked');
  // Whether a plain copy keeps the mark depends on the volume (CI temp drives drop it),
  // so the test asserts only the installer's result.
  const out=install(pkg,root,'-NoLaunch');
  assert.equal(out.status,0,out.stdout+out.stderr);
  for(const name of runtimeFiles)assert.ok(existsSync(join(root,'runtime',name)),name+' installed');
  assert.deepEqual(marked(join(root,'runtime')),[],'no installed file keeps the download mark');
}));

test('The installer starts the app unless -NoLaunch is passed',()=>withFixture((root,pkg)=>{
  const skipped=install(pkg,root,'-NoLaunch');
  assert.equal(skipped.status,0,skipped.stdout+skipped.stderr);
  assert.match(skipped.stdout,/Installed:/);assert.match(skipped.stdout,/Not launched \(-NoLaunch\)/);assert.doesNotMatch(skipped.stdout,/Started Agent Ops/);
  const launched=install(pkg,root);
  assert.equal(launched.status,0,launched.stdout+launched.stderr);
  const started=launched.stdout.match(/Started Agent Ops \(process (\d+)\)/);
  assert.ok(started,launched.stdout);
  // Let the stand-in program exit so its image file is not locked when the fixture is removed.
  powershell(['-Command','Wait-Process -Id '+started[1]+' -Timeout 30 -ErrorAction SilentlyContinue']);
}));
