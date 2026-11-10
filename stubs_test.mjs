import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const here=fileURLToPath(new URL('.',import.meta.url));
const node=(script,args,options={})=>spawnSync(process.execPath,[join(here,script),...args],{encoding:'utf8',windowsHide:true,...options});

test('task-sync is a no-op that exits 0 with a stderr notice for every old command',()=>{
  for(const args of [[],['--agent','Codex','--plan-file','C:/x/.tasks/p.md'],['--agent','Claude','--event','start','--step-line','3']]){
    const r=node('task-sync.mjs',args);
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'');assert.match(r.stderr,/no longer records runs/);
  }
});

test('An old Claude hook gets an empty JSON answer, no context and exit 0',()=>{
  for(const event of [{hook_event_name:'SessionStart'},{hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{file_path:'C:/r/.tasks/p.md',content:'Status: Done'}},{hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'codex exec x'}}]){
    const r=node('task-sync.mjs',['--claude-hook'],{input:JSON.stringify(event)});
    assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{});assert.equal(r.stderr,'');
  }
});

test('task-report without --run-cli does nothing and exits 0',()=>{
  const r=node('task-report.mjs',['--agent','Codex','--role','executor','--plan-file','C:/x.md','--event','done','--result','ok']);
  assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/no longer records runs/);
});

test('task-report --run-cli runs the wrapped CLI unchanged and returns its exit code',()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-ops-stub-'));
  try{
    const out=join(dir,'args.json');
    const child="require('fs').writeFileSync(process.argv[1],JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),stdin:require('fs').readFileSync(0,'utf8')}));process.exit(7)";
    const r=node('task-report.mjs',['--run-cli','--agent','Codex','--coordinator','Claude','--plan-file','C:/p.md','--step-line','5','--',process.execPath,'-e',child,out,'--model','same','--','x y'],{cwd:dir,input:'prompt on stdin'});
    assert.equal(r.status,7,r.stderr);
    const seen=JSON.parse(readFileSync(out,'utf8'));
    assert.deepEqual(seen.args,['--model','same','--','x y']);assert.equal(seen.cwd,dir);assert.equal(seen.stdin,'prompt on stdin');
    const ok=node('task-report.mjs',['--run-cli','--',process.execPath,'-e','process.exit(0)']);
    assert.equal(ok.status,0,ok.stderr);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('task-report --run-cli reports a missing command or separator with exit 1',()=>{
  assert.equal(node('task-report.mjs',['--run-cli','--agent','Codex']).status,1);
  const missing=node('task-report.mjs',['--run-cli','--','agent-ops-no-such-cli-'+process.pid]);
  assert.equal(missing.status,1);assert.match(missing.stderr,/could not start/);
});
