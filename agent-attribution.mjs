// Audited legacy attribution. Never scan chat logs in the app's refresh loop.
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const defaultAttributionFile=join(dirname(fileURLToPath(import.meta.url)),'agent-attributions.json');
const key=path=>resolve(path).replaceAll('\\','/').toLowerCase();
export function loadAttributions(file=process.env.KRIK_AGENT_MAP || defaultAttributionFile){
  let parsed;
  try{parsed=JSON.parse(readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return new Map();throw Error('Invalid agent attribution registry: '+error.message);}
  if(parsed.version!==1 || !Array.isArray(parsed.records))throw Error('Invalid agent attribution registry format.');
  const records=new Map();
  for(const record of parsed.records){
    if(typeof record.file!=='string' || !/^[a-f0-9]{64}$/.test(record.revision || '') ||
      !['Codex','Anti','Claude'].includes(record.agent) || !record.evidence?.session ||
      !record.evidence?.callId || !Number.isFinite(Date.parse(record.evidence.confirmedAt))){
      throw Error('Invalid verified agent attribution record.');
    }
    if(records.has(key(record.file)))throw Error('Duplicate agent attribution record.');
    records.set(key(record.file),record);
  }
  return records;
}
export function historicalAgent(plan,records){
  const record=records.get(key(join(plan.root,'.tasks',plan.name+'.md')));
  if(!record || record.revision!==plan.revision)return null;
  return {agent:record.agent,agentSource:'History: last verified '+record.agent+' writer ('+record.evidence.confirmedAt+')'};
}
