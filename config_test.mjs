import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

// The plan collector is Go code now (internal/plans); its tests are Go tests.
const here=dirname(fileURLToPath(import.meta.url));

// The owner's old machine paths may only appear in the Go migration constant and tests.
test('Shipped files contain no machine-specific D:/1_PROJECTS paths',()=>{
  const legacy=/[A-Za-z]:[\\/]+1_PROJECTS/i,found=[];
  const shipped=['README.md','INSTALL.md','CHANGELOG.md','skills/task-plan/SKILL.md','scripts/install.ps1','web/index.html'];
  for(const name of readdirSync(here))if(/\.(mjs|go)$/.test(name) && !/_test\.(mjs|go)$/.test(name))shipped.push(name);
  // Every shipped or build source below these folders, not only a fixed list.
  for(const folder of ['scripts','cmd','internal','skills','docs']){
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
