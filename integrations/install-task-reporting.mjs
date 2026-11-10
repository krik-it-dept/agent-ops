#!/usr/bin/env node
// Install small, idempotent global reporting rules without changing any repository.
//
// Every in-app update runs this installer, so it must never overwrite what the owner
// changed. It records the sha256 of each part it writes in
// <home>/.agents/workboard-integrations.json and later replaces a part only when the
// file still holds exactly what it wrote (or, with no record yet, a known earlier
// release's text). A part the owner edited or removed is left alone and reported in
// `kept` as "modified locally" or "removed locally".
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {dirname,join,resolve,relative} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url));
const start='<!-- workboard-task-reporting:start -->', end='<!-- workboard-task-reporting:end -->';
const placeholder='{{WORKBOARD_DIR}}';
// sha256 of skills/task-plan/SKILL.md (LF, unrendered) in earlier releases.
const knownSkillTemplates=new Set([
  '36ceb5048cc5a8b9605c4850d905cf4a66f44c464bf3753de3e9e8d53f47b5de',
  '4cad5a07f6c9362b0413cc6efd52c5e6445b13f46ac7c580084cb2d16b29db4d',
]);
const hookEvents=[['SessionStart',''],['PreToolUse','Write|Edit'],['PostToolUse','Write|Edit|Bash']];
const lf=text=>text.replace(/\r\n/g,'\n');
const sha=text=>createHash('sha256').update(lf(text)).digest('hex');
const ownHook=h=>typeof h?.command==='string' && h.command.includes('task-sync.mjs') && h.command.includes('--claude-hook');

export function installReporting(home=homedir(),runtimeDir){
  home=resolve(home);
  const runtime=resolve(runtimeDir || join(home,'.claude','tools','workboard'));
  if(/[\r\n`]/.test(runtime))throw Error('Runtime path contains unsupported characters.');
  if(runtimeDir && !['task-sync.mjs','task-report.mjs','tasks-overview.mjs'].every(file=>existsSync(join(runtime,file))))throw Error('Runtime directory must contain the collector and reporting helpers.');
  const runtimeSlash=runtime.replaceAll('\\','/');
  const shared=join(home,'.agents','skills','task-plan','SKILL.md');
  const canonical=shared.replaceAll('\\','/');
  const template=readFileSync(join(here,'..','skills','task-plan','SKILL.md'),'utf8').replaceAll(placeholder,runtimeSlash);
  const backup=join(home,'.agents','workboard-backups',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
  const ledgerFile=join(home,'.agents','workboard-integrations.json');
  let ledger={version:1,parts:{}};
  if(existsSync(ledgerFile)){
    try{const parsed=JSON.parse(readFileSync(ledgerFile,'utf8'));if(parsed?.parts && typeof parsed.parts==='object')ledger={version:1,parts:{...parsed.parts}};}
    catch{/* An unreadable record is treated as no record: only known earlier text is replaced. */}
  }
  const changes=[],kept=[],records={};
  const partId=(file,part)=>relative(home,file).replaceAll('\\','/')+'#'+part;
  // Decides whether one managed part may be written. current is null when absent.
  function allowed(file,part,current,desired,known){
    const id=partId(file,part),recorded=ledger.parts[id];
    if(current===null){
      if(recorded){kept.push({file,part,reason:'removed locally'});return false;}
      records[id]=sha(desired);return true;
    }
    if(lf(current)===lf(desired)){records[id]=sha(desired);return true;}
    if(recorded?sha(current)===recorded:known(current)){records[id]=sha(desired);return true;}
    kept.push({file,part,reason:'modified locally'});return false;
  }
  function put(file,content){
    const before=existsSync(file)?readFileSync(file,'utf8'):null;
    if(before===content)return;
    if(before!==null){
      const copy=join(backup,relative(home,file));mkdirSync(dirname(copy),{recursive:true});copyFileSync(file,copy);
    }
    mkdirSync(dirname(file),{recursive:true});writeFileSync(file,content,'utf8');changes.push(file);
  }
  const updates=[];
  // Claude's existing slash skill retains its complete workflow, now shared with both other clients.
  for(const file of [shared,join(home,'.claude','skills','task-plan','SKILL.md')]){
    const current=existsSync(file)?readFileSync(file,'utf8'):null;
    if(allowed(file,'file',current,template,text=>knownSkillTemplates.has(sha(lf(text).replaceAll(runtimeSlash,placeholder)))))updates.push([file,template]);
  }
  const settingsFile=join(home,'.claude','settings.json');
  const settings=existsSync(settingsFile)?JSON.parse(readFileSync(settingsFile,'utf8').replace(/^\uFEFF/,'')):{};
  if(!settings || typeof settings!=='object' || Array.isArray(settings))throw Error('Invalid Claude settings object.');
  if(settings.hooks && (typeof settings.hooks!=='object' || Array.isArray(settings.hooks)))throw Error('Invalid Claude hooks configuration.');
  for(const [name]of hookEvents)if(settings.hooks?.[name]!==undefined && !Array.isArray(settings.hooks[name]))throw Error('Invalid Claude hook list.');
  const command='node "'+runtimeSlash+'/task-sync.mjs" --claude-hook';
  // The managed part of settings.json is the list of Agent Ops hooks only.
  const ownHooks=hooks=>JSON.stringify(hookEvents.flatMap(([name])=>(hooks?.[name] || []).flatMap(rule=>Array.isArray(rule?.hooks)?rule.hooks.filter(ownHook).map(h=>({event:name,matcher:rule.matcher || '',command:h.command,type:h.type,timeout:h.timeout})):[])));
  const desiredHooks=JSON.stringify(hookEvents.map(([event,matcher])=>({event,matcher,command,type:'command',timeout:5})));
  const currentHooks=ownHooks(settings.hooks);
  // Without a record, hooks in the installer's own shape (any runtime path) are ours.
  const installerShape=text=>{
    const list=JSON.parse(text);
    return list.length===hookEvents.length && hookEvents.every(([event,matcher],i)=>list[i].event===event && list[i].matcher===matcher && list[i].type==='command' && list[i].timeout===5 && /^node ".*\/task-sync\.mjs" --claude-hook$/.test(list[i].command));
  };
  if(allowed(settingsFile,'hooks',currentHooks==='[]'?null:currentHooks,desiredHooks,installerShape)){
    settings.hooks ||= {};
    for(const [name,matcher]of hookEvents){
      settings.hooks[name]=(settings.hooks[name] || []).flatMap(rule=>{
        if(!Array.isArray(rule.hooks))return [rule];
        const hooks=rule.hooks.filter(h=>!ownHook(h));
        return hooks.length?[{...rule,hooks}]:[];
      });
      settings.hooks[name].push({...(matcher?{matcher}:{}),hooks:[{type:'command',command,timeout:5}]});
    }
    updates.push([settingsFile,JSON.stringify(settings,null,2)+'\n']);
  }
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
    // Earlier releases wrote the block without the host-reporting sentence.
    if(!allowed(file,'block',a>=0?existing.slice(a,b+end.length):null,managed,text=>[block,managed].some(k=>lf(k)===lf(text))))continue;
    if(a>=0)existing=existing.slice(0,a)+managed+existing.slice(b+end.length);
    else existing=existing+(existing && !existing.endsWith('\n')?'\n':'')+'\n'+managed+'\n';
    updates.push([file,existing]);
  }
  for(const [file,content]of updates)put(file,content);
  const parts={...ledger.parts,...records};
  if(JSON.stringify(parts)!==JSON.stringify(ledger.parts)){
    mkdirSync(dirname(ledgerFile),{recursive:true});writeFileSync(ledgerFile,JSON.stringify({version:1,parts},null,2)+'\n','utf8');
  }
  return {changed:changes,kept,backup:existsSync(backup)?backup:null,shared,runtime};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const args=process.argv.slice(2);
    const options={};
    for(let i=0;i<args.length;i+=2){if(!['--home','--runtime-dir'].includes(args[i]) || !args[i+1])throw Error('Usage: node install-task-reporting.mjs [--home <profile>] [--runtime-dir <installed app>]');options[args[i]]=args[i+1];}
    console.log(JSON.stringify(installReporting(options['--home'] || homedir(),options['--runtime-dir']),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
