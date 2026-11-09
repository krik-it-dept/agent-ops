// Explicit execution roles. A coordinator or writer is never an inferred worker.
export const executorAgents=['Codex','Anti','Claude'];
export function parseExecutors(value){
  if(typeof value!=='string' || !value.trim() || /^unknown$/i.test(value.trim()))return null;
  if(/^none$/i.test(value.trim()))return [];
  const aliases={codex:'Codex',anti:'Anti',antigravity:'Anti',claude:'Claude'};
  const tokens=value.split(',').map(v=>aliases[v.trim().toLowerCase()]);
  if(tokens.some(v=>!v) || new Set(tokens).size!==tokens.length)return null;
  return executorAgents.filter(a=>tokens.includes(a));
}
export function executionOf(plan,slot){
  if(plan.executorLabel)return {executors:parseExecutors(plan.executorLabel),executorSource:'Executor header'};
  const value=slot?.executors ?? slot?.executor;
  if(Array.isArray(value) && !value.length)return {executors:[],executorSource:'Slot executor'};
  if(value!==undefined)return {executors:parseExecutors(Array.isArray(value)?value.join(', '):value),executorSource:'Slot executor'};
  return {executors:null,executorSource:'Executor not recorded'};
}
