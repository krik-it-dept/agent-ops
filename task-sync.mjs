#!/usr/bin/env node
// Retired. Agent Ops no longer records runs: it reads plan files directly.
// This stub stays so plans, sessions and Claude hooks written for earlier
// releases keep working: it does nothing and always exits 0.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const retiredNotice='Agent Ops no longer records runs; plans are read directly. Nothing to sync.';

export function retiredSync(args){
  if(args[0]==='--claude-hook'){
    // An old Claude hook passes the tool event on stdin. Drain it and answer with an
    // empty result: no context, no permission decision, no noise on every tool call.
    try{readFileSync(0);}catch{/* No stdin is fine. */}
    return {stdout:'{}',stderr:''};
  }
  return {stdout:'',stderr:'task-sync: '+retiredNotice};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const result=retiredSync(process.argv.slice(2));
  if(result.stdout)process.stdout.write(result.stdout+'\n');
  if(result.stderr)process.stderr.write(result.stderr+'\n');
  process.exitCode=0;
}
