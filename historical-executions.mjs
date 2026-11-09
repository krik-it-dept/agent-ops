// Audited historical contributions. No log scanning or runtime-state inference on refresh.
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {executorAgents} from './execution-roles.mjs';
import {taskLocator} from './execution-reports.mjs';

export const defaultHistoryFile=join(dirname(fileURLToPath(import.meta.url)),'historical-executions.json');
const pathKey=p=>resolve(p).replaceAll('\\','/').toLowerCase();
const hash=value=>/^[a-f0-9]{64}$/.test(value || '');
export function loadHistoricalExecutions(file=process.env.KRIK_HISTORY_MAP || defaultHistoryFile){
 let data;try{data=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw Error('Invalid execution history: '+e.message);}
 if(data.version!==1 || !Array.isArray(data.records))throw Error('Invalid execution history format');
 const seen=new Set();
 for(const r of data.records){
  if(typeof r.file!=='string' || !hash(r.revision) || !r.task?.text || !Number.isInteger(r.task.line) || r.task.line<1 || typeof r.task.milestone!=='string' ||
   !Number.isFinite(Date.parse(r.verifiedAt)) || !Array.isArray(r.contributions) || !r.contributions.length)throw Error('Incomplete execution history record');
  const key=pathKey(r.file)+'|'+r.revision+'|'+r.task.line;if(seen.has(key))throw Error('Duplicate historical task');seen.add(key);
  const agents=new Set();
  for(const c of r.contributions){
   if(!executorAgents.includes(c.agent) || agents.has(c.agent) || !c.summary || !Array.isArray(c.evidence) || !c.evidence.length)throw Error('Invalid historical contributor');
   agents.add(c.agent);
   for(const e of c.evidence)if(!e.sourceLog || !e.messageId || !hash(e.inputHash) || !hash(e.resultHash))throw Error('Historical contributor lacks verified evidence');
  }
 }
 return data.records;
}

export function applyHistoricalExecutions(plan,records){
 const file=pathKey(join(plan.root,'.tasks',plan.name+'.md')),agents=new Set();
 for(const record of records){
  if(pathKey(record.file)!==file || record.revision!==plan.revision)continue;
  const point=plan.points.find(p=>p.line===record.task.line && p.text===record.task.text && taskLocator(plan,p).milestone===record.task.milestone);
  if(!point)continue;
  const contributors=executorAgents.filter(a=>record.contributions.some(c=>c.agent===a));
  for(const a of contributors)agents.add(a);
  point.executionHistory={verifiedAt:record.verifiedAt,agents:contributors,summary:record.contributions.map(c=>c.agent+': '+c.summary).join('; '),source:'Verified session history'};
  point.executors=executorAgents.filter(a=>contributors.includes(a) || (point.executors || []).includes(a));
  point.executorSource=point.execution?'Execution report and verified session history':'Verified session history';
 }
 plan.historicalExecutors=executorAgents.filter(a=>agents.has(a));
 if(agents.size)plan.recordedExecutors=executorAgents.filter(a=>agents.has(a) || (plan.recordedExecutors || []).includes(a));
 return plan;
}
