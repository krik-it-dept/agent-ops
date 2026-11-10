#!/usr/bin/env node
// Install small, idempotent global reporting rules without changing any repository.
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url));
const start='<!-- workboard-task-reporting:start -->', end='<!-- workboard-task-reporting:end -->';
export function installReporting(home=homedir(),runtimeDir){
  home=resolve(home);
  const runtime=resolve(runtimeDir || join(home,'.claude','tools','workboard'));
  if(/[\r\n`]/.test(runtime))throw Error('Runtime path contains unsupported characters.');
  if(runtimeDir && !['task-sync.mjs','task-report.mjs','tasks-overview.mjs'].every(file=>existsSync(join(runtime,file))))throw Error('Runtime directory must contain the collector and reporting helpers.');
  const shared=join(home,'.agents','skills','task-plan','SKILL.md');
  const canonical=shared.replaceAll('\\','/');
  const template=readFileSync(join(here,'..','skills','task-plan','SKILL.md'),'utf8').replaceAll('{{WORKBOARD_DIR}}',runtime.replaceAll('\\','/'));
  const backup=join(home,'.agents','workboard-backups',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
  const changes=[];
  function put(file,content){
    const before=existsSync(file)?readFileSync(file,'utf8'):null;
    if(before===content)return;
    if(before!==null){
      const copy=join(backup,relative(home,file));mkdirSync(dirname(copy),{recursive:true});copyFileSync(file,copy);
    }
    mkdirSync(dirname(file),{recursive:true});writeFileSync(file,content,'utf8');changes.push(file);
  }
  const updates=[[shared,template]];
  // Claude's existing slash skill retains its complete workflow, now shared with both other clients.
  updates.push([join(home,'.claude','skills','task-plan','SKILL.md'),template]);
  const settingsFile=join(home,'.claude','settings.json');
  const settings=existsSync(settingsFile)?JSON.parse(readFileSync(settingsFile,'utf8').replace(/^\uFEFF/,'')):{};
  if(!settings || typeof settings!=='object' || Array.isArray(settings))throw Error('Invalid Claude settings object.');
  if(settings.hooks && (typeof settings.hooks!=='object' || Array.isArray(settings.hooks)))throw Error('Invalid Claude hooks configuration.');
  settings.hooks ||= {};
  const command='node "'+runtime.replaceAll('\\','/')+'/task-sync.mjs" --claude-hook';
  for(const [name,matcher]of [['SessionStart',''],['PreToolUse','Write|Edit'],['PostToolUse','Write|Edit|Bash']]){
    const existing=settings.hooks[name] || [];if(!Array.isArray(existing))throw Error('Invalid Claude hook list.');
    settings.hooks[name]=existing.flatMap(rule=>{
      if(!Array.isArray(rule.hooks))return [rule];
      const hooks=rule.hooks.filter(h=>!(typeof h.command==='string' && h.command.includes('task-sync.mjs') && h.command.includes('--claude-hook')));
      return hooks.length?[{...rule,hooks}]:[];
    });
    settings.hooks[name].push({...(matcher?{matcher}:{}),hooks:[{type:'command',command,timeout:5}]});
  }
  updates.push([settingsFile,JSON.stringify(settings,null,2)+'\n']);
  for(const [client,file]of [
    ['Codex',join(home,'.codex','AGENTS.md')],
    ['Anti',join(home,'.gemini','GEMINI.md')],
    ['Claude',join(home,'.claude','CLAUDE.md')],
  ]){
    const block=start+'\n## Shared Workboard task reporting\n\n'+
      'This client identity is '+client+'. Direct work uses `Agent: '+client+'` and `Executor: '+client+'`. A delegated CLI worker preserves the parent Agent and reports its own actual execution with `task-report.mjs --role executor`. Workboard is an execution log; clients self-report start, progress and results without owner assignment in the app. For substantial work or progress updates, read `'+canonical+'` before implementation.\n'+
      'Write the shared plan under `.tasks/` in the repository main checkout, including reporter identity, and publish per-task execution evidence through the shared skill. Update it at real stage/milestone changes, blocks, handoffs and before the final response, then use the `task-sync.mjs` command defined by the protocol. Private chat checklists and brain artifacts alone do not update Workboard.\n'+
      'Use only observed progress; preserve work owned by other sessions and respect repository restrictions. Do not create plans for trivial work. Never claim a refresh succeeded if the command failed.\n'+end;
    const managed=block.replace('\n'+end,'\nWhen WORKBOARD_HOST_REPORTING=1, the host runner already records this CLI execution. Do not duplicate its lifecycle reports or widen the worker sandbox for reporting.\n'+end);
    let existing=existsSync(file)?readFileSync(file,'utf8'):'';
    const a=existing.indexOf(start), b=existing.indexOf(end);
    if((a>=0)!==(b>=0) || (a>=0 && b<a))throw Error('Incomplete managed block in '+file);
    if(a>=0)existing=existing.slice(0,a)+managed+existing.slice(b+end.length);
    else existing=existing+(existing && !existing.endsWith('\n')?'\n':'')+'\n'+managed+'\n';
    updates.push([file,existing]);
  }
  for(const [file,content]of updates)put(file,content);
  return {changed:changes,backup:existsSync(backup)?backup:null,shared,runtime};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const args=process.argv.slice(2);
    const options={};
    for(let i=0;i<args.length;i+=2){if(!['--home','--runtime-dir'].includes(args[i]) || !args[i+1])throw Error('Usage: node install-task-reporting.mjs [--home <profile>] [--runtime-dir <installed app>]');options[args[i]]=args[i+1];}
    console.log(JSON.stringify(installReporting(options['--home'] || homedir(),options['--runtime-dir']),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
