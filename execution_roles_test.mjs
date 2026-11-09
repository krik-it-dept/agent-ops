import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseExecutors,executionOf} from './execution-roles.mjs';
test('A coordinator or historical writer is never assumed to execute',()=>{
 assert.deepEqual(executionOf({agent:'Claude'},null),{executors:null,executorSource:'Executor not recorded'});
 assert.equal(parseExecutors('Unknown'),null);
 assert.deepEqual(parseExecutors('None'),[]);
});
test('Explicit direct, delegated and parallel executors normalize deterministically',()=>{
 assert.deepEqual(parseExecutors('Codex'),['Codex']);
 assert.deepEqual(parseExecutors('Antigravity'),['Anti']);
 assert.deepEqual(parseExecutors('Anti, Codex'),['Codex','Anti']);
 assert.deepEqual(executionOf({executorLabel:'Claude'},{executors:['Codex']}).executors,['Claude']);
 assert.deepEqual(executionOf({},{executors:['Anti','Codex']}).executors,['Codex','Anti']);
 assert.deepEqual(executionOf({},{executors:[]}).executors,[]);
 for(const invalid of ['Codex, Unknown','Codex, Codex','Codex then Anti','Some agent'])assert.equal(parseExecutors(invalid),null);
});
