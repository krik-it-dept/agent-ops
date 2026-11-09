import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadAttributions,historicalAgent} from './agent-attribution.mjs';

const workspace=dirname(fileURLToPath(import.meta.url));
function fixture(t){
  const root=mkdtempSync(join(workspace,'.test-attribution-'));
  t.after(()=>{
    if(dirname(resolve(root))!==workspace)throw Error('Unsafe fixture cleanup path');
    rmSync(root,{recursive:true,force:true});
  });
  const plan={root:join(root,'repo'),name:'delivery',revision:'a'.repeat(64)};
  const entry={file:join(plan.root,'.tasks','delivery.md'),revision:plan.revision,agent:'Claude',
    evidence:{session:'verified-session',callId:'verified-call',confirmedAt:'2026-11-09T02:50:03Z'}};
  const file=join(root,'map.json');
  const put=records=>writeFileSync(file,JSON.stringify({version:1,records}));
  return {root,plan,entry,file,put};
}
test('A verified writer resolves only for the exact plan content and location',t=>{
  const f=fixture(t);f.put([f.entry]);const map=loadAttributions(f.file);
  assert.equal(historicalAgent(f.plan,map).agent,'Claude');
  assert.match(historicalAgent(f.plan,map).agentSource,/History: last verified Claude writer/);
  assert.equal(historicalAgent({...f.plan,revision:'b'.repeat(64)},map),null);
  assert.equal(historicalAgent({...f.plan,root:join(f.root,'other-repo')},map),null);
});
test('A missing legacy registry supplies no attribution',t=>{
  const f=fixture(t);assert.equal(loadAttributions(join(f.root,'missing.json')).size,0);
});
test('Malformed, unverified and duplicate registry records fail visibly',t=>{
  const f=fixture(t);
  writeFileSync(f.file,'broken');assert.throws(()=>loadAttributions(f.file),/Invalid agent attribution/);
  f.put([{...f.entry,evidence:{}}]);assert.throws(()=>loadAttributions(f.file),/Invalid verified/);
  f.put([f.entry,f.entry]);assert.throws(()=>loadAttributions(f.file),/Duplicate/);
});
