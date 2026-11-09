import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(saved={},nav={}){
 const ids={}, handlers={}, timers=[], requests=[], streams=[],storage={'wb-ui':JSON.stringify(saved),'wb-navigation':JSON.stringify(nav)},writes=[];let context;
 function element(id){return {id,innerHTML:'',textContent:'',className:'',hidden:false,isConnected:true,scrollTop:0,value:'',selectionStart:0,selectionEnd:0,attributes:{},listeners:{},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},showModal(){this.open=true;},close(){this.open=false;},addEventListener(name,fn){this.listeners[name]=fn;},focus(){context.document.activeElement=this;},select(){this.selectionStart=0;this.selectionEnd=this.value.length;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}};}
 ['view','top','tabs','nav','q','refresh','upd','error','live','connection','save-state','plan-sidebar','sidebar-toggle','quick-plan','quick-plan-content','quick-plan-scroll','quick-close','quick-tab-overview','quick-tab-checklist','quick-tab-activity','quick-star','quick-refresh','quick-full','quick-error'].forEach(id=>ids[id]=element(id));
 context=vm.createContext({console,Date,URL,encodeURI,encodeURIComponent,decodeURIComponent,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(i){timers[i-1]=null;},setInterval(){},location:{hash:''},localStorage:{getItem(key){return storage[key] || null;},setItem(k,v){storage[k]=v;writes.push(k);}},window:{addEventListener(name,fn){handlers[name]=fn;}},document:{querySelectorAll(){return [];},activeElement:null,getElementById(id){return ids[id];},addEventListener(name,fn){handlers[name]=fn;}},fetch(path){requests.push(path);return Promise.resolve({ok:true,json:async()=>data([])});},EventSource:class{constructor(){streams.push(this);}}});
 const instrumented=source.replace('jumpHash(); get(); connect();',`globalThis.api={navigation,quick,renderSidebar,sidebarPlans,openQuickPlan,closeQuickPlan,stepQuickPlan,togglePlanStar,recordPlanVisit,quickChecklist,taskRows,filteredTaskRows,taskAgentMatches,focusedTask,refresh,stepExecution,executorBadges, agentChain, agentMatches, executorValue, agentName, agentBadge, viewList, viewTimeline, viewSummary, timelineEntries, dateKey, monthDays, handleViewAction, moveStatus, statusSelect, planByKey, render, columnOf, owner, needsAttention, feedFor, orderedMilestones, stepsHTML, taskCard, prs, jumpHash, connection, showError, connect, get, openColumnMenu,applyColumnMenu,sortTaskColumn,groupedTaskRows,setTaskGroups,columnInput,get columnMenu(){return columnMenu;},setData(j){D=j;}, ui};`);
 vm.runInContext(instrumented,context);
 return {api:context.api,ids,context,handlers,requests,streams,storage,writes,flush(){timers.splice(0).forEach(fn=>fn&&fn());}};
}
function plan(status='Implementing',name='Cải thiện tìm kiếm'){return {repo:'workboard',name,owner:'Minh',revision:'a'.repeat(64),status,tone:'doing',step:1,mtime:new Date().toISOString(),gh:'https://github.com/krik/workboard',root:'C:/sample',goal:'Gọn hơn #12',spec:'plan.md',next:'Kiểm tra kết quả #12',slot:null,steps:[{status:'doing',text:'Kiểm tra tìm kiếm'},{status:'todo',text:'Xác minh #12'}],milestones:[],decisions:[{key:'202611090900',when:'09/11 09:00',text:'Giữ tiếng Việt'}],questions:[{key:'202611090930',when:'09/11 09:30',ask:'Chốt giao diện?',answer:'',open:true}]};}
function data(plans){return {state:{plans,slots:{}},activity:[],stale:{},now:new Date().toISOString(),error:''};}
test('Board has five status columns, assignees and progress without KPI or chat navigation',()=>{const h=harness();h.api.setData(data([plan()]));h.api.render();assert.match(h.ids.view.innerHTML,/In progress/);assert.match(h.ids.view.innerHTML,/Minh/);assert.match(h.ids.view.innerHTML,/1?0?\/2/);assert.equal((h.ids.view.innerHTML.match(/class="column"/g)||[]).length,5);assert.doesNotMatch(h.ids.nav.innerHTML,/Channels|Report|Activity/);assert.doesNotMatch(h.ids.view.innerHTML,/kpis|class="feed"/);});
test('Columns preserve exact stages on cards',()=>{const h=harness();for(const [stage,col]of [['Planning',0],['Implementing',1],['Reviewing',2],['Fixing review',2],['Testing',2],['Waiting for CI',3],['Waiting for owner',3],['Blocked',3],['Shipping',1],['Done',4]])assert.equal(h.api.columnOf(plan(stage)),col,stage);});
test('Status detail stays outside the stage badge',()=>{const h=harness();let card=h.api.taskCard(plan('Waiting for owner - duyệt #12'));assert.match(card,/Waiting for owner<\/span>/);assert.match(card,/class="stage-detail"/);assert.match(card,/pull\/12/);});
test('Actor fallback is slot, header, repo',()=>{const h=harness(),p=plan();assert.equal(h.api.owner(p),'Minh');p.slot={by:'Linh'};assert.equal(h.api.owner(p),'Linh');p.slot=null;p.owner='';assert.equal(h.api.owner(p),'workboard');});
test('Empty board and empty activity use expected labels',()=>{const h=harness();h.api.setData(data([]));h.api.render();assert.match(h.ids.view.innerHTML,/No active plan/);const p=plan();p.decisions=[];p.questions=[];h.api.setData(data([p]));h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab='activity';h.api.render();assert.match(h.ids.view.innerHTML,/No activity yet/);});
test('Board search includes owner and decisions',()=>{const h=harness();h.api.setData(data([plan()]));for(const q of ['Minh','Giữ tiếng Việt']){h.api.ui.q=q;h.api.render();assert.match(h.ids.view.innerHTML,/task-card/);}h.api.ui.q='missing';h.api.render();assert.match(h.ids.view.innerHTML,/No matching work/);});
test('Debounced search preserves header, navigation, scroll and focus',()=>{const h=harness();h.api.setData(data([plan()]));h.api.render();const top=h.ids.top.innerHTML,nav=h.ids.nav.innerHTML,input=h.ids.q;h.ids.view.scrollTop=115;h.ids.view.scrollLeft=312;input.focus();input.value='Minh';input.oninput();assert.equal(h.api.ui.q,'Minh');h.flush();assert.equal(h.ids.top.innerHTML,top);assert.equal(h.ids.nav.innerHTML,nav);assert.equal(h.ids.view.scrollTop,115);assert.equal(h.ids.view.scrollLeft,312);assert.equal(h.context.document.activeElement,input);});
test('Work keeps decisions and questions in separate tabs',()=>{const h=harness(),p=plan();h.api.setData(data([p]));h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab='checklist';h.api.render();assert.match(h.ids.view.innerHTML,/Kiểm tra tìm kiếm/);assert.doesNotMatch(h.ids.view.innerHTML,/Giữ tiếng Việt|Chốt giao diện/);assert.match(h.ids.tabs.innerHTML,/Decisions/);assert.match(h.ids.top.innerHTML,/← Board/);});
test('Milestones and steps retain required order',()=>{const h=harness();const m=(id,state)=>({id,state,steps:[]});assert.deepEqual(Array.from(h.api.orderedMilestones({milestones:[m('M1','todo'),m('M2','done'),m('M3','doing'),m('M4','doing'),m('M5','done')]}),x=>x.id),['M4','M3','M5','M2','M1']);const out=h.api.stepsHTML(['done','todo','partial','blocked','doing'].map(s=>({status:s,text:s})),'');assert.ok(out.indexOf('s-doing')<out.indexOf('s-blocked'));assert.ok(out.indexOf('s-blocked')<out.indexOf('s-partial'));assert.ok(out.indexOf('s-partial')<out.indexOf('s-todo'));assert.ok(out.indexOf('s-todo')<out.indexOf('s-done'));});
test('Historical entries in different plans do not suppress each other',()=>{const h=harness(),a=plan(),b=plan('Testing','Kiểm thử');h.api.setData(data([a,b]));assert.equal(h.api.feedFor(null).length,4);});
test('Encoded toast hash opens the matching plan Summary',()=>{const h=harness();h.context.location.hash='#plan='+encodeURIComponent('workboard/Cải thiện tìm kiếm');h.api.jumpHash();assert.equal(h.api.ui.view,'plan:workboard/Cải thiện tìm kiếm');assert.equal(h.api.ui.tab,'summary');});
test('Ctrl+K focuses search and Escape returns to board',()=>{const h=harness();let prevented=false;h.handlers.keydown({ctrlKey:true,key:'k',preventDefault(){prevented=true;},target:{tagName:'BODY'}});assert.ok(prevented);assert.equal(h.context.document.activeElement,h.ids.q);h.api.setData(data([plan()]));h.api.ui.view='plan:workboard/Cải thiện tìm kiếm';h.handlers.keydown({key:'Escape',target:{tagName:'BODY'}});assert.equal(h.api.ui.view,'home');});
test('Offline status and error banner expose the reason',()=>{const h=harness();h.api.connection(false);assert.equal(h.ids.connection.textContent,'Reconnecting…');h.api.showError('Node failed: test');assert.equal(h.ids.error.hidden,false);assert.equal(h.ids.error.textContent,'Node failed: test');h.api.showError('');assert.equal(h.ids.error.hidden,true);});
test('User text is escaped and pull request numbers link at all lengths',()=>{const h=harness();assert.equal(h.api.prs('<script>#1 #123456</script>','https://github.com/krik/workboard').includes('<script>'),false);assert.match(h.api.prs('#1 #123456','https://github.com/krik/workboard'),/pull\/123456/);});

test('SSE reconnect refetches state and clears the reconnecting label',async()=>{const h=harness();h.api.connect();const es=h.streams[0];es.onerror();assert.equal(h.ids.connection.textContent,'Reconnecting…');es.onopen();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.ids.connection.textContent,'');assert.deepEqual(h.requests,['/api/state']);});

function dragCard(p){return {classList:{add(){},remove(){}},getAttribute(){return p.repo+'/'+p.name;}};}
function dragEvent(card){return {target:{closest(selector){return selector==='[data-plan]'?card:null;}},dataTransfer:{setData(){},effectAllowed:''},preventDefault(){}};}
function dropEvent(index){const column={getAttribute(){return String(index);},classList:{add(){},remove(){}}};return {target:{closest(){return column;}},dataTransfer:{},preventDefault(){}};}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('Cards expose drag targets and details expose all precise plan stages',()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));h.api.render();
 assert.match(h.ids.view.innerHTML,/draggable="true"/);
 assert.match(h.ids.view.innerHTML,/data-plan="workboard\/Cải thiện tìm kiếm"/);
 assert.equal((h.ids.view.innerHTML.match(/data-column=/g)||[]).length,5);
 h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.render();
 assert.match(h.ids.top.innerHTML,/aria-label="Plan status"/);
 for(const stage of ['Testing','Fixing review','Blocked','Waiting for CI','Done'])assert.match(h.ids.top.innerHTML,new RegExp('value="'+stage+'"'));
 p.revision='';assert.match(h.api.statusSelect(p),/ disabled/);
});
test('Explicit plan stage controls the column even with a blocked checklist step',()=>{
 const h=harness(),p=plan();p.steps[0].status='blocked';
 assert.equal(h.api.columnOf(p),1);
 p.status='Planning';assert.equal(h.api.columnOf(p),0);
 p.status='Done';assert.equal(h.api.columnOf(p),4);
 assert.ok(h.api.needsAttention(p));
});
test('Drag Done and drag back save the captured revision without changing checklist',async()=>{
 const h=harness(),p=plan(),calls=[];let server=structuredClone(p);
 h.api.setData(data([p]));
 h.context.fetch=async(path,options)=>{
  if(path==='/api/plans/status'){const body=JSON.parse(options.body);calls.push(body);assert.equal(options.headers['X-Workboard'],'1');server.status=body.status;server.revision='b'.repeat(64);return {ok:true,json:async()=>({saved:true})};}
  return {ok:true,json:async()=>data([structuredClone(server)])};
 };
 h.handlers.dragstart(dragEvent(dragCard(p)));
 // Background refetch must not replace the card under the pointer.
 await h.api.get();assert.equal(calls.length,0);
 h.handlers.drop(dropEvent(4));await settle();
 assert.equal(calls[0].status,'Done');assert.equal(calls[0].revision,p.revision);
 assert.equal(h.api.planByKey(p.repo+'/'+p.name).status,'Done');
 assert.deepEqual(server.steps,p.steps);
 h.handlers.dragstart(dragEvent(dragCard(server)));h.handlers.drop(dropEvent(1));await settle();
 assert.equal(calls[1].status,'Implementing');assert.equal(calls[1].revision,'b'.repeat(64));
 assert.equal(h.api.planByKey(p.repo+'/'+p.name).status,'Implementing');
});
test('Dropping in the same column or dropping an external object never saves',async()=>{
 const h=harness(),p=plan(),calls=[];h.api.setData(data([p]));
 h.context.fetch=async(path)=>{calls.push(path);return {ok:true,json:async()=>data([p])};};
 h.handlers.drop(dropEvent(4));assert.equal(calls.length,0);
 h.handlers.dragstart(dragEvent(dragCard(p)));h.handlers.drop(dropEvent(1));await settle();
 assert.ok(!calls.includes('/api/plans/status'));
});
test('A conflicting move reloads the other session and shows its reason',async()=>{
 const h=harness(),p=plan(),other=plan('Testing');h.api.setData(data([p]));
 h.context.fetch=async(path)=>path==='/api/plans/status'
  ?{ok:false,json:async()=>({error:'This plan changed. Refresh and try again.'})}
  :{ok:true,json:async()=>data([other])};
 await h.api.moveStatus(p.repo+'/'+p.name,'Done',p.revision);
 assert.equal(h.api.planByKey(p.repo+'/'+p.name).status,'Testing');
 assert.match(h.ids.error.textContent,/plan changed/);
 assert.equal(h.ids['save-state'].textContent,'');
});
test('A network failure keeps the original card and exposes the save error',async()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));
 h.context.fetch=async(path)=>{if(path==='/api/plans/status')throw Error('Network unavailable');return {ok:true,json:async()=>data([p])};};
 await h.api.moveStatus(p.repo+'/'+p.name,'Done',p.revision);
 assert.equal(h.api.planByKey(p.repo+'/'+p.name).status,'Implementing');
 assert.equal(h.ids.error.textContent,'Network unavailable');
});
test('Only one save can run at a time',async()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));let release,calls=0;
 h.context.fetch=(path)=>{if(path==='/api/plans/status'){calls++;return new Promise(resolve=>release=resolve);}return Promise.resolve({ok:true,json:async()=>data([p])});};
 const first=h.api.moveStatus(p.repo+'/'+p.name,'Done',p.revision);
 await h.api.moveStatus(p.repo+'/'+p.name,'Planning',p.revision);
 assert.equal(calls,1);
 release({ok:true,json:async()=>({saved:true})});await first;
});

function actionEvent(attr,value,extras={}) {
 const control={getAttribute(name){return name===attr?value:extras[name];}};
 return {target:{closest(selector){return selector==='['+attr+']'?control:null;}}};
}
test('Four layouts share search and agent filters and preserve the selected layout in details',()=>{
 const h=harness(),a=plan(),b=plan('Done','Khác');a.agent='Codex';b.agent='Claude';
 a.steps[0].executors=['Codex'];
 h.api.setData(data([a,b]));h.api.ui.layout='list';h.api.ui.agent='Codex';h.api.render();
 assert.match(h.ids.nav.innerHTML,/>Summary</);assert.match(h.ids.nav.innerHTML,/>List</);assert.match(h.ids.nav.innerHTML,/>Timeline</);
 assert.match(h.ids.view.innerHTML,/work-table/);assert.match(h.ids.view.innerHTML,/Cải thiện/);assert.doesNotMatch(h.ids.view.innerHTML,/Khác/);
 h.api.ui.view='plan:'+a.repo+'/'+a.name;h.api.render();assert.equal(h.api.ui.layout,'list');
 h.handlers.keydown({key:'Escape',target:{tagName:'BODY'}});assert.match(h.ids.view.innerHTML,/work-table/);
 h.api.handleViewAction(actionEvent('data-layout','summary'));assert.equal(h.api.ui.layout,'summary');assert.equal(h.api.ui.agent,'Codex');
 assert.match(h.ids.view.innerHTML,/Agent workload/);
});
test('Agent badges use bundled product icons and unknown identities stay unknown',()=>{
 const h=harness();
 for(const [agent,file]of [['Codex','codex.png'],['Anti','anti.png'],['Claude','claude.svg']]){
  assert.match(h.api.agentBadge({agent}),new RegExp('/icons/'+file.replace('.','\\.')));
 }
 assert.equal(h.api.agentName({owner:'codex discussion',name:'claude migration'}),'Unknown');
 assert.match(h.api.agentBadge({}),/agent-unknown/);
 assert.doesNotMatch(h.api.agentBadge({}),/img/);
});
test('List shows actual checklist tasks with parent plans, task agents and read-only statuses',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.steps[0].executors=['Anti'];const html=h.api.viewList([p]);
 for(const label of ['Work','Plan','Agent','Status','Latest result','Updated'])assert.match(html,new RegExp('>'+label+'<'));
 assert.match(html,/Kiểm tra tìm kiếm/);assert.match(html,/data-open-task=/);assert.match(html,/anti.png/);
 assert.doesNotMatch(html,/data-agent=|data-executor=|data-status=|list-progress/);
});
test('Daily history uses Vietnam dates across UTC midnight and handles leap February',()=>{
 const h=harness();
 assert.equal(h.api.dateKey('2026-11-08T18:00:00Z'),'2026-11-09');
 assert.equal(h.api.dateKey('broken'),'');
 assert.equal(h.api.monthDays('2028-02').length,29);assert.equal(h.api.monthDays('2026-02').length,28);
});
test('Timeline renders recorded events and a separate last-edit marker without invented ranges',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.mtime='2026-11-10T03:00:00Z';p.decisions=[];p.questions=[];
 const j=data([p]);j.now='2026-11-10T04:00:00Z';j.activity=[{repo:p.repo,plan:p.name,ts:'2026-11-08T18:00:00Z',kind:'status',text:'Implementing → Testing'}];
 h.api.setData(j);h.api.ui.month='2026-11';
 const entries=h.api.timelineEntries(p);
 assert.equal(entries.filter(e=>e.kind==='status')[0].day,'2026-11-09');
 assert.equal(entries.filter(e=>e.kind==='updated')[0].day,'2026-11-10');
 const html=h.api.viewTimeline([p]);
 assert.match(html,/Recorded activity by day/);assert.match(html,/data-day="2026-11-09"/);assert.match(html,/timeline-edit/);
 assert.doesNotMatch(html,/duration|estimate|Start date|Due date/);
});
test('Timeline month navigation and clicking a day open its actual activity',()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));h.api.ui.month='2026-12';h.api.ui.layout='timeline';
 h.api.handleViewAction(actionEvent('data-month','1'));assert.equal(h.api.ui.month,'2027-01');
 h.api.handleViewAction(actionEvent('data-month','-1'));assert.equal(h.api.ui.month,'2026-12');
 h.api.handleViewAction(actionEvent('data-open-activity',p.repo+'/'+p.name,{'data-day':'2026-11-09'}));
 assert.equal(h.api.ui.tab,'activity');assert.equal(h.api.ui.activityDay,'2026-11-09');
 assert.match(h.ids.view.innerHTML,/Show all activity/);
 h.api.handleViewAction(actionEvent('data-clear-day',''));assert.equal(h.api.ui.activityDay,'');
});
test('Summary counts plans and real steps, separates unassigned agents, and survives empty data',()=>{
 const h=harness(),a=plan(),b=plan('Done','Shipped');a.agent='Codex';b.agent='Unknown';
 b.steps[0].status='done';b.steps[1].status='done';a.mtime=b.mtime='2026-11-09T01:00:00Z';
 const j=data([a,b]);j.now='2026-11-09T04:00:00Z';h.api.setData(j);
 const html=h.api.viewSummary([a,b]);
 assert.match(html,/Status overview/);assert.match(html,/Agent workload/);assert.match(html,/Step progress/);
 assert.match(html,/>2 <span>\/ 4</);assert.match(html,/data-agent-view="Unknown"/);
 assert.doesNotMatch(html,/NaN|Infinity/);
 h.api.setData(data([]));assert.doesNotMatch(h.api.viewSummary([]),/NaN|Infinity/);
});
test('Coordinator-only workload drill-down opens its plans in grouped List',()=>{
 const h=harness(),p=plan();p.agent='Claude';h.api.setData(data([p]));h.api.ui.layout='summary';
 h.api.handleViewAction(actionEvent('data-agent-view','Claude'));
 assert.equal(h.api.ui.agent,'all');assert.equal(h.api.ui.layout,'list');assert.equal(h.api.ui.taskGroup,'plan');assert.deepEqual(Array.from(h.api.ui.taskPlans),[p.repo+'/'+p.name]);assert.match(h.ids.view.innerHTML,/work-table/);
});
test('Saved Codex and attention filters cannot hide plans on a newly opened window',()=>{
 const h=harness({layout:'summary',view:'waiting',agent:'Codex',q:'old query'});
 const ps=Array.from({length:6},(_,i)=>plan('Implementing','Plan '+i));
 h.api.setData(data(ps));h.api.render();
 assert.equal(h.api.ui.layout,'summary');assert.equal(h.api.ui.view,'home');assert.equal(h.api.ui.agent,'all');assert.equal(h.api.ui.q,'');
 assert.match(h.ids.top.innerHTML,/6 of 6 plans/);assert.match(h.ids.view.innerHTML,/6 plans by current status/);
});
test('Filtered Summary explains hidden plans instead of showing false zero charts',()=>{
 const h=harness(),ps=Array.from({length:6},(_,i)=>plan('Waiting for owner','Plan '+i));
 h.api.setData(data(ps));h.api.ui.layout='summary';h.api.ui.view='waiting';h.api.ui.agent='Codex';h.api.render();
 assert.match(h.ids.view.innerHTML,/6 plans are available/);assert.match(h.ids.view.innerHTML,/Agent: Codex/);assert.match(h.ids.view.innerHTML,/data-clear-filters/);
 assert.doesNotMatch(h.ids.view.innerHTML,/summary-stats|status-chart/);
 assert.match(h.ids.view.innerHTML,/no reported agent yet/);
 h.api.handleViewAction(actionEvent('data-clear-filters',''));
 assert.equal(h.api.ui.agent,'all');assert.equal(h.api.ui.view,'home');
 assert.match(h.ids.view.innerHTML,/6 plans by current status/);
});
test('Choosing a layout exits the attention-only view',()=>{
 const h=harness();h.api.setData(data([plan()]));h.api.ui.view='waiting';
 h.api.handleViewAction(actionEvent('data-layout','summary'));
 assert.equal(h.api.ui.view,'home');assert.match(h.ids.view.innerHTML,/1 plans by current status/);
});
test('Zero-workload agent rows cannot activate a filter that hides all work',()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));h.api.ui.layout='summary';
 assert.match(h.api.viewSummary([p]),/data-agent-view="Codex" disabled/);
 h.api.handleViewAction(actionEvent('data-agent-view','Codex'));
 assert.equal(h.api.ui.agent,'all');assert.equal(h.api.ui.layout,'summary');
});
test('A Claude coordinator renders Codex and Anti executors with read-only role badges',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.executors=['Codex','Anti'];h.api.setData(data([p]));
 const chain=h.api.agentChain(p);
 assert.match(chain,/claude.svg/);assert.match(chain,/codex.png/);assert.match(chain,/anti.png/);
 assert.match(chain,/Coordinator: Claude; executors: Codex, Anti/);
 h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.render();
 assert.match(h.ids.top.innerHTML,/>Coordinator</);assert.match(h.ids.top.innerHTML,/>Executed by</);
 assert.doesNotMatch(h.ids.top.innerHTML,/data-executor=|data-agent=/);
});
test('Agent filtering and workload count worker roles without relabelling the coordinator',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.executors=['Codex'];h.api.setData(data([p]));
 p.steps[0].execution={state:'doing',reportedAt:new Date().toISOString(),activeAgents:['Codex']};
 assert.ok(h.api.agentMatches(p,'Codex'));assert.ok(h.api.agentMatches(p,'Claude'));
 assert.ok(!h.api.agentMatches(p,'Anti'));
 h.api.ui.layout='list';h.api.ui.agent='Codex';h.api.render();assert.match(h.ids.view.innerHTML,/Cải thiện/);
 const summary=h.api.viewSummary([p]);
 assert.match(summary,/1 coordinating · 0 active tasks/);assert.match(summary,/0 coordinating · 1 active task/);
 assert.equal(p.agent,'Claude');
});
test('A writer with no executor metadata remains unknown in that role',()=>{
 const h=harness(),p=plan();p.agent='Claude';
 assert.equal(h.api.executorValue(p),'Unknown');
 assert.match(h.api.agentChain(p),/executors: Unknown/);
 p.executors=['Claude'];assert.doesNotMatch(h.api.agentChain(p),/role-arrow/);
 p.executors=[];assert.equal(h.api.executorValue(p),'None');
});

test('Agent identity and per-task results are read-only in every view',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.executors=['Codex','Anti'];
 p.steps[0].executors=['Codex'];p.steps[0].execution={reportedAt:new Date().toISOString(),result:'Tests passed #12',activeAgents:['Codex']};
 h.api.setData(data([p]));
 for(const view of ['list','board','summary','timeline']){
  h.api.ui.view='home';h.api.ui.layout=view;h.api.render();assert.doesNotMatch(h.ids.view.innerHTML,/data-agent=|data-executor=|data-assignment|Assign agent/);
 }
 h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab='checklist';h.api.render();
 assert.match(h.ids.view.innerHTML,/codex.png/);assert.match(h.ids.view.innerHTML,/Tests passed/);assert.match(h.ids.tabs.innerHTML,/Work <span>2/);assert.match(h.ids.view.innerHTML,/Latest report/);
 assert.doesNotMatch(h.ids.view.innerHTML+h.ids.top.innerHTML,/data-agent=|data-executor=|data-assignment|Assign agent/);
});

test('Multi shows observed contributors while an active task shows the current reporting worker',()=>{
 const h=harness(),s={executors:['Codex','Anti'],execution:{activeAgents:['Anti']}};
 assert.match(h.api.executorBadges(s),/>Multi</);assert.doesNotMatch(h.api.executorBadges(s),/role-plus|Codex \+ Anti/);
 const active=h.api.stepExecution(s);assert.match(active,/anti.png/);assert.doesNotMatch(active,/codex.png/);
 s.execution.activeAgents=[];assert.match(h.api.stepExecution(s),/>Multi</);
});

test('F5 checks fresh progress while preserving view, search and filters and preventing browser reload',async()=>{
 const h=harness(),p=plan(),j=data([p]);j.state.generatedAt='2026-11-09T05:00:00Z';h.api.setData(j);
 h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.q='test';h.api.ui.agent='Codex';h.api.ui.layout='list';h.api.render();
 const calls=[];h.context.fetch=async(path,options)=>{
  calls.push([path,options]);if(path==='/api/refresh')return {ok:true,json:async()=>({refreshedAt:'2026-11-09T05:05:00Z'})};
  const updated=structuredClone(j);updated.state.generatedAt='2026-11-09T05:05:00Z';return {ok:true,json:async()=>updated};
 };
 let prevented=false;h.handlers.keydown({key:'F5',target:{tagName:'INPUT'},preventDefault(){prevented=true;}});await settle();
 assert.ok(prevented);assert.deepEqual(calls.map(c=>c[0]),['/api/refresh','/api/state']);assert.equal(calls[0][1].method,'POST');
 assert.equal(h.api.ui.view,'plan:'+p.repo+'/'+p.name);assert.equal(h.api.ui.q,'test');assert.equal(h.api.ui.agent,'Codex');assert.equal(h.api.ui.layout,'list');
 assert.match(h.ids.upd.textContent,/Checked/);assert.match(h.ids.upd.title,/05:05:00Z/);assert.equal(h.ids['save-state'].textContent,'Progress updated');
});

test('Repeated F5 and Refresh clicks share one check while a request is pending',async()=>{
 const h=harness();h.api.setData(data([plan()]));let complete;const calls=[];
 h.context.fetch=(path)=>{calls.push(path);if(path==='/api/refresh')return new Promise(r=>{complete=r;});return Promise.resolve({ok:true,json:async()=>data([plan()])});};
 const first=h.api.refresh(),second=h.api.refresh();assert.equal(first,second);assert.deepEqual(calls,['/api/refresh']);
 complete({ok:true,json:async()=>({refreshedAt:new Date().toISOString()})});await first;
 assert.deepEqual(calls,['/api/refresh','/api/state']);
});

test('Failed F5 keeps the last successful check time and visible tasks and explains the failure',async()=>{
 const h=harness(),p=plan(),j=data([p]);j.state.generatedAt='2026-11-09T05:00:00Z';h.api.setData(j);h.api.render();const old=h.ids.upd.title;
 h.context.fetch=async()=>({ok:false,json:async()=>({error:'Node failed: collector unavailable'})});
 await h.api.refresh();assert.match(h.ids.error.textContent,/collector unavailable/);assert.equal(h.ids['save-state'].textContent,'Progress check failed');
 assert.equal(h.ids.upd.title,old);assert.match(h.ids.view.innerHTML,/Cải thiện/);
});

test('Verified history fills the Agent column with icons and Multi while remaining separate from current reports',()=>{
 const h=harness(),p=plan();p.steps[0].executors=['Codex','Claude'];p.steps[0].executionHistory={verifiedAt:'2026-11-07T12:10:00Z',summary:'Verified CLI review and implementation'};
 h.api.setData(data([p]));h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab='checklist';h.api.render();
 assert.match(h.ids.view.innerHTML,/codex.png/);assert.match(h.ids.view.innerHTML,/claude.svg/);assert.match(h.ids.view.innerHTML,/>Multi</);assert.match(h.ids.view.innerHTML,/Verified history/);
 assert.match(h.ids.tabs.innerHTML,/Work <span>2/);assert.match(h.ids.view.innerHTML,/Verified CLI review/);assert.doesNotMatch(h.ids.view.innerHTML,/data-executor=|Assign agent/);
 assert.match(h.api.viewSummary([p]),/0 coordinating · 0 active tasks/);assert.equal(p.steps[0].status,'doing');
});

test('List defaults to individual In progress tasks even when their parent plan has a different stage',()=>{
 const h=harness({layout:'list',taskStatus:'done'}),p=plan('Done','Parent plan');
 p.steps=[{status:'todo',text:'Not started',line:5},{status:'doing',text:'Actual current work',line:6,executors:['Codex']},{status:'done',text:'Already shipped',line:7}];
 p.milestones=[{id:'M1',steps:p.steps}];h.api.setData(data([p]));h.api.render();
 assert.equal(h.api.ui.taskStatus,'doing');assert.match(h.ids.top.innerHTML,/1 of 3 tasks/);assert.match(h.ids.view.innerHTML,/Status: In progress/);assert.match(h.ids.view.innerHTML,/data-column-menu="status"/);
 assert.match(h.ids.view.innerHTML,/Actual current work/);assert.doesNotMatch(h.ids.view.innerHTML,/Not started|Already shipped/);
 assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,1);assert.match(h.ids.view.innerHTML,/codex.png/);
 assert.equal(h.api.taskRows([p]).length,3);assert.match(h.ids.view.innerHTML,/Plan status: Done/);
});

test('A plan in progress cannot turn To do tasks into work in progress, and empty List offers all statuses',()=>{
 const h=harness({layout:'list'}),p=plan();p.steps=[{status:'todo',text:'Queued task'}];h.api.setData(data([p]));h.api.render();
 assert.match(h.ids.view.innerHTML,/No tasks in progress/);assert.match(h.ids.view.innerHTML,/1 checklist tasks are available/);assert.match(h.ids.view.innerHTML,/data-task-status-all/);
 h.api.handleViewAction(actionEvent('data-task-status-all',''));
 assert.equal(h.api.ui.taskStatus,'all');assert.match(h.ids.view.innerHTML,/Queued task/);assert.match(h.ids.top.innerHTML,/1 of 1 tasks/);
});

test('Status filters, task search and executing-agent filters combine without coordinator inheritance',()=>{
 const h=harness({layout:'list'}),p=plan();p.agent='Claude';p.executors=['Codex','Anti'];
 p.steps=[{status:'doing',text:'Search resolver',executors:['Codex'],execution:{activeAgents:['Codex'],reportedAt:'2026-11-09T06:00:00Z',result:'Regression checks passed'}},{status:'todo',text:'Search UI',executors:['Anti']},{status:'done',text:'Closed search',executors:['Claude']}];
 h.api.setData(data([p]));h.api.ui.taskStatus='all';h.api.ui.agent='Anti';h.api.render();
 assert.match(h.ids.view.innerHTML,/Search UI/);assert.doesNotMatch(h.ids.view.innerHTML,/Search resolver|Closed search/);
 h.api.ui.agent='Claude';h.api.ui.taskStatus='doing';h.api.render();assert.match(h.ids.view.innerHTML,/No matching tasks/);
 h.api.ui.agent='Codex';h.api.ui.q='Regression';h.api.render();assert.match(h.ids.view.innerHTML,/Search resolver/);
 h.api.openColumnMenu('status');const ev=actionEvent('data-column-field','status');ev.target.value='done';h.handlers.change(ev);h.api.applyColumnMenu();
 assert.equal(h.api.ui.taskStatus,'done');assert.match(h.ids.view.innerHTML,/No matching tasks/);
 h.api.handleViewAction(actionEvent('data-clear-filters',''));assert.equal(h.api.ui.taskStatus,'all');assert.equal(h.api.ui.agent,'all');assert.equal(h.api.ui.q,'');
 assert.match(h.ids.top.innerHTML,/3 of 3 tasks/);
});

test('List uses task-level report/history timestamps and never presents plan edits as task updates',()=>{
 const h=harness(),p=plan();p.steps=[{status:'doing',text:'No task evidence'},{status:'done',text:'Historic review',executors:['Codex','Claude'],executionHistory:{verifiedAt:'2026-11-07T12:00:00Z',summary:'Reviewed and implemented'}},{status:'doing',text:'Current fix',executors:['Anti'],execution:{activeAgents:['Anti'],reportedAt:'2026-11-09T06:00:00Z',result:'Unit checks passed'}}];
 h.api.ui.taskStatus='all';const html=h.api.viewList([p]);
 assert.match(html,/Not recorded/);assert.match(html,/History verified/);assert.match(html,/Execution report/);assert.match(html,/Unit checks passed/);assert.match(html,/>Multi</);
 assert.doesNotMatch(html,new RegExp('time title="'+p.mtime.replaceAll('.','\\.')+'"'));assert.doesNotMatch(html,/data-status=|data-agent=|data-executor=/);
});

test('Clicking a task opens and focuses its exact source row, including duplicate milestone and loose text',()=>{
 const h=harness({layout:'list'}),p=plan(),a={status:'doing',text:'Duplicate',line:5,milestone:''},b={status:'doing',text:'Duplicate',line:8,milestone:'M1'};
 p.steps=[a,b];p.milestones=[{id:'M1',title:'Delivery',steps:[{...b}]}];h.api.setData(data([p]));h.api.render();
 let scrolled=false,focused=false;h.ids['task-line-5']={scrollIntoView(){scrolled=true;},focus(){focused=true;}};
 h.api.handleViewAction(actionEvent('data-open-task',p.repo+'/'+p.name,{'data-task-index':'0','data-task-revision':p.revision}));
 assert.equal(h.api.ui.view,'plan:'+p.repo+'/'+p.name);assert.equal(h.api.ui.tab,'checklist');assert.equal(h.api.focusedTask(p).line,5);
 assert.ok(scrolled && focused);assert.match(h.ids.view.innerHTML,/task-focused s-doing" id="task-line-5"/);assert.match(h.ids.view.innerHTML,/id="task-line-8"/);
 assert.match(h.ids.top.innerHTML,/← List/);assert.equal((h.ids.view.innerHTML.match(/id="task-line-8"/g)||[]).length,1);
});

test('Old task links are rejected after a concurrent revision and ambiguous highlights never move to a duplicate',()=>{
 const h=harness({layout:'list'}),p=plan();p.steps=[{status:'doing',text:'Same',milestone:'M1',line:5},{status:'doing',text:'Same',milestone:'M1',line:6}];
 h.api.setData(data([p]));h.api.render();
 h.api.handleViewAction(actionEvent('data-open-task',p.repo+'/'+p.name,{'data-task-index':'1','data-task-revision':p.revision}));
 assert.equal(h.api.focusedTask(p).line,6);
 const updated={...p,revision:'b'.repeat(64)};h.api.setData(data([updated]));assert.equal(h.api.focusedTask(updated),null);
 h.api.ui.view='home';h.api.handleViewAction(actionEvent('data-open-task',p.repo+'/'+p.name,{'data-task-index':'1','data-task-revision':p.revision}));
 assert.equal(h.api.ui.view,'home');assert.match(h.ids.error.textContent,/task changed/);
});

test('F5 preserves the chosen task status and task search in the new List',async()=>{
 const h=harness({layout:'list'}),p=plan();p.steps[1].status='done';p.steps[1].executors=['Codex'];h.api.setData(data([p]));
 h.api.ui.taskStatus='done';h.api.ui.agent='Codex';h.api.ui.q='Xác minh';h.api.render();
 h.context.fetch=async path=>({ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([p])});
 await h.api.refresh();assert.equal(h.api.ui.taskStatus,'done');assert.equal(h.api.ui.q,'Xác minh');assert.equal(h.api.ui.agent,'Codex');
 assert.match(h.ids.view.innerHTML,/Xác minh #12/);assert.doesNotMatch(h.ids.view.innerHTML,/Kiểm tra tìm kiếm/);
});

test('Needs attention List excludes completed siblings while showing the blocked plan unfinished tasks',()=>{
 const h=harness({layout:'list'}),p=plan('Blocked');p.questions=[];p.steps=[{status:'todo',text:'Blocked follow-up'},{status:'done',text:'Finished sibling'}];
 h.api.setData(data([p]));h.handlers.click(actionEvent('data-go','waiting'));
 assert.equal(h.api.ui.taskStatus,'all');assert.match(h.ids.view.innerHTML,/Blocked follow-up/);assert.doesNotMatch(h.ids.view.innerHTML,/Finished sibling/);
});

function changeControl(h,attr,value,extra={}){const ev=actionEvent(attr,extra.key || '');Object.assign(ev.target,{value,...extra});h.handlers.change(ev);}
function listRows(h){return Array.from(h.api.filteredTaskRows(h.api.taskRows(h.context.__plans || [])),r=>r.s.text);}
function setList(h,ps){h.context.__plans=ps;h.api.setData(data(ps));h.api.ui.layout='list';h.api.ui.taskStatus='all';h.api.render();}

test('Plan header drafts a multi-selection, distinguishes identical names by repo and applies only on Apply',()=>{
 const h=harness(),a=plan('Implementing','Same'),b=plan('Implementing','Same'),c=plan('Implementing','Other');b.repo='second';setList(h,[a,b,c]);
 const before=JSON.stringify([a,b,c]);h.api.handleViewAction(actionEvent('data-column-menu','plan'));
 assert.match(h.ids.view.innerHTML,/role="dialog" aria-label="Plan filter and sort"/);
 h.api.handleViewAction(actionEvent('data-column-plans','none'));
 changeControl(h,'data-column-plan-choice','',{key:'workboard/Same',checked:true});
 changeControl(h,'data-column-plan-choice','',{key:'workboard/Other',checked:true});
 assert.equal(h.api.ui.taskPlans,null);assert.equal(listRows(h).length,6);
 h.api.handleViewAction(actionEvent('data-column-apply',''));
 assert.deepEqual(Array.from(h.api.ui.taskPlans),['workboard/Same','workboard/Other']);assert.equal(listRows(h).length,4);
 assert.doesNotMatch(h.ids.view.innerHTML,/second ·/);assert.match(h.ids.view.innerHTML,/Plans: Same \(workboard\), Other \(workboard\)/);
 h.api.openColumnMenu('plan');h.api.handleViewAction(actionEvent('data-column-plans','none'));h.api.applyColumnMenu();
 assert.equal(listRows(h).length,0);assert.match(h.ids.view.innerHTML,/None selected/);
 h.api.openColumnMenu('plan');h.api.handleViewAction(actionEvent('data-column-clear','plan'));assert.equal(listRows(h).length,6);
 assert.equal(JSON.stringify([a,b,c]),before);assert.equal(h.requests.length,0);
});

test('Plan option search narrows choices without applying a task filter; cancel and Escape discard drafts',()=>{
 const h=harness();setList(h,[plan('Implementing','Alpha'),plan('Implementing','Beta')]);h.api.openColumnMenu('plan');
 const ev=actionEvent('data-column-plan-search','');ev.target.value='Alpha';h.handlers.input(ev);
 assert.match(h.ids.view.innerHTML,/data-column-plan-choice="workboard\/Alpha"/);assert.doesNotMatch(h.ids.view.innerHTML,/data-column-plan-choice="workboard\/Beta"/);assert.equal(listRows(h).length,4);
 h.api.handleViewAction(actionEvent('data-column-plans','none'));h.api.handleViewAction(actionEvent('data-column-cancel',''));assert.equal(h.api.ui.taskPlans,null);
 h.api.openColumnMenu('work');changeControl(h,'data-column-field','Never');let prevented=false;
 h.handlers.keydown({key:'Escape',target:{tagName:'INPUT'},preventDefault(){prevented=true;}});
 assert.ok(prevented);assert.equal(h.api.columnMenu,null);assert.equal(h.api.ui.view,'home');assert.equal(h.api.ui.taskWork,'');
});

test('All task headers sort in either direction, use numeric text order and keep missing evidence last',()=>{
 const h=harness(),ps=['10','2','3'].map((n,i)=>{const p=plan('Implementing','Plan '+n);p.steps=[{text:'Work '+n,status:['doing','todo','done'][i],executors:[['Claude','Anti','Codex'][i]]}];return p;});
 ps[0].steps[0].execution={reportedAt:'2026-11-09T00:00:00Z',result:'Result 10'};ps[1].steps[0].executionHistory={verifiedAt:'2026-11-08T00:00:00Z',summary:'Result 2'};setList(h,ps);
 const expected={work:[[2,3,10],[10,3,2]],plan:[[2,3,10],[10,3,2]],agent:[[2,10,3],[3,10,2]],status:[[10,2,3],[3,2,10]],result:[[2,10,3],[10,2,3]],updated:[[2,10,3],[10,2,3]]};
 for(const [column,orders]of Object.entries(expected))for(const [i,direction]of ['asc','desc'].entries()){
  h.api.openColumnMenu(column);h.api.handleViewAction(actionEvent('data-column-sort',column,{'data-direction':direction}));
  assert.deepEqual(listRows(h),orders[i].map(n=>'Work '+n),column+' '+direction);assert.match(h.ids.view.innerHTML,new RegExp('aria-sort="'+(i?'descending':'ascending')+'"'));assert.equal(h.api.columnMenu,null);
 }
 h.api.sortTaskColumn('work','default');assert.equal(h.api.ui.taskSort,null);assert.deepEqual(listRows(h),['Work 10','Work 2','Work 3']);
 assert.equal(h.requests.length,0);
});

test('Header text, status and actual executor filters combine; clearing one column preserves the rest',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.steps=[{text:'Search current',status:'doing',executors:['Codex'],execution:{activeAgents:['Codex'],result:'Unit checks passed',reportedAt:'2026-11-09T00:00:00Z'}},{text:'Search queued',status:'todo',executors:['Anti']}];setList(h,[p]);
 for(const [c,v]of [['work',' Search '],['result','checks'],['status','doing'],['agent','Codex']]){h.api.openColumnMenu(c);changeControl(h,'data-column-field',v);h.api.applyColumnMenu();}
 assert.deepEqual(listRows(h),['Search current']);assert.equal(h.api.ui.taskWork,'Search');
 h.api.openColumnMenu('agent');changeControl(h,'data-column-field','Claude');h.api.applyColumnMenu();assert.equal(listRows(h).length,0);
 h.api.openColumnMenu('agent');h.api.handleViewAction(actionEvent('data-column-clear','agent'));assert.deepEqual(listRows(h),['Search current']);assert.equal(h.api.ui.taskResult,'checks');assert.equal(h.api.ui.taskStatus,'doing');
});

test('Updated header filters inclusive Vietnam dates and missing dates, rejecting reversed ranges',()=>{
 const h=harness(),p=plan();p.steps=[{text:'Start boundary',status:'doing',execution:{reportedAt:'2026-11-08T17:00:00Z'}},{text:'End boundary',status:'done',executionHistory:{verifiedAt:'2026-11-09T16:59:59Z'}},{text:'Next day',status:'todo',execution:{reportedAt:'2026-11-09T17:00:00Z'}},{text:'No report',status:'todo'}];setList(h,[p]);
 h.api.openColumnMenu('updated');changeControl(h,'data-column-field','recorded');changeControl(h,'data-column-date','2026-11-09',{key:'from'});changeControl(h,'data-column-date','2026-11-09',{key:'to'});assert.ok(h.api.applyColumnMenu());
 assert.deepEqual(listRows(h),['Start boundary','End boundary']);
 h.api.openColumnMenu('updated');changeControl(h,'data-column-date','2026-11-10',{key:'from'});assert.equal(h.api.applyColumnMenu(),false);assert.match(h.ids.view.innerHTML,/From must be on or before To/);assert.equal(h.api.ui.taskDates.from,'2026-11-09');
 changeControl(h,'data-column-field','missing');assert.ok(h.api.applyColumnMenu());assert.deepEqual(listRows(h),['No report']);assert.equal(h.api.ui.taskDates.from,'');
 h.api.openColumnMenu('updated');h.api.handleViewAction(actionEvent('data-column-clear','updated'));assert.equal(listRows(h).length,4);
});

test('Group by Plan renders accurate counts and independently expands or collapses each repository plan',()=>{
 const h=harness(),a=plan('Implementing','Same'),b=plan('Implementing','Same');b.repo='second';setList(h,[a,b]);
 changeControl(h,'data-task-group','plan');assert.equal((h.ids.view.innerHTML.match(/class="task-group-heading"/g)||[]).length,2);assert.equal((h.ids.view.innerHTML.match(/2 tasks/g)||[]).length,2);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','workboard/Same'));assert.equal(h.api.ui.collapsedPlans['workboard/Same'],true);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,2);assert.match(h.ids.view.innerHTML,/aria-expanded="false"/);
 changeControl(h,'data-task-group','none');assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
 changeControl(h,'data-task-group','plan');assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,2);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','workboard/Same'));assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
});

test('Expand/collapse all affects visible filtered groups and Clear filters keeps grouping, collapse and sort',()=>{
 const h=harness(),a=plan('Implementing','Alpha'),b=plan('Implementing','Beta');setList(h,[a,b]);changeControl(h,'data-task-group','plan');h.api.ui.collapsedPlans['workboard/Beta']=true;
 h.api.ui.taskPlans=['workboard/Alpha'];h.api.ui.taskWork='Kiểm';h.api.sortTaskColumn('work','desc');
 h.api.handleViewAction(actionEvent('data-task-groups','collapse'));assert.equal(h.api.ui.collapsedPlans['workboard/Alpha'],true);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,0);
 h.api.handleViewAction(actionEvent('data-task-groups','expand'));assert.equal(h.api.ui.collapsedPlans['workboard/Alpha'],false);assert.equal(h.api.ui.collapsedPlans['workboard/Beta'],true);
 h.api.handleViewAction(actionEvent('data-clear-filters',''));assert.equal(h.api.ui.taskPlans,null);assert.equal(h.api.ui.taskWork,'');assert.equal(h.api.ui.taskGroup,'plan');assert.equal(h.api.ui.taskSort.direction,'desc');assert.equal(h.api.ui.collapsedPlans['workboard/Beta'],true);assert.match(h.ids.top.innerHTML,/4 of 4 tasks/);
});

test('Grouped task sorting stays within plans while Plan sort reverses the group order',()=>{
 const h=harness(),a=plan('Implementing','Alpha'),b=plan('Implementing','Beta');a.steps=[{text:'Z',status:'doing'},{text:'A',status:'doing'}];b.steps=[{text:'M',status:'doing'}];setList(h,[b,a]);changeControl(h,'data-task-group','plan');h.api.sortTaskColumn('work','asc');
 const groups=h.api.groupedTaskRows(h.api.filteredTaskRows(h.api.taskRows([a,b])));assert.deepEqual(Array.from(groups,g=>g.plan.name),['Alpha','Beta']);assert.deepEqual(Array.from(groups[0].rows,r=>r.s.text),['A','Z']);assert.match(h.ids.view.innerHTML,/within each plan/);
 h.api.sortTaskColumn('plan','desc');assert.ok(h.ids.view.innerHTML.indexOf('data-task-group-toggle="workboard/Beta"')<h.ids.view.innerHTML.indexOf('data-task-group-toggle="workboard/Alpha"'));
});

test('F5 preserves groups, collapsed plans, sort, applied header filters and an open unapplied menu draft',async()=>{
 const h=harness({layout:'list'}),p=plan();setList(h,[p]);changeControl(h,'data-task-group','plan');h.api.ui.taskPlans=['workboard/'+p.name];h.api.ui.collapsedPlans['workboard/'+p.name]=true;h.api.sortTaskColumn('updated','desc');h.api.openColumnMenu('work');changeControl(h,'data-column-field','unapplied text');
 h.context.fetch=async path=>{h.requests.push(path);return {ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([p])};};
 h.handlers.keydown({key:'F5',target:{tagName:'INPUT'},preventDefault(){}});await settle();
 assert.equal(h.api.ui.taskGroup,'plan');assert.equal(h.api.ui.collapsedPlans['workboard/'+p.name],true);assert.equal(h.api.ui.taskSort.column,'updated');assert.equal(h.api.ui.taskPlans.length,1);assert.equal(h.api.ui.taskWork,'');assert.equal(h.api.columnMenu.value,'unapplied text');assert.match(h.ids.view.innerHTML,/value="unapplied text"/);assert.deepEqual(h.requests,['/api/refresh','/api/state']);
});

test('Outside pointer closes a draft without rerendering the clicked control, and view preferences survive reopen',()=>{
 const h=harness({layout:'list',taskGroup:'plan',collapsedPlans:{'workboard/Alpha':true},taskSort:{column:'plan',direction:'desc'},taskPlans:['old'],taskWork:'old'});setList(h,[plan('Implementing','Alpha')]);
 assert.equal(h.api.ui.taskGroup,'plan');assert.equal(h.api.ui.collapsedPlans['workboard/Alpha'],true);assert.equal(h.api.ui.taskSort.direction,'desc');assert.equal(h.api.ui.taskPlans,null);assert.equal(h.api.ui.taskWork,'');
 h.api.openColumnMenu('plan');const before=h.ids.view.innerHTML;h.handlers.pointerdown({target:{closest(){return null;}}});assert.equal(h.api.columnMenu,null);assert.equal(h.ids.view.innerHTML,before);
});

function workloadRow(h,ps,agent){return h.api.viewSummary(ps).match(new RegExp('<button class="workload-row" data-agent-view="'+agent+'"[\\s\\S]*?</button>'))[0];}
test('Historical Codex work has visible nonzero plan and task counts even without active reports',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.executors=['Codex','Claude'];
 p.steps=[{status:'done',text:'Review',executors:['Codex'],executionHistory:{verifiedAt:'2026-11-07T12:00:00Z',summary:'Reviewed'}},{status:'done',text:'Shared fix',executors:['Codex','Claude'],executionHistory:{verifiedAt:'2026-11-07T12:00:00Z',summary:'Verified'}},{status:'todo',text:'Future work'}];
 p.milestones=[{id:'M1',steps:p.steps}];h.api.setData(data([p]));const before=JSON.stringify(p),row=workloadRow(h,[p],'Codex');
 assert.match(row,/1 plan · 2 tasks/);assert.match(row,/0 coordinating · 0 active tasks/);assert.match(row,/width:100%/);assert.doesNotMatch(row,/ disabled/);
 assert.match(workloadRow(h,[p],'Unknown'),/1 plan · 1 task/);assert.match(workloadRow(h,[p],'Claude'),/1 plan · 1 task/);
 h.api.ui.layout='summary';h.api.ui.taskWork='stale';h.api.ui.taskResult='stale';h.api.ui.taskPlans=[];
 h.api.handleViewAction(actionEvent('data-agent-view','Codex'));assert.match(h.ids.top.innerHTML,/2 of 3 tasks/);assert.match(h.ids.view.innerHTML,/Review/);assert.doesNotMatch(h.ids.view.innerHTML,/Future work/);assert.equal(JSON.stringify(p),before);assert.equal(h.requests.length,0);
});

test('Active workload counts tasks once per worker rather than counting their parent plan',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.executors=['Codex','Anti'];p.steps=[{text:'One',status:'doing',executors:['Codex','Anti'],execution:{activeAgents:['Codex','Anti']}},{text:'Two',status:'doing',executors:['Codex'],execution:{activeAgents:['Codex']}},{text:'Past',status:'done',executors:['Codex'],executionHistory:{verifiedAt:'2026-11-07T00:00:00Z',summary:'Done'}}];h.api.setData(data([p]));
 assert.match(workloadRow(h,[p],'Codex'),/1 plan · 3 tasks/);assert.match(workloadRow(h,[p],'Codex'),/0 coordinating · 2 active tasks/);
 assert.match(workloadRow(h,[p],'Anti'),/1 plan · 1 task/);assert.match(workloadRow(h,[p],'Anti'),/0 coordinating · 1 active task/);assert.match(workloadRow(h,[p],'Claude'),/1 coordinating · 0 active tasks/);
});

test('Workload drill-down retains the Summary plan scope and coordinator-only rows show their plans',()=>{
 const h=harness(),a=plan('Implementing','Alpha'),b=plan('Implementing','Beta');a.agent='Claude';b.agent='Claude';a.executors=b.executors=['Codex'];a.steps[0].executors=b.steps[0].executors=['Codex'];h.api.setData(data([a,b]));h.api.ui.layout='summary';h.api.ui.q='Alpha';h.api.render();
 h.api.handleViewAction(actionEvent('data-agent-view','Codex'));assert.match(h.ids.top.innerHTML,/1 of 4 tasks/);assert.deepEqual(Array.from(h.api.ui.taskPlans),['workboard/Alpha']);assert.doesNotMatch(h.ids.view.innerHTML,/data-open-task="workboard\/Beta"/);
 h.api.ui.layout='summary';h.api.ui.agent='all';h.api.ui.q='Alpha';h.api.render();h.api.handleViewAction(actionEvent('data-agent-view','Claude'));
 assert.equal(h.api.ui.agent,'all');assert.equal(h.api.ui.taskGroup,'plan');assert.match(h.ids.top.innerHTML,/2 of 4 tasks/);assert.match(h.ids.view.innerHTML,/data-task-group-toggle="workboard\/Alpha"/);assert.doesNotMatch(h.ids.view.innerHTML,/data-open-task="workboard\/Beta"/);
});

test('F5 refresh updates workload from historical contribution through active work and completion',async()=>{
 const h=harness({layout:'summary'}),p=plan();p.agent='Claude';p.executors=['Codex'];p.steps=[{text:'Prior work',status:'done',executors:['Codex'],executionHistory:{verifiedAt:'2026-11-07T12:00:00Z',summary:'Verified'}}];h.api.setData(data([p]));h.api.render();
 assert.match(h.ids.view.innerHTML,/1 plan · 1 task/);assert.match(workloadRow(h,[p],'Codex'),/0 active tasks/);
 let server=structuredClone(p);server.steps.push({text:'New work',status:'doing',executors:['Codex'],execution:{activeAgents:['Codex'],reportedAt:'2026-11-09T07:00:00Z',result:'Started'}});
 h.context.fetch=async path=>({ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([server])});
 await h.api.refresh();assert.match(h.ids.view.innerHTML,/1 plan · 2 tasks/);assert.match(workloadRow(h,[h.api.planByKey(p.repo+'/'+p.name)],'Codex'),/1 active task/);
 server=structuredClone(server);server.steps[1].status='done';server.steps[1].execution.activeAgents=[];await h.api.refresh();
 assert.match(workloadRow(h,[h.api.planByKey(p.repo+'/'+p.name)],'Codex'),/1 plan · 2 tasks/);assert.match(workloadRow(h,[h.api.planByKey(p.repo+'/'+p.name)],'Codex'),/0 active tasks/);assert.equal(h.api.ui.layout,'summary');assert.equal(p.steps.length,1);
});

test('Plan Activity omits repeated context names while keeping actual people and global plan context',()=>{
 const h=harness(),p=plan('Testing','Example-plan');p.owner=p.name;p.slot={id:'B',by:p.name};p.agent='Claude';p.decisions=[];p.questions=[];
 const j=data([p]);j.activity=[{repo:p.repo,plan:p.name,actor:p.name,agent:'Claude',kind:'done',text:'Checks passed',ts:new Date().toISOString()},{repo:p.repo,plan:p.name,actor:'Minh',kind:'decision',text:'Ship after review',ts:new Date().toISOString()}];h.api.setData(j);h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab='activity';h.api.render();
 assert.match(h.ids.top.innerHTML,/<h1>Example-plan<\/h1>/);assert.doesNotMatch(h.ids.top.innerHTML,/slot B · Example-plan|workboard · Example-plan/);
 assert.doesNotMatch(h.ids.view.innerHTML,/Example-plan/);assert.match(h.ids.view.innerHTML,/class="msg context-actor"/);assert.match(h.ids.view.innerHTML,/<b>Minh<\/b>/);assert.match(h.ids.view.innerHTML,/claude.svg/);assert.match(h.ids.view.innerHTML,/Checks passed/);
 assert.match(h.api.viewSummary([p]),/# Example-plan/);assert.equal(j.activity[0].actor,'Example-plan');
});

test('Starred plans are local persistent preferences scoped by repository and do not change execution data',()=>{
 const h=harness(),a=plan('Testing','Same'),b=plan('Testing','Same');b.repo='other';h.api.setData(data([a,b]));h.api.render();const before=JSON.stringify([a,b]),view=h.api.ui.view;
 h.api.handleViewAction(actionEvent('data-star-plan','workboard/Same'));assert.deepEqual(Array.from(h.api.navigation.starred),['workboard/Same']);assert.equal(h.api.ui.view,view);
 h.api.handleViewAction(actionEvent('data-plan-collection','starred'));assert.deepEqual(Array.from(h.api.sidebarPlans(),p=>p.repo),['workboard']);assert.match(h.ids['plan-sidebar'].innerHTML,/Unstar Same/);assert.doesNotMatch(h.ids['plan-sidebar'].innerHTML,/data-preview-plan="other\/Same"/);
 const re=harness({},JSON.parse(h.storage['wb-navigation']));re.api.setData(data([a,b]));re.api.render();assert.equal(re.api.navigation.section,'starred');assert.equal(re.api.navigation.starred.length,1);
 h.api.handleViewAction(actionEvent('data-star-plan','workboard/Same'));assert.match(h.ids['plan-sidebar'].innerHTML,/Star plans to keep them here/);assert.equal(h.api.navigation.starred.length,0);
 assert.equal(JSON.stringify([a,b]),before);assert.equal(h.requests.length,0);assert.ok(h.writes.includes('wb-navigation'));
});

test('Recent records deliberate plan opens, deduplicates them and ignores data refresh and tab switches',async()=>{
 const h=harness(),a=plan('Testing','Alpha'),b=plan('Testing','Beta');h.api.setData(data([a,b]));h.api.render();assert.equal(h.api.navigation.recent.length,0);
 h.api.openQuickPlan('workboard/Alpha');h.api.openQuickPlan('workboard/Beta');h.api.openQuickPlan('workboard/Alpha');assert.deepEqual(Array.from(h.api.navigation.recent,r=>r.key),['workboard/Alpha','workboard/Beta']);
 const recent=JSON.stringify(h.api.navigation.recent);h.api.handleViewAction(actionEvent('data-quick-tab','activity'));h.api.render();
 h.context.fetch=async()=>({ok:true,json:async()=>data([b,a])});await h.api.get();assert.equal(JSON.stringify(h.api.navigation.recent),recent);
 h.api.closeQuickPlan();h.api.handleViewAction(actionEvent('data-plan-collection','recent'));assert.deepEqual(Array.from(h.api.sidebarPlans(),p=>p.name),['Alpha','Beta']);
 h.api.ui.view='plan:workboard/Beta';h.api.render();assert.equal(h.api.navigation.recent[0].key,'workboard/Beta');const stamp=h.api.navigation.recent[0].openedAt;h.api.render();assert.equal(h.api.navigation.recent[0].openedAt,stamp);
});

test('Recent stays bounded and unavailable plans do not appear but retain their saved stars',()=>{
 const ps=Array.from({length:15},(_,i)=>plan('Testing','Plan '+i)),h=harness({}, {starred:['missing/old','missing/old'],recent:[{key:'bad',openedAt:'invalid'}],section:'recent',collapsed:true});h.api.setData(data(ps));
 for(const p of ps)h.api.recordPlanVisit(p.repo+'/'+p.name);assert.equal(h.api.navigation.recent.length,12);assert.equal(h.api.navigation.starred.length,1);
 h.api.render();assert.equal(h.ids['plan-sidebar'].hidden,true);assert.equal(h.ids['sidebar-toggle'].getAttribute('aria-expanded'),'false');h.api.handleViewAction(actionEvent('data-sidebar-toggle',''));assert.equal(h.ids['plan-sidebar'].hidden,false);
 h.api.handleViewAction(actionEvent('data-plan-collection','starred'));assert.equal(h.api.sidebarPlans().length,0);assert.deepEqual(Array.from(h.api.navigation.starred),['missing/old']);
});

test('Quick view preserves the background view, filters and scroll and provides read-only overview tabs',()=>{
 const h=harness({layout:'list'}),p=plan();p.agent='Claude';p.executors=['Codex'];h.api.setData(data([p]));h.api.ui.q='search';h.api.ui.agent='Codex';h.api.ui.taskGroup='plan';h.api.ui.taskPlans=[p.repo+'/'+p.name];h.api.render();
 h.ids.view.scrollTop=210;h.ids.view.scrollLeft=140;h.ids.q.focus();const ui=JSON.stringify(h.api.ui),html=h.ids.view.innerHTML;
 h.api.handleViewAction(actionEvent('data-preview-plan',p.repo+'/'+p.name));assert.equal(h.ids['quick-plan'].open,true);assert.equal(h.api.ui.view,'home');assert.equal(JSON.stringify(h.api.ui),ui);assert.equal(h.ids.view.innerHTML,html);
 assert.match(h.ids['quick-plan-content'].innerHTML,/Goal/);assert.match(h.ids['quick-plan-content'].innerHTML,/Next/);assert.match(h.ids['quick-plan-content'].innerHTML,/Coordinator/);assert.match(h.ids['quick-plan-content'].innerHTML,/codex.png/);assert.doesNotMatch(h.ids['quick-plan-content'].innerHTML,/data-status=|data-agent=|data-executor=/);
 h.api.closeQuickPlan();assert.equal(h.ids['quick-plan'].open,false);assert.equal(h.context.document.activeElement,h.ids.q);assert.equal(h.ids.view.scrollTop,210);assert.equal(h.ids.view.scrollLeft,140);assert.equal(h.requests.length,0);
});

test('Quick Checklist renders flat source tasks once, shows evidence and opens the exact full task',()=>{
 const h=harness(),p=plan();p.steps[0].line=5;p.steps[0].executors=['Codex'];p.steps[0].executionHistory={summary:'Verified <result>',verifiedAt:'2026-11-07T12:00:00Z'};p.milestones=[{id:'M1',title:'Delivery',steps:p.steps}];h.api.setData(data([p]));h.api.openQuickPlan(p.repo+'/'+p.name);h.api.handleViewAction(actionEvent('data-quick-tab','checklist'));
 assert.equal((h.ids['quick-plan-content'].innerHTML.match(/data-open-task=/g)||[]).length,2);assert.match(h.ids['quick-plan-content'].innerHTML,/Verified &lt;result&gt;/);assert.match(h.ids['quick-plan-content'].innerHTML,/Verified history/);assert.doesNotMatch(h.ids['quick-plan-content'].innerHTML,/id="task-line-/);
 h.api.handleViewAction(actionEvent('data-open-task',p.repo+'/'+p.name,{'data-task-index':'0','data-task-revision':p.revision}));assert.equal(h.ids['quick-plan'].open,false);assert.equal(h.api.focusedTask(p).line,5);assert.equal(h.api.ui.view,'plan:'+p.repo+'/'+p.name);
});

test('Quick Activity ignores background search, avoids repeated plan names and remains escaped',()=>{
 const h=harness(),p=plan('Testing','Example');p.decisions=[];p.questions=[];const j=data([p]);j.activity=[{repo:p.repo,plan:p.name,actor:p.name,agent:'Claude',kind:'done',text:'Actual <script> update',ts:new Date().toISOString()}];h.api.setData(j);h.api.ui.q='unrelated background query';h.api.openQuickPlan('workboard/Example');h.api.handleViewAction(actionEvent('data-quick-tab','activity'));
 assert.match(h.ids['quick-plan-content'].innerHTML,/Actual &lt;script&gt; update/);assert.doesNotMatch(h.ids['quick-plan-content'].innerHTML,/<b>Example<\/b>|<script>/);assert.equal(h.api.ui.q,'unrelated background query');assert.equal(h.requests.length,0);
});

test('Quick tabs support keyboard navigation, Escape and native cancellation without leaving the background plan',()=>{
 const h=harness(),a=plan('Testing','Alpha'),b=plan('Testing','Beta');h.api.setData(data([a,b]));h.api.ui.view='plan:workboard/Alpha';h.api.render();h.ids.q.focus();h.api.openQuickPlan('workboard/Beta');
 const ev=actionEvent('data-quick-tab','overview');ev.key='ArrowRight';ev.preventDefault=()=>{};h.handlers.keydown(ev);assert.equal(h.api.quick.tab,'checklist');assert.equal(h.context.document.activeElement,h.ids['quick-tab-checklist']);
 ev.key='End';h.handlers.keydown(ev);assert.equal(h.api.quick.tab,'activity');ev.key='Home';h.handlers.keydown(ev);assert.equal(h.api.quick.tab,'overview');
 h.handlers.keydown({key:'Escape',target:{tagName:'BUTTON'},preventDefault(){}});assert.equal(h.api.quick.key,null);assert.equal(h.api.ui.view,'plan:workboard/Alpha');assert.equal(h.context.document.activeElement,h.ids.q);
 h.api.openQuickPlan('workboard/Beta');h.ids['quick-plan'].listeners.cancel({preventDefault(){}});assert.equal(h.api.quick.key,null);assert.equal(h.ids['quick-plan'].open,false);
});

test('Quick next/previous uses the selected collection and Open full plan is explicit',()=>{
 const h=harness(),a=plan('Testing','Alpha'),b=plan('Testing','Beta'),c=plan('Testing','Other');h.api.setData(data([a,b,c]));h.api.navigation.starred=['workboard/Alpha','workboard/Beta'];h.api.navigation.section='starred';h.api.openQuickPlan('workboard/Alpha');
 h.api.handleViewAction(actionEvent('data-quick-step','1'));assert.equal(h.api.quick.key,'workboard/Beta');assert.equal(h.api.ui.view,'home');
 h.handlers.keydown({key:'ArrowUp',altKey:true,target:{tagName:'BUTTON'},preventDefault(){}});assert.equal(h.api.quick.key,'workboard/Alpha');
 h.api.handleViewAction(actionEvent('data-quick-full',''));assert.equal(h.api.quick.key,null);assert.equal(h.api.ui.view,'plan:workboard/Alpha');assert.equal(h.api.ui.tab,'summary');
});

test('F5 updates the open quick tab and preserves stars, Recent, background filters and modal scroll',async()=>{
 const h=harness({layout:'list'}),p=plan();h.api.setData(data([p]));h.api.ui.q='missing';h.api.ui.taskGroup='plan';h.api.togglePlanStar(p.repo+'/'+p.name);h.api.openQuickPlan(p.repo+'/'+p.name);h.api.handleViewAction(actionEvent('data-quick-tab','checklist'));h.ids['quick-plan-scroll'].scrollTop=160;
 const nav=JSON.stringify(h.api.navigation),ui=JSON.stringify(h.api.ui),server=structuredClone(p);server.steps[0].text='New reported result';server.steps[0].status='done';
 h.context.fetch=async path=>({ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([server])});await h.api.refresh();
 assert.match(h.ids['quick-plan-content'].innerHTML,/New reported result/);assert.equal(h.api.quick.tab,'checklist');assert.equal(h.ids['quick-plan'].open,true);assert.equal(h.ids['quick-plan-scroll'].scrollTop,160);assert.equal(JSON.stringify(h.api.navigation),nav);assert.equal(JSON.stringify(h.api.ui),ui);assert.equal(h.ids['quick-refresh'].disabled,false);
});

test('Quick refresh failures expose their reason, and disappearing plans remain closable',async()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));h.api.openQuickPlan(p.repo+'/'+p.name);h.context.fetch=async()=>({ok:false,status:502,json:async()=>({error:'Collector unavailable'})});await h.api.refresh();
 assert.equal(h.ids['quick-error'].hidden,false);assert.equal(h.ids['quick-error'].textContent,'Collector unavailable');assert.equal(h.ids['quick-refresh'].disabled,false);
 h.api.setData(data([]));h.api.render();assert.match(h.ids['quick-plan-content'].innerHTML,/Plan unavailable/);assert.equal(h.ids['quick-plan'].open,true);h.api.handleViewAction(actionEvent('data-quick-close',''));assert.equal(h.ids['quick-plan'].open,false);
});

test('Quick navigation keeps a stable Recent sequence and selected tab while opened times change',()=>{
 const h=harness(),ps=['Alpha','Beta','Gamma'].map(n=>plan('Testing',n));h.api.setData(data(ps));
 for(const p of ps.slice().reverse())h.api.recordPlanVisit(p.repo+'/'+p.name);h.api.navigation.section='recent';h.api.openQuickPlan('workboard/Alpha');h.api.handleViewAction(actionEvent('data-quick-tab','checklist'));
 h.api.stepQuickPlan(1);assert.equal(h.api.quick.key,'workboard/Beta');assert.equal(h.api.quick.tab,'checklist');assert.equal(h.api.navigation.recent[0].key,'workboard/Beta');
 h.api.stepQuickPlan(1);assert.equal(h.api.quick.key,'workboard/Gamma');h.api.stepQuickPlan(1);assert.equal(h.api.quick.key,'workboard/Alpha');assert.equal(h.api.quick.tab,'checklist');
 h.api.stepQuickPlan(NaN);assert.equal(h.api.quick.key,'workboard/Alpha');
});

function disclosureTag(html,cls){return html.match(new RegExp('<details class="'+cls+'"[^>]*>'))?.[0] || '';}
function toggleDisclosure(h,tag,open){const key=tag.match(/data-plan-disclosure="([^"]+)"/)[1];h.handlers.toggle({target:{open,getAttribute(name){return name==='data-plan-disclosure'?key:name==='data-disclosure-auto' && tag.includes('data-disclosure-auto')?'1':null;}}});return key;}
function focusPlan(){
 const p=plan('Shipping','Focus');p.agent='Codex';p.executors=['Codex'];p.questions=[];p.decisions=[];p.goal='Candidates can read the public job details.';p.next='Verify the deployed public page.';
 p.steps=[{text:'Release the corrected public page',status:'doing',line:10,milestone:'M2',executors:['Codex'],execution:{activeAgents:['Codex'],reportedAt:'2026-11-09T07:00:00Z',result:'RPC applied; waiting for frontend deployment.'}},{text:'Review the corrected behavior',status:'done',line:11,milestone:'M2',executors:['Codex']},{text:'Find the missing job data',status:'done',line:5,milestone:'M1'},{text:'Connect public job details',status:'done',line:6,milestone:'M1'}];
 p.milestones=[{id:'M1',title:'Job content',state:'done',steps:p.steps.slice(2)},{id:'M2',title:'Release and verify',state:'doing',summary:'RPC applied; waiting for frontend deployment.',steps:p.steps.slice(0,2)}];return p;
}

test('Plan Summary prioritizes one next action without repeating goal, active task, progress or identical agent roles',()=>{
 const h=harness(),p=focusPlan();h.api.setData(data([p]));h.handlers.click(actionEvent('data-go','plan:workboard/Focus'));
 assert.equal(h.api.ui.tab,'summary');assert.match(h.ids.view.innerHTML,/class="plan-insight" aria-label="Next action"/);assert.match(h.ids.view.innerHTML,/Verify the deployed public page/);assert.match(h.ids.view.innerHTML,/Candidates can read the public job details/);
 const visible=h.ids.view.innerHTML.split('<details class="plan-completed"')[0];assert.doesNotMatch(visible,/Release the corrected public page|Review the corrected behavior|RPC applied/);assert.doesNotMatch(h.ids.top.innerHTML,/Candidates can read|Verify the deployed|class="pipe"|75%|3\/4/);
 assert.equal((h.ids.top.innerHTML.match(/codex.png/g)||[]).length,1);assert.match(h.ids.top.innerHTML,/>Agent</);assert.doesNotMatch(h.ids.top.innerHTML,/>Coordinator<|>Executed by</);
 assert.ok(disclosureTag(h.ids.view.innerHTML,'plan-completed'));assert.doesNotMatch(disclosureTag(h.ids.view.innerHTML,'plan-completed'),/\sopen[\s>]/);assert.match(h.ids.view.innerHTML,/completed-count">3/);
 h.api.handleViewAction(actionEvent('data-plan-section','checklist',{'data-section-plan':'workboard/Focus'}));assert.equal(h.api.ui.tab,'checklist');assert.match(h.ids.view.innerHTML,/Release the corrected public page/);assert.doesNotMatch(h.ids.view.innerHTML,/Verify the deployed public page/);
});

test('Work separates completed children from active milestones and renders every source task exactly once',()=>{
 const h=harness(),p=focusPlan();h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.ui.tab='checklist';h.api.render();
 const [active,done]=h.ids.view.innerHTML.split('<details class="plan-completed"');assert.match(active,/Release the corrected public page/);assert.doesNotMatch(active,/Review the corrected behavior|Find the missing job data|Job content/);assert.match(done,/Review the corrected behavior/);assert.match(done,/Job content/);
 for(const line of [5,6,10,11])assert.equal((h.ids.view.innerHTML.match(new RegExp('id="task-line-'+line+'"','g'))||[]).length,1);
 assert.doesNotMatch(active,/Milestone notes/);assert.equal((h.ids.view.innerHTML.match(/RPC applied; waiting for frontend deployment\./g)||[]).length,1);
 assert.doesNotMatch(disclosureTag(active,'report-disclosure'),/\sopen[\s>]/);assert.match(active,/Latest report/);
});

test('An explicitly done task link opens its collapsed completion group and focuses the same source row',()=>{
 const h=harness(),p=focusPlan();h.api.setData(data([p]));h.api.render();
 let focused=false;h.ids['task-line-5']={focus(){focused=true;},scrollIntoView(){}};
 h.api.handleViewAction(actionEvent('data-open-task','workboard/Focus',{'data-task-index':'2','data-task-revision':p.revision}));
 assert.equal(h.api.ui.tab,'checklist');assert.equal(h.api.focusedTask(p).line,5);assert.match(disclosureTag(h.ids.view.innerHTML,'plan-completed'),/\sopen[\s>]/);assert.ok(focused);
});

test('Completion/report disclosure preferences survive F5 and remain separate between full and quick view',async()=>{
 const h=harness(),p=focusPlan();h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.ui.tab='checklist';h.api.render();
 const completed=toggleDisclosure(h,disclosureTag(h.ids.view.innerHTML,'plan-completed'),true),report=toggleDisclosure(h,disclosureTag(h.ids.view.innerHTML,'report-disclosure'),true);h.api.render();
 assert.match(disclosureTag(h.ids.view.innerHTML,'plan-completed'),/\sopen[\s>]/);assert.match(disclosureTag(h.ids.view.innerHTML,'report-disclosure'),/\sopen[\s>]/);
 h.context.fetch=async path=>({ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([p])});await h.api.refresh();assert.equal(h.api.ui.planDetails[completed],true);assert.equal(h.api.ui.planDetails[report],true);
 h.api.openQuickPlan('workboard/Focus');assert.doesNotMatch(disclosureTag(h.ids['quick-plan-content'].innerHTML,'plan-completed'),/\sopen[\s>]/);
 h.api.closeQuickPlan();toggleDisclosure(h,disclosureTag(h.ids.view.innerHTML,'plan-completed'),false);h.api.render();assert.doesNotMatch(disclosureTag(h.ids.view.innerHTML,'plan-completed'),/\sopen[\s>]/);
});

test('Task search opens matching completed reports temporarily without changing collapse preferences',()=>{
 const h=harness(),p=focusPlan();p.steps[2].executionHistory={summary:'Rollback verified with no data changes',verifiedAt:'2026-11-08T07:00:00Z'};h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.ui.tab='checklist';h.api.ui.q='Rollback';h.api.render();
 const completed=disclosureTag(h.ids.view.innerHTML,'plan-completed'),report=disclosureTag(h.ids.view.innerHTML,'report-disclosure');assert.match(completed,/data-disclosure-auto="1" open/);assert.match(report,/data-disclosure-auto="1" open/);assert.match(h.ids.view.innerHTML,/Find the missing job data/);assert.doesNotMatch(h.ids.view.innerHTML,/Connect public job details/);
 toggleDisclosure(h,completed,true);toggleDisclosure(h,report,true);assert.equal(Object.keys(h.api.ui.planDetails).length,0);
 h.api.ui.q='';h.api.render();assert.doesNotMatch(disclosureTag(h.ids.view.innerHTML,'plan-completed'),/\sopen[\s>]/);
});

test('Identical text is displayed once while similar but conflicting source statements are preserved',()=>{
 const h=harness(),p=focusPlan();p.goal=p.next='Wait for the final public-page verification.';h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.render();assert.equal((h.ids.view.innerHTML.match(/Wait for the final public-page verification\./g)||[]).length,1);
 p.goal='The frontend has not shipped.';p.next='The frontend has shipped.';h.api.render();assert.match(h.ids.view.innerHTML,/The frontend has not shipped/);assert.match(h.ids.view.innerHTML,/The frontend has shipped/);
});

test('Blocked reasons and open questions remain prominent; completed plans keep a quiet recorded next step',()=>{
 const h=harness(),p=focusPlan();p.status='Blocked - Waiting for a confirmed permission decision';p.questions=[{ask:'Which department can approve this step?',open:true}];h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.render();assert.match(h.ids.view.innerHTML,/plan-insight is-blocked/);assert.match(h.ids.view.innerHTML,/Waiting for a confirmed permission decision/);assert.match(h.ids.view.innerHTML,/Needs your decision/);
 p.status='Done';p.questions=[];for(const s of p.steps)s.status='done';h.api.render();assert.match(h.ids.view.innerHTML,/plan-insight is-recorded/);assert.match(h.ids.view.innerHTML,/No open checklist tasks/);assert.doesNotMatch(disclosureTag(h.ids.view.innerHTML,'plan-completed'),/\sopen[\s>]/);
});

test('A milestone marked done cannot hide source tasks that are still open',()=>{
 const h=harness(),p=focusPlan();p.milestones[1].state='done';h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.ui.tab='checklist';h.api.render();assert.match(h.ids.view.innerHTML.split('<details class="plan-completed"')[0],/Release the corrected public page/);assert.equal(p.steps[0].status,'doing');
});

test('Every plan stage has the same semantic color in the selector, badge and sidebar',()=>{
 const h=harness();for(const [stage,tone]of [['Planning','todo'],['Implementing','doing'],['Shipping','doing'],['Reviewing','review'],['Fixing review','review'],['Testing','review'],['Waiting for CI','waiting'],['Waiting for owner','waiting'],['Blocked','blocked'],['Done','done']]){
  const p=focusPlan();p.status=stage;h.api.setData(data([p]));h.api.render();assert.match(h.api.statusSelect(p),new RegExp('class="status-select status-'+tone+'"'));assert.match(h.api.taskCard(p),new RegExp('class="pill status-'+tone+'"'));assert.match(h.ids['plan-sidebar'].innerHTML,new RegExp('plan-state-dot status-'+tone));
 }
 for(const [tone,token]of [['done','success'],['doing','information'],['review','discovery'],['waiting','warning'],['blocked','danger']])assert.ok(html.includes('.status-'+tone+'{--status-fg:var(--ds-text-'+token+')'));
});

test('Delegated and missing executor roles stay explicit instead of collapsing into an assumed single agent',()=>{
 const h=harness(),p=focusPlan();p.agent='Claude';p.executors=['Codex','Anti'];h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.render();assert.match(h.ids.top.innerHTML,/>Coordinator</);assert.match(h.ids.top.innerHTML,/>Executed by</);assert.match(h.ids.top.innerHTML,/>Multi</);
 p.agent='Codex';p.executors=null;h.api.render();assert.match(h.ids.top.innerHTML,/>Coordinator</);assert.match(h.ids.top.innerHTML,/Not reported/);assert.doesNotMatch(h.ids.top.innerHTML,/>Agent</);
});

test('The status selector changes semantic color immediately and retains the confirmed server stage',async()=>{
 const h=harness(),p=focusPlan();h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.render();let release;const server={...p,status:'Done'};
 h.context.fetch=path=>path==='/api/plans/status'?new Promise(resolve=>release=resolve):Promise.resolve({ok:true,json:async()=>data([server])});
 const control={value:'Done',className:'status-select status-doing',getAttribute(){return 'workboard/Focus';},closest(s){return s==='[data-status]'?this:null;}};
 h.handlers.change({target:control});assert.equal(control.className,'status-select status-done');assert.equal(control.disabled,true);release({ok:true,json:async()=>({saved:true})});await settle();
 assert.match(h.ids.top.innerHTML,/class="status-select status-done"/);assert.equal(control.disabled,false);assert.deepEqual(server.steps,p.steps);
 h.context.fetch=async path=>path==='/api/plans/status'?{ok:false,status:409,json:async()=>({error:'Concurrent stage change'})}:{ok:true,json:async()=>data([{...p,status:'Testing'}])};
 control.value='Blocked';h.handlers.change({target:control});assert.equal(control.className,'status-select status-blocked');await settle();assert.match(h.ids.top.innerHTML,/class="status-select status-review"/);assert.match(h.ids.error.textContent,/Concurrent stage change/);
});

test('A mixed milestone displays its technical notes once when split into open and completed work',()=>{
 const h=harness(),p=focusPlan();p.milestones[1].summary='Unique recorded milestone evidence';h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.ui.tab='checklist';h.api.render();
 assert.equal((h.ids.view.innerHTML.match(/Unique recorded milestone evidence/g)||[]).length,1);const ids=Array.from(h.ids.view.innerHTML.matchAll(/\bid="([^"]+)"/g),m=>m[1]);assert.equal(ids.length,new Set(ids).size);assert.ok(h.ids.view.innerHTML.indexOf('Unique recorded milestone evidence')<h.ids.view.innerHTML.indexOf('<details class="plan-completed"'));
});
