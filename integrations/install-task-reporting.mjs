#!/usr/bin/env node
// The one-time migration from earlier releases (the file keeps the name of the
// retired reporting installer, which installers and older update helpers call).
// It installs nothing: it runs `agent-ops.exe --migrate` from the same install
// folder, which removes the retired reporting hooks and instruction blocks,
// replaces unedited old task-plan skills, deletes old run history (everything is
// backed up first) and prints the result as JSON.
//
//   node integrations/install-task-reporting.mjs [--home <profile>] [--runtime-dir <install folder>] [--data-dir <data folder>]
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));

export function migrationArgs(args){
  const options={};
  for(let i=0;i<args.length;i+=2){
    if(!['--home','--runtime-dir','--data-dir'].includes(args[i]) || !args[i+1])throw Error('Usage: node install-task-reporting.mjs [--home <profile>] [--runtime-dir <install folder>] [--data-dir <data folder>]');
    options[args[i]]=resolve(args[i+1]);
  }
  const runtime=options['--runtime-dir'] || resolve(here,'..');
  const out=['--migrate','--profile-dir',options['--home'] || homedir(),'--runtime-dir',runtime];
  if(options['--data-dir'])out.push('--data-dir',options['--data-dir']);
  return {exe:join(runtime,'agent-ops.exe'),args:out};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const {exe,args}=migrationArgs(process.argv.slice(2));
    if(!existsSync(exe))throw Error('agent-ops.exe was not found next to this script: '+exe);
    const run=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000});
    if(run.error)throw run.error;
    if(run.stdout)process.stdout.write(run.stdout);
    if(run.stderr)process.stderr.write(run.stderr);
    process.exitCode=run.status ?? 1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
