#!/usr/bin/env node
// Retired. Agent Ops no longer records runs: it reads plan files directly.
// This stub stays so delegation commands copied into older sessions and plans keep
// working. Without --run-cli it does nothing and exits 0. With
//   node task-report.mjs --run-cli <any old report options> -- <cli> <arguments>
// it runs the wrapped CLI unchanged (same arguments, working directory, stdin and
// environment) and returns its exit code. Nothing is recorded.
import {existsSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

export const retiredNotice='Agent Ops no longer records runs; plans are read directly.';

// wrappedCommand returns the command after "--" of a --run-cli call, or null.
export function wrappedCommand(args){
  if(args[0]!=='--run-cli')return null;
  const divider=args.indexOf('--');
  if(divider<0 || !args[divider+1])throw Error('Use --run-cli [options] -- <cli> <arguments>.');
  return {command:args[divider+1],args:args.slice(divider+2)};
}

// On Windows an npm-installed CLI is a .cmd launcher, which Node cannot start
// without a shell. Prefer a native executable on PATH, and for Codex its bundled
// native binary, so arguments are never re-parsed by cmd.exe.
export function resolveCommand(command,env=process.env,platform=process.platform){
  if(platform!=='win32' || isAbsolute(command) || /[\\/]/.test(command))return command;
  const base=basename(command);
  const dirs=(env.PATH || env.Path || '').split(';').filter(Boolean);
  for(const dir of dirs)for(const ext of /\.(exe|com)$/i.test(base)?['']:['.exe','.com']){
    const file=join(dir,base+ext);if(existsSync(file))return file;
  }
  if(base.replace(/\.cmd$/i,'').toLowerCase()==='codex'){
    for(const dir of dirs){
      if(!existsSync(join(dir,'codex.cmd')))continue;
      const packageRoot=join(dir,'node_modules','@openai','codex'),triple=process.arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
      let vendor=join(packageRoot,'vendor');
      try{vendor=join(dirname(createRequire(pathToFileURL(join(packageRoot,'bin','codex.js'))).resolve('@openai/codex-win32-'+process.arch+'/package.json')),'vendor');}catch{/* Older installations bundle vendor directly. */}
      for(const subdir of ['bin','codex']){const binary=join(vendor,triple,subdir,'codex.exe');if(existsSync(binary))return binary;}
    }
  }
  return command;
}

export function runWrapped({command,args}){
  return new Promise(done=>{
    const child=spawn(resolveCommand(command),args,{stdio:'inherit',windowsHide:true});
    const interrupt=()=>child.kill();
    process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
    const finish=code=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);done(code);};
    child.once('error',error=>{process.stderr.write('task-report: could not start '+command+': '+error.message+'\n');finish(1);});
    child.once('close',(code,signal)=>finish(code ?? (signal?1:0)));
  });
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);
  process.stderr.write('task-report: '+retiredNotice+(args[0]==='--run-cli'?' Running the wrapped command unchanged.':' Nothing to report.')+'\n');
  let wrapped=null;
  try{wrapped=wrappedCommand(args);}catch(error){process.stderr.write('task-report: '+error.message+'\n');process.exitCode=1;}
  if(wrapped)runWrapped(wrapped).then(code=>{process.exitCode=code;});
  else if(process.exitCode===undefined)process.exitCode=0;
}
