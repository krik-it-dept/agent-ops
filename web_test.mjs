import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(saved={},nav={},stored={}){
 const ids={}, handlers={}, timers=[], requests=[], streams=[],storage={'wb-ui':JSON.stringify(saved),'wb-navigation':JSON.stringify(nav),...stored},writes=[];let context;
 function element(id){return {id,innerHTML:'',textContent:'',className:'',hidden:false,isConnected:true,scrollTop:0,value:'',selectionStart:0,selectionEnd:0,attributes:{},listeners:{},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},showModal(){this.open=true;},close(){this.open=false;},addEventListener(name,fn){this.listeners[name]=fn;},focus(){context.document.activeElement=this;},select(){this.selectionStart=0;this.selectionEnd=this.value.length;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}};}
 ['view','top','tabs','nav','q','refresh','upd','error','live','connection','save-state','plan-sidebar','sidebar-toggle','quick-plan','quick-plan-content','quick-plan-scroll','quick-close','quick-tab-overview','quick-tab-checklist','quick-tab-activity','quick-star','quick-refresh','quick-full','quick-error','update-card','update-segment','update-dismiss','update-minimize','update-retry','update-apply','update-skip','app-version','status-totals','error-raw','error-details','settings-check-updates','setup-keep','setup-skip-confirm','setup-choose','onboarding-card','settings-add','settings-nav-add','error-text','error-detail','error-retry','warnings','onboarding','settings','settings-open','settings-search','settings-main','settings-close','settings-choose','settings-path','setup-path','setup-next','setup-finish','setup-back','setup-skip'].forEach(id=>ids[id]=element(id));
 context=vm.createContext({console,Date,URL,encodeURI,encodeURIComponent,decodeURIComponent,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(i){timers[i-1]=null;},setInterval(){},location:{hash:''},localStorage:{getItem(key){return storage[key] || null;},setItem(k,v){storage[k]=v;writes.push(k);}},window:{addEventListener(name,fn){handlers[name]=fn;}},document:{querySelectorAll(){return [];},activeElement:null,documentElement:{attributes:{},setAttribute(k,v){this.attributes[k]=v;}},getElementById(id){return ids[id];},addEventListener(name,fn){handlers[name]=fn;}},fetch(path){requests.push(path);return Promise.resolve({ok:true,json:async()=>data([])});},EventSource:class{constructor(){streams.push(this);}}});
 const instrumented=source.replace('jumpHash(); get(); connect(); initUpdates(); loadSettings();',`globalThis.api={updateUI,receiveUpdate,updateAction,showUpdateCard,dismissUpdateCard,renderUpdate,updateCardKind,applyTheme,shortcutsOn,setupGo,openSetup,errorUI,pollUpdates,initUpdates,navigation,quick,renderSidebar,sidebarPlans,openQuickPlan,closeQuickPlan,stepQuickPlan,togglePlanStar,recordPlanVisit,quickChecklist,taskRows,filteredTaskRows,taskAgentMatches,focusedTask,refresh,stepExecution,executorBadges, agentChain, agentMatches, executorValue, agentName, agentBadge, viewList, viewTimeline, viewSummary, timelineEntries, dateKey, monthDays, handleViewAction, moveStatus, statusSelect, planByKey, render, columnOf, owner, needsAttention, feedFor, orderedMilestones, stepsHTML, taskCard, prs, jumpHash, connection, showError, connect, get, openColumnMenu,applyColumnMenu,sortTaskColumn,groupedTaskRows,setTaskGroups,columnInput,get columnMenu(){return columnMenu;},setData(j){D=j;}, ui, setup, settingsUI, renderSetup, renderSettings, openSettings, closeSettings, loadSettings, addProject, chooseFolder, removeProject, toggleProject, saveSetting, finishSetup, handleSettingsAction, settingsInput, settingsChange, settingsKey, showWarnings, syncSetup, key, repoLabel, viewHome, get settingsData(){return settingsData;}, set settingsData(v){settingsData=v;}};`);
 vm.runInContext(instrumented,context);
 return {api:context.api,ids,context,handlers,requests,streams,storage,writes,flush(){timers.splice(0).forEach(fn=>fn&&fn());}};
}
function plan(status='Implementing',name='Cải thiện tìm kiếm'){return {repo:'workboard',name,owner:'Minh',revision:'a'.repeat(64),status,tone:'doing',step:1,mtime:new Date().toISOString(),gh:'https://github.com/krik/workboard',root:'C:/sample',goal:'Gọn hơn #12',spec:'plan.md',next:'Kiểm tra kết quả #12',slot:null,steps:[{status:'doing',text:'Kiểm tra tìm kiếm'},{status:'todo',text:'Xác minh #12'}],milestones:[],decisions:[{key:'202611090900',when:'09/11 09:00',text:'Giữ tiếng Việt'}],questions:[{key:'202611090930',when:'09/11 09:30',ask:'Chốt giao diện?',answer:'',open:true}]};}
function data(plans){return {state:{plans,slots:{}},activity:[],stale:{},now:new Date().toISOString(),error:''};}
const hit=(selector,attrs={})=>({closest(s){return s===selector?{getAttribute(name){return attrs[name] ?? null;}}:null;}});

test('Every app logo uses the theme pair and both favicons are bundled RGBA PNGs',()=>{
 for(const theme of ['light','dark']){
  const png=readFileSync(new URL('./web/icons/app-'+theme+'.png',import.meta.url));
  assert.equal(png.subarray(1,4).toString(),'PNG');
  assert.equal(png.readUInt32BE(16),256);assert.equal(png.readUInt32BE(20),256);
  assert.equal(png[25],6,'RGBA PNG');
  assert.match(html,new RegExp('<link rel="icon"[^>]+href="/icons/app-'+theme+'\\.png[^>]+media="\\(prefers-color-scheme: '+theme+'\\)"'));
 }
 assert.doesNotMatch(html,/src="\/icons\/app\.png"/,'tile is reserved for native surfaces');
 assert.match(html,/:root\[data-theme="dark"\] \.app-logo-light \{ display: none; \}/);
 assert.match(html,/:root\[data-theme="dark"\] \.app-logo-dark \{ display: block; \}/);
 assert.match(html,/:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \.app-logo-dark \{ display: block; \}/);
 const h=harness();h.api.settingsData=settingsPayload([]);h.api.setData({...data([]),projects:[],setupRequired:false});
 const paired=markup=>{
  assert.match(markup,/class="app-logo-light" src="\/icons\/app-light\.png"/);
  assert.match(markup,/class="app-logo-dark" src="\/icons\/app-dark\.png"/);
 };
 h.api.openSetup();paired(h.ids.onboarding.innerHTML);
 h.api.setup.open=false;h.api.openSettings('about');paired(h.ids.settings.innerHTML);
 h.api.closeSettings();h.api.render();paired(h.ids.view.innerHTML);
 for(const theme of ['light','dark','system']){
  h.api.applyTheme(theme);assert.equal(h.context.document.documentElement.attributes['data-theme'],theme);
 }
});
test('An available update shows a non-modal card and status-bar item without moving focus or the task view',()=>{
 const h=harness(),p=plan();setList(h,[p]);h.api.ui.taskStatus='blocked';h.api.ui.taskGroup='plan';h.ids.view.scrollTop=123;h.ids.q.focus();
 const before=JSON.stringify(h.api.ui);
 h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.3',available:true,phase:'available',notes:'Fixed grouping <script>unsafe</script>'});
 const card=h.ids['update-card'];
 assert.equal(card.hidden,false);assert.equal(h.api.updateCardKind(),'available');assert.equal(h.context.document.activeElement,h.ids.q,'the card never takes focus');
 assert.match(card.innerHTML,/Update available/);assert.match(card.innerHTML,/Agent Ops v0.1.3 is ready/);
 assert.match(card.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(card.innerHTML,/<script>/);
 assert.match(card.innerHTML,/Update and restart/);assert.match(card.innerHTML,/Skip this version/);assert.match(card.innerHTML,/aria-label="Dismiss"/);
 assert.equal((card.innerHTML.match(/data-update-action="apply"/g) || []).length,1,'one update button');
 assert.equal(h.ids['update-segment'].hidden,false);assert.match(h.ids['update-segment'].innerHTML,/Update available/);assert.equal(h.ids['app-version'].textContent,'v0.1.2');
 assert.equal(JSON.stringify(h.api.ui),before);assert.equal(h.ids.view.scrollTop,123);
 h.handlers.click({target:hit('[data-update-dismiss]')});assert.equal(card.hidden,true);assert.equal(JSON.parse(h.storage['wb-update']).dismissed,'v0.1.3');
 assert.equal(h.ids['update-segment'].hidden,false,'the status-bar item stays after dismissing');
 h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.3',available:true,phase:'available'});assert.equal(card.hidden,true,'a dismissed version does not reopen');
 const fresh=harness({},{},{'wb-update':h.storage['wb-update']});fresh.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.3',available:true,phase:'available'});assert.equal(fresh.ids['update-card'].hidden,true,'dismissal survives a reload');
 fresh.handlers.click({target:hit('[data-update-segment]')});assert.equal(fresh.ids['update-card'].hidden,false,'the status-bar item reopens the card');
 h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.4',available:true,phase:'available'});assert.equal(card.hidden,false,'a newer version shows again');
 h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.5',available:true,skipped:true,phase:'available'});assert.equal(h.ids['update-segment'].hidden,true);
});

test('Skip sends the selected release with CSRF protection; an apply cannot be sent twice and only minimizes',async()=>{
 const h=harness(),calls=[];h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.3',available:true,phase:'available'});
 h.context.fetch=async(path,options)=>{calls.push([path,options]);return {ok:true,json:async()=>({current:'v0.1.2',latest:'v0.1.3',available:true,skipped:true,phase:'available'})};};
 await h.api.updateAction('skip');assert.equal(calls[0][0],'/api/updates/skip');assert.equal(calls[0][1].headers['X-Workboard'],'1');assert.equal(JSON.parse(calls[0][1].body).version,'v0.1.3');assert.equal(h.ids['update-card'].hidden,true);
 h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.4',available:true,phase:'available'});
 let finish;h.context.fetch=(path,options)=>{calls.push([path,options]);return new Promise(res=>finish=res);};
 const pending=h.api.updateAction('apply');h.api.dismissUpdateCard();assert.equal(h.api.updateCardKind(),'progress','an update in progress cannot be dismissed');
 await h.api.updateAction('apply');assert.equal(calls.length,2);
 finish({ok:true,json:async()=>({current:'v0.1.2',latest:'v0.1.4',available:true,phase:'installing'})});await pending;
 assert.match(h.ids['update-card'].innerHTML,/Updating to v0.1.4/);assert.match(h.ids['update-card'].innerHTML,/Installing… the page reloads by itself/);assert.doesNotMatch(h.ids['update-card'].innerHTML,/data-update-dismiss/);
 assert.match(h.ids['update-segment'].innerHTML,/Restarting…/);
 h.handlers.click({target:hit('[data-update-minimize]')});assert.equal(h.ids['update-card'].hidden,true);
 h.handlers.click({target:hit('[data-update-segment]')});assert.equal(h.ids['update-card'].hidden,false);
 h.api.receiveUpdate({current:'v0.1.2',phase:'error',error:'Previous version restored.'});assert.match(h.ids['update-segment'].innerHTML,/Update failed/);
});

test('App version change reloads once and the new page restores plan filters, grouping and scroll',async()=>{
 const h=harness(),p=plan();let reloads=0;h.context.location.reload=()=>reloads++;
 h.api.setData({...data([p]),appVersion:'v0.1.2'});h.api.ui.layout='list';h.api.ui.taskStatus='blocked';h.api.ui.taskGroup='plan';h.api.ui.collapsedPlans={['workboard/'+p.name]:true};
 h.ids.view.scrollTop=223;h.ids.view.scrollLeft=40;
 h.context.fetch=async()=>({ok:true,json:async()=>({...data([p]),appVersion:'v0.1.3'})});await h.api.get();assert.equal(reloads,1);
 const saved=JSON.parse(h.storage['wb-update-view']);assert.equal(saved.version,'v0.1.3');assert.equal(saved.ui.taskStatus,'blocked');
 const fresh=harness();fresh.storage['wb-update-view']=h.storage['wb-update-view'];fresh.context.fetch=h.context.fetch;await fresh.api.get();
 assert.equal(fresh.api.ui.layout,'list');assert.equal(fresh.api.ui.taskStatus,'blocked');assert.equal(fresh.api.ui.taskGroup,'plan');assert.equal(fresh.api.ui.collapsedPlans['workboard/'+p.name],true);
 assert.equal(fresh.ids.view.scrollTop,223);assert.equal(fresh.ids.view.scrollLeft,40);assert.deepEqual(JSON.parse(fresh.storage['wb-update-view']),{});
});

test('Check failures and rollback errors stay visible and a disconnect during installation is expected',async()=>{
 const h=harness();h.api.showUpdateCard();h.context.fetch=async()=>{throw Error('GitHub unreachable');};await h.api.pollUpdates();assert.match(h.ids['update-card'].innerHTML,/GitHub unreachable/);assert.match(h.ids['update-card'].innerHTML,/Re-check/);
 h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.3',available:true,phase:'installing'});await h.api.pollUpdates();assert.equal(h.api.updateUI.state.error,undefined);
 h.api.receiveUpdate({current:'v0.1.2',phase:'error',error:'Previous version restored.'});assert.equal(h.ids['update-card'].hidden,false);assert.match(h.ids['update-card'].innerHTML,/Previous version restored/);
 const quiet=harness();quiet.api.receiveUpdate({current:'v0.1.2',phase:'error',error:'Could not check the private GitHub release.'});
 assert.equal(quiet.ids['update-card'].hidden,true,'a background failure never opens the card');assert.match(quiet.ids['update-segment'].innerHTML,/Update failed/);
});

test('A manual check shows Checking and then a short up-to-date notice; setup holds the card back',async()=>{
 const h=harness();let state={current:'v0.2.0',phase:'checking'};h.context.fetch=async()=>({ok:true,json:async()=>state});
 await h.api.updateAction('check');assert.match(h.ids['update-card'].innerHTML,/Checking for updates…/);
 state={current:'v0.2.0',phase:'idle',available:false,checkedAt:'2026-11-10T03:00:00Z'};await h.api.pollUpdates();
 assert.match(h.ids['update-card'].innerHTML,/You’re on the latest version/);h.flush();assert.equal(h.ids['update-card'].hidden,true,'auto-hides');
 const s=harness();s.api.setup.open=true;s.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.3',available:true,phase:'available'});assert.equal(s.ids['update-card'].hidden,true,'never during setup');
 s.api.setup.open=false;s.api.renderUpdate();assert.equal(s.ids['update-card'].hidden,false,'shown once setup closes');
});

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
test('Offline status and error banner expose the reason',()=>{const h=harness();h.api.connection(false);assert.equal(h.ids.connection.textContent,'Reconnecting…');h.api.showError('Node failed: test');assert.equal(h.ids.error.hidden,false);assert.equal(h.ids['error-text'].textContent,'Couldn’t read plans — test');assert.equal(h.ids['error-raw'].textContent,'Node failed: test');assert.equal(h.ids['error-raw'].hidden,true);assert.equal(h.ids['error-details'].hidden,false);h.handlers.click({target:hit('[data-error-details]')});assert.equal(h.ids['error-raw'].hidden,false);assert.equal(h.ids['error-details'].textContent,'Hide details');h.api.showError('');assert.equal(h.ids.error.hidden,true);});
test('User text is escaped and pull request numbers link at all lengths',()=>{const h=harness();assert.equal(h.api.prs('<script>#1 #123456</script>','https://github.com/krik/workboard').includes('<script>'),false);assert.match(h.api.prs('#1 #123456','https://github.com/krik/workboard'),/pull\/123456/);});

test('SSE reconnect refetches state and clears the reconnecting label',async()=>{const h=harness();h.api.connect();const es=h.streams[0];es.onerror();assert.equal(h.ids.connection.textContent,'Reconnecting…');es.onopen();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.ids.connection.textContent,'Live');assert.deepEqual(h.requests,['/api/state']);});

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
 assert.match(h.ids['error-text'].textContent,/plan changed/);
 assert.equal(h.ids['save-state'].textContent,'');
});
test('A network failure keeps the original card and exposes the save error',async()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));
 h.context.fetch=async(path)=>{if(path==='/api/plans/status')throw Error('Network unavailable');return {ok:true,json:async()=>data([p])};};
 await h.api.moveStatus(p.repo+'/'+p.name,'Done',p.revision);
 assert.equal(h.api.planByKey(p.repo+'/'+p.name).status,'Implementing');
 assert.equal(h.ids['error-text'].textContent,'Network unavailable');
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
 assert.match(h.ids.upd.textContent,/Updated \d\d:\d\d/);assert.match(h.ids.upd.title,/05:05:00Z/);assert.equal(h.ids['save-state'].textContent,'Progress updated');
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
 await h.api.refresh();assert.match(h.ids['error-text'].textContent,/collector unavailable/);assert.equal(h.ids['save-state'].textContent,'Progress check failed');
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
 assert.equal(h.api.ui.view,'home');assert.match(h.ids['error-text'].textContent,/task changed/);
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
 changeControl(h,'data-task-group','plan');assert.equal((h.ids.view.innerHTML.match(/class="task-group-heading"/g)||[]).length,2);assert.equal((h.ids.view.innerHTML.match(/2 of 2 tasks matched/g)||[]).length,2);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','workboard/Same'));assert.equal(h.api.ui.collapsedPlans['workboard/Same'],true);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,2);assert.match(h.ids.view.innerHTML,/aria-expanded="false"/);
 changeControl(h,'data-task-group','none');assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
 changeControl(h,'data-task-group','plan');assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,2);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','workboard/Same'));assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
});

test('Plan group progress includes hidden done tasks and stays visible when collapsed or expanded',()=>{
 const h=harness(),p=plan('Blocked - waiting for input','Plan <one>');
 p.steps=['done','doing','done','todo','partial','blocked'].map((status,i)=>({status,text:'Task '+i}));
 p.milestones=[{id:'M1',title:'Duplicate presentation',steps:p.steps}];
 setList(h,[p]);h.api.ui.taskStatus='doing';changeControl(h,'data-task-group','plan');
 const assertProgress=()=>{
   const heading=h.ids.view.innerHTML.match(/<tbody class="task-group-heading">[\s\S]*?<\/tbody>/)[0];
   assert.match(heading,/1 of 6 tasks matched/);assert.match(heading,/2\/6 · 33%/);
   assert.match(heading,/aria-valuenow="33"/);assert.match(heading,/aria-valuetext="2 of 6 tasks complete across the whole plan"/);
   assert.match(heading,/status-blocked">Blocked<\/span>/);assert.match(heading,/Plan &lt;one&gt;/);
   assert.match(heading,/colspan="3"/);assert.match(heading,/class="task-group-status"/);
 };
 assertProgress();assert.equal(listRows(h).length,1);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','workboard/Plan <one>'));
 assertProgress();assert.doesNotMatch(h.ids.view.innerHTML,/data-open-task=/);assert.match(h.ids.view.innerHTML,/aria-expanded="false"/);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','workboard/Plan <one>'));
 assertProgress();assert.equal(listRows(h).length,1);
});

test('Same-named plans retain independent completion and plan stages are not inferred from completion',()=>{
 const h=harness(),a=plan('Done','Same'),b=plan('Implementing','Same');b.repo='second';
 a.steps=[{status:'done',text:'Done'},{status:'todo',text:'Unfinished'}];
 b.steps=[{status:'done',text:'One'},{status:'done',text:'Two'},{status:'done',text:'Three'}];
 setList(h,[a,b]);changeControl(h,'data-task-group','plan');
 const headings=Array.from(h.ids.view.innerHTML.matchAll(/<tbody class="task-group-heading">([\s\S]*?)<\/tbody>/g),m=>m[1]);
 assert.match(headings[0],/second · 3 of 3 tasks matched/);assert.match(headings[0],/3\/3 · 100%/);assert.match(headings[0],/status-doing">Implementing/);
 assert.match(headings[1],/workboard · 2 of 2 tasks matched/);assert.match(headings[1],/1\/2 · 50%/);assert.match(headings[1],/status-done">Done/);
});

test('Refresh updates whole-plan completion in a collapsed group while retaining its task filter',async()=>{
 const h=harness({layout:'list'}),p=plan();p.steps=[{status:'done',text:'One'},{status:'doing',text:'Two'},{status:'todo',text:'Three'}];
 setList(h,[p]);h.api.ui.taskStatus='doing';changeControl(h,'data-task-group','plan');
 h.api.handleViewAction(actionEvent('data-task-group-toggle','workboard/'+p.name));
 assert.match(h.ids.view.innerHTML,/1\/3 · 33%/);
 const newer=structuredClone(p);newer.steps[2].status='done';
 h.context.fetch=async path=>({ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([newer])});
 await h.api.refresh();
 assert.equal(h.api.ui.taskStatus,'doing');assert.equal(h.api.ui.collapsedPlans['workboard/'+p.name],true);
 assert.match(h.ids.view.innerHTML,/1 of 3 tasks matched/);assert.match(h.ids.view.innerHTML,/2\/3 · 67%/);
 assert.doesNotMatch(h.ids.view.innerHTML,/data-open-task=/);
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
 control.value='Blocked';h.handlers.change({target:control});assert.equal(control.className,'status-select status-blocked');await settle();assert.match(h.ids.top.innerHTML,/class="status-select status-review"/);assert.match(h.ids['error-text'].textContent,/Concurrent stage change/);
});

test('A mixed milestone displays its technical notes once when split into open and completed work',()=>{
 const h=harness(),p=focusPlan();p.milestones[1].summary='Unique recorded milestone evidence';h.api.setData(data([p]));h.api.ui.view='plan:workboard/Focus';h.api.ui.tab='checklist';h.api.render();
 assert.equal((h.ids.view.innerHTML.match(/Unique recorded milestone evidence/g)||[]).length,1);const ids=Array.from(h.ids.view.innerHTML.matchAll(/\bid="([^"]+)"/g),m=>m[1]);assert.equal(ids.length,new Set(ids).size);assert.ok(h.ids.view.innerHTML.indexOf('Unique recorded milestone evidence')<h.ids.view.innerHTML.indexOf('<details class="plan-completed"'));
});

// ---------- First-run setup, Settings, empty and error states ----------
function settingsPayload(projects=[],extra={}){return {setupRequired:!projects.length,setupComplete:false,notifications:true,startWithWindows:false,startupManaged:true,dataDir:'C:\\Users\\me\\AppData\\Local\\krik-workboard',configFile:'config.json',stateFile:'state.json',projectsOverridden:'',warning:'',readOnly:'',version:'v0.2.0',projects,...extra};}
const workProject={id:'p1',path:'C:\\work',name:'work',kind:'folder',enabled:true,addedAt:'2026-11-10T00:00:00Z',exists:true,repos:[{name:'web',path:'C:\\work\\web',hasTasks:true,planCount:2},{name:'api',path:'C:\\work\\api',hasTasks:true,planCount:1}]};
function settingsServer(h,routes){
 const calls=[];h.context.fetch=async(path,options={})=>{calls.push({path,method:options.method || 'GET',headers:options.headers || {},body:options.body?JSON.parse(options.body):undefined});const route=routes[(options.method || 'GET')+' '+path] || routes[path];const [status,body]=route?route(calls.at(-1)):[200,data([])];return {ok:status<400,status,json:async()=>body};};
 return calls;
}
const drain=async()=>{for(let i=0;i<6;i++)await settle();};

test('First run walks through welcome, adding a project with the native picker and preferences before finishing',async()=>{
 const h=harness();let projects=[];
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload(projects)],
  'POST /api/settings/pick-folder':()=>[200,{path:'C:\\work'}],
  'POST /api/projects':()=>{projects=[workProject];return [200,{project:workProject,kind:'folder',name:'work',repos:workProject.repos,settings:settingsPayload(projects)}];},
  'PUT /api/settings':call=>[200,{...settingsPayload(projects),setupComplete:true,setupRequired:false,notifications:call.body.notifications ?? true,theme:call.body.theme || 'system'}],
 });
 h.api.setData({...data([]),setupRequired:true,projects:[]});h.api.syncSetup();await drain();
 const card=()=>h.ids.onboarding.innerHTML;
 assert.equal(h.ids.onboarding.hidden,false);assert.match(card(),/Welcome to Agent Ops/);assert.match(card(),/Your work ledger for every repository/);assert.match(card(),/\.tasks\/\*\.md/);
 assert.match(card(),/Step 1 of 3/);assert.match(card(),/aria-current="step"/);assert.match(card(),/Set up later/,'setup can be skipped before any project exists');
 h.handlers.click({target:hit('[data-setup-next]')});assert.match(card(),/Add your projects/);assert.match(card(),/Choose folder…/);assert.match(card(),/Paste a path instead/);assert.match(card(),/Step 2 of 3/);
 assert.match(card(),/id="setup-next" data-setup-next disabled title="Add a project to continue"/);
 h.handlers.click({target:hit('[data-setup-next]')});assert.match(card(),/Add your projects/,'cannot continue without a project');
 h.handlers.keydown({key:'Enter',ctrlKey:true,preventDefault(){},target:{}});assert.match(card(),/Add your projects/,'Ctrl+Enter cannot skip the project step either');
 h.handlers.click({target:hit('[data-project-choose]',{'data-project-choose':'setup'})});await drain();
 assert.deepEqual(calls.filter(c=>c.method!=='GET').map(c=>c.method+' '+c.path),['POST /api/settings/pick-folder','POST /api/projects']);
 const added=calls.find(c=>c.path==='/api/projects');assert.equal(added.body.path,'C:\\work');assert.equal(added.headers['X-Workboard'],'1');assert.equal(added.headers['Content-Type'],'application/json');
 assert.match(card(),/Folder · 2 repositories · 3 plans/);assert.match(card(),/C:\\work/);assert.match(card(),/Project added · 3 plans found/);assert.match(card(),/data-project-remove="p1"/);assert.match(card(),/aria-label="Remove work"/);
 h.handlers.keydown({key:'Enter',ctrlKey:true,preventDefault(){},target:{}});assert.match(card(),/A few preferences/);assert.match(card(),/Start with Windows/);assert.match(card(),/Desktop notifications/);assert.match(card(),/role="radiogroup" aria-label="Theme"/);assert.match(card(),/Open ledger/);
 assert.doesNotMatch(card(),/Set up later/,'the last step finishes instead');
 h.api.settingsChange({checked:false,closest(s){return s==='[data-setting]'?{getAttribute:()=>'notifications'}:s==='[data-scope]'?{getAttribute:()=>'setup'}:null;}});await drain();
 assert.deepEqual(calls.filter(c=>c.method==='PUT').at(-1).body,{notifications:false});assert.match(card(),/Saved/);
 h.handlers.click({target:hit('[data-theme-choice]',{'data-theme-choice':'dark','data-scope':'setup'})});await drain();
 assert.deepEqual(calls.filter(c=>c.method==='PUT').at(-1).body,{theme:'dark'});assert.equal(h.context.document.documentElement.attributes['data-theme'],'dark','theme applies right away');assert.equal(JSON.parse(h.storage['wb-prefs']).theme,'dark');
 h.handlers.click({target:hit('[data-setup-finish]')});await drain();
 assert.deepEqual(calls.filter(c=>c.method==='PUT').at(-1).body,{setupComplete:true});
 assert.equal(h.api.setup.open,false);assert.equal(h.ids.onboarding.hidden,true);
});

test('Setup can be skipped with no project, Escape asks first, and the board then offers Add a project',async()=>{
 const h=harness();const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload([])],
  'PUT /api/settings':()=>[200,{...settingsPayload([]),setupComplete:true,setupRequired:false}],
  '/api/state':()=>[200,{...data([]),projects:[],setupRequired:false}],
 });
 h.api.setData({...data([]),setupRequired:true,projects:[]});h.api.syncSetup();await drain();
 const card=()=>h.ids.onboarding.innerHTML;
 h.handlers.keydown({key:'Escape',preventDefault(){},target:{}});assert.match(card(),/Skip setup\?/);assert.match(card(),/You can finish it later from Settings/);assert.equal(calls.filter(c=>c.method==='PUT').length,0,'Escape only asks');
 h.handlers.click({target:hit('[data-setup-keep]')});assert.doesNotMatch(card(),/Skip setup\?/);
 h.handlers.keydown({key:'Escape',preventDefault(){},target:{}});h.handlers.click({target:hit('[data-setup-skip]')});await drain();
 assert.deepEqual(calls.filter(c=>c.method==='PUT').at(-1).body,{setupComplete:true});assert.equal(h.api.setup.open,false);
 h.api.render();assert.match(h.ids.view.innerHTML,/Add a project to start/);assert.match(h.ids.view.innerHTML,/data-settings-empty-add/);
});

test('Pasted paths show server validation inline and projects can be toggled and removed with confirmation',async()=>{
 const h=harness();let projects=[workProject];
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload(projects,{setupRequired:false,setupComplete:true})],
  'POST /api/projects':()=>[400,{error:'This folder is inside the project “work”, which already includes it.'}],
  'PATCH /api/projects/p1':call=>{projects=[{...workProject,enabled:call.body.enabled}];return [200,settingsPayload(projects,{setupRequired:false})];},
  'DELETE /api/projects/p1':()=>{projects=[];return [200,settingsPayload(projects,{setupRequired:false})];},
 });
 h.api.openSettings('projects');await drain();
 const page=()=>h.ids.settings.innerHTML;
 assert.equal(h.ids.settings.hidden,false);assert.match(page(),/Back to ledger/);assert.match(page(),/Search settings/);assert.match(page(),/Settings \/ Projects/);assert.match(page(),/data-settings-section="project:p1"/);assert.match(page(),/Include in ledger/);assert.match(page(),/Open folder/);
 h.handlers.click({target:hit('[data-settings-add]')});h.handlers.click({target:hit('[data-project-paste]',{'data-project-paste':'settings'})});assert.match(page(),/id="settings-path"/);assert.match(page(),/placeholder="D:\\Projects\\my-repo"/);
 h.api.settingsInput({value:'C:\\work\\web',closest(s){return s==='[data-project-path]'?{getAttribute:()=>'settings'}:null;}});
 let prevented=false;h.handlers.keydown({key:'Enter',preventDefault(){prevented=true;},target:{closest(s){return s==='[data-project-path]'?{getAttribute:()=>'settings'}:null;}}});await drain();
 assert.ok(prevented);assert.equal(calls.find(c=>c.method==='POST').body.path,'C:\\work\\web');
 assert.match(page(),/role="alert">.*This folder is inside the project “work”/);assert.match(page(),/aria-invalid="true"/);
 h.handlers.keydown({key:'Escape',preventDefault(){},target:{closest(s){return s==='[data-project-path]'?{getAttribute:()=>'settings'}:null;}}});assert.doesNotMatch(page(),/id="settings-path"/,'Escape collapses the path field');assert.equal(h.api.settingsUI.open,true);
 h.api.settingsChange({checked:false,closest(s){return s==='[data-project-toggle]'?{getAttribute:()=>'p1'}:null;}});await drain();
 assert.deepEqual(calls.find(c=>c.method==='PATCH').body,{enabled:false});assert.match(page(),/is-disabled/);assert.match(page(),/Hidden/);
 h.handlers.click({target:hit('[data-project-remove]',{'data-project-remove':'p1','data-scope':'settings'})});
 assert.equal(calls.filter(c=>c.method==='DELETE').length,0,'first click only asks to confirm');assert.match(page(),/Click again to remove/);
 h.handlers.click({target:hit('[data-project-remove]',{'data-project-remove':'p1','data-scope':'settings'})});await drain();
 assert.equal(calls.filter(c=>c.method==='DELETE').length,1);assert.match(page(),/No projects added yet/);
 h.handlers.keydown({key:'Escape',preventDefault(){},target:{}});assert.equal(h.api.settingsUI.open,false);assert.equal(h.ids.settings.hidden,true);
});

test('Duplicate projects read as information, not an error',async()=>{
 const h=harness();settingsServer(h,{'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],'POST /api/projects':()=>[400,{error:'This folder is already added as “work”.'}]});
 h.api.openSettings('projects',{add:true});await drain();await h.api.addProject('settings','C:\\work');
 assert.match(h.ids.settings.innerHTML,/field-msg is-info" role="status"/);assert.doesNotMatch(h.ids.settings.innerHTML,/is-error/);
});

test('Settings search filters sections and projects and Escape clears the query before closing',async()=>{
 const h=harness(),beta={...workProject,id:'p2',name:'beta-lab',path:'D:\\lab\\beta',kind:'repo',repos:[{name:'beta-lab',path:'D:\\lab\\beta',hasTasks:false,planCount:0}]};
 settingsServer(h,{'GET /api/settings':()=>[200,settingsPayload([workProject,beta],{setupRequired:false})]});
 h.api.openSettings('general');await drain();
 const page=()=>h.ids.settings.innerHTML,search=v=>{h.api.settingsInput({id:'settings-search',value:v});h.flush();};
 assert.match(page(),/Start with Windows/);assert.match(page(),/Data folder/);assert.match(page(),/krik-workboard/);assert.match(page(),/Single-key shortcuts/);assert.match(page(),/Run setup again/);
 search('notif');assert.match(page(),/Desktop notifications/);assert.doesNotMatch(page(),/Data folder/);assert.doesNotMatch(page(),/Start with Windows/);
 search('dark');assert.match(page(),/role="radiogroup" aria-label="Theme"/);assert.doesNotMatch(page(),/Desktop notifications/);
 search('beta');assert.match(page(),/D:\\lab\\beta/);assert.doesNotMatch(page(),/data-settings-section="project:p1"/);assert.match(page(),/No \.tasks folder/);
 search('zzz');assert.match(page(),/No settings found for “zzz”/);assert.match(page(),/data-settings-clear-search/);assert.match(page(),/No matching projects/);
 h.handlers.click({target:hit('[data-settings-clear-search]')});assert.equal(h.api.settingsUI.query,'');assert.match(page(),/Start with Windows/);
 search('zzz');h.handlers.keydown({key:'Escape',preventDefault(){},target:{id:'settings-search'}});assert.equal(h.api.settingsUI.query,'');assert.equal(h.api.settingsUI.open,true);
 search('update');assert.match(page(),/Check for updates/);
 h.handlers.keydown({key:'Escape',preventDefault(){},target:{}});assert.equal(h.api.settingsUI.open,false);
});

test('Settings About checks for updates inline and offers one Update and restart action',async()=>{
 const h=harness();settingsServer(h,{'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})]});
 h.api.openSettings('about');await drain();
 h.api.receiveUpdate({current:'v0.2.0',latest:'v0.2.1',available:true,phase:'available',notes:'Faster <b>refresh</b>',commit:'abcdef1234567890'});
 const page=()=>h.ids.settings.innerHTML;
 assert.match(page(),/Agent Ops v0.2.0/);assert.match(page(),/Version v0.2.1 is available/);assert.match(page(),/Update and restart/);assert.match(page(),/Skip this version/);assert.match(page(),/Release notes/);assert.match(page(),/&lt;b&gt;refresh/);assert.match(page(),/abcdef123456/);
 h.api.receiveUpdate({current:'v0.2.0',phase:'idle',available:false,checkedAt:'2026-11-10T03:00:00Z'});assert.match(page(),/You’re on the latest version. Last checked \d\d:\d\d/);
});

test('Single-key shortcuts focus search and open Settings, skip typing, and can be turned off',async()=>{
 const h=harness();h.api.setData(data([plan()]));h.api.render();
 const key=(k,target={tagName:'BODY'},extra={})=>{let prevented=false;h.handlers.keydown({key:k,target,preventDefault(){prevented=true;},...extra});return prevented;};
 assert.ok(key('/'));assert.equal(h.context.document.activeElement,h.ids.q);
 assert.equal(key(',',{tagName:'INPUT',type:'text'}),false,'typing a comma never opens Settings');assert.equal(h.api.settingsUI.open,false);
 settingsServer(h,{'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],'PUT /api/settings':call=>[200,settingsPayload([workProject],{setupRequired:false,shortcuts:call.body.shortcuts})]});
 assert.ok(key(','));assert.equal(h.api.settingsUI.open,true);await drain();
 key('/',{tagName:'BODY'});assert.equal(h.context.document.activeElement,h.ids['settings-search'],'/ focuses the settings search');
 h.api.settingsChange({checked:false,closest(s){return s==='[data-setting]'?{getAttribute:()=>'shortcuts'}:s==='[data-scope]'?{getAttribute:()=>'settings'}:null;}});await drain();
 assert.equal(h.api.shortcutsOn(),false);assert.equal(JSON.parse(h.storage['wb-prefs']).shortcuts,false);
 h.api.closeSettings();h.ids.view.focus();
 assert.equal(key(','),false);assert.equal(h.api.settingsUI.open,false,'off means no single-key shortcuts');
 assert.equal(key('/'),false);
 assert.ok(key(',',{tagName:'BODY'},{ctrlKey:true}));assert.equal(h.api.settingsUI.open,true,'Ctrl+, still works');
});

test('No project shows Add a project to start; hidden projects say so instead of an error',()=>{
 const h=harness();h.api.setData({...data([]),projects:[],setupRequired:false});h.api.render();
 assert.match(h.ids.view.innerHTML,/Add a project to start/);assert.match(h.ids.view.innerHTML,/data-settings-empty-add/);assert.match(h.ids.view.innerHTML,/Open settings/);assert.doesNotMatch(h.ids.view.innerHTML,/Node failed|ENOENT/);
 h.api.ui.layout='list';h.api.render();assert.match(h.ids.view.innerHTML,/Add a project to start/);
 h.handlers.click({target:hit('[data-settings-empty-add]')});assert.equal(h.api.settingsUI.open,true);assert.equal(h.api.settingsUI.section,'projects');assert.equal(h.api.settingsUI.adding,true);
 const off=harness();off.api.setData({...data([]),projects:[{id:'p1',name:'work',enabled:false,status:'disabled'}],setupRequired:false});off.api.render();
 assert.match(off.ids.view.innerHTML,/All projects are hidden/);assert.match(off.ids.view.innerHTML,/data-settings-empty-add/);
});

test('The page loads nothing from another origin and every icon-only button has a label',()=>{
 assert.doesNotMatch(html,/https?:\/\/(?!127\.0\.0\.1)/i,'no external URL in the page');assert.doesNotMatch(html,/<link[^>]+stylesheet/);assert.doesNotMatch(html,/content: "\? "/);
 const h=harness();h.api.setData(data([plan()]));h.api.render();
 h.api.receiveUpdate({current:'v0.1.2',latest:'v0.1.3',available:true,phase:'available'});
 h.api.settingsData=settingsPayload([workProject],{setupRequired:false});h.api.openSettings('projects');h.api.setup.open=true;h.api.setup.step=1;h.api.renderSetup();
 const markup=[html.slice(0,html.indexOf('<script>')),h.ids['update-card'].innerHTML,h.ids.settings.innerHTML,h.ids.onboarding.innerHTML,h.ids['plan-sidebar'].innerHTML].join('');
 for(const button of markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)){
  const text=button.replace(/<svg[\s\S]*?<\/svg>/g,'').replace(/<[^>]+>/g,'').trim();
  if(!text && !/data-setup-goto|\shidden[\s>]/.test(button))assert.match(button,/aria-label="[^"]+"/,button.slice(0,120));
  if(/data-setup-goto/.test(button))assert.match(button,/aria-label="Step \d: /);
 }
});

test('Collector failures show what failed, keep the last good check and offer Retry; missing projects are warnings',async()=>{
 const h=harness(),p=plan();h.api.setData({...data([p]),state:{plans:[p],slots:{},generatedAt:'2026-11-10T02:30:00Z'}});
 h.api.showError('Could not read project “work” (C:\\work): EACCES: permission denied');
 assert.equal(h.ids.error.hidden,false);assert.match(h.ids['error-text'].textContent,/project “work”/);assert.match(h.ids['error-detail'].textContent,/Showing the last successful check from \d\d:\d\d/);
 const calls=settingsServer(h,{'POST /api/refresh':()=>[200,{refreshedAt:'now'}],'/api/state':()=>[200,data([p])]});
 h.handlers.click({target:hit('[data-retry]')});await drain();assert.equal(calls[0].path,'/api/refresh');assert.equal(calls[0].headers['X-Workboard'],'1');
 h.api.showWarnings(['Project “Gone” was not found at E:\\gone.']);assert.equal(h.ids.warnings.hidden,false);assert.match(h.ids.warnings.innerHTML,/Gone/);assert.match(h.ids.warnings.innerHTML,/data-settings-open="projects"/);
 h.api.showWarnings([]);assert.equal(h.ids.warnings.hidden,true);
});

test('Plans with the same repository folder in two projects keep separate keys and labels',()=>{
 const h=harness(),a={...plan(),project:'p1',projectName:'Work'},b={...plan(),project:'p2',projectName:'OSS'};
 h.api.setData(data([a,b]));
 assert.notEqual(h.api.key(a),h.api.key(b));assert.equal(h.api.planByKey('p2/workboard/'+a.name),b);
 assert.equal(h.api.planByKey('workboard/'+a.name),undefined,'ambiguous legacy links are not guessed');
 assert.equal(h.api.repoLabel(a),'workboard · Work');
 h.api.setData(data([a]));assert.equal(h.api.planByKey('workboard/'+a.name),a,'unique legacy link still opens');assert.equal(h.api.repoLabel(a),'workboard');
});

test('Stars, recent plans and collapsed groups saved before projects move to project-qualified keys',async()=>{
 const alpha={...plan('Implementing','Alpha'),project:'p1',projectName:'Work'},beta={...plan('Implementing','Beta'),project:'p1',projectName:'Work'};
 const dupA={...plan('Implementing','Dup'),project:'p1',projectName:'Work'},dupB={...plan('Implementing','Dup'),project:'p2',projectName:'OSS'};
 const now=new Date().toISOString();
 const h=harness(
  {collapsedPlans:{'workboard/Alpha':true,'workboard/Dup':true,'p1/workboard/Beta':false,'workboard/Gone':true},view:'plan:workboard/Alpha'},
  {starred:['workboard/Alpha','p1/workboard/Beta','workboard/Dup','workboard/Gone'],recent:[{key:'workboard/Beta',openedAt:now},{key:'p1/workboard/Beta',openedAt:now},{key:'workboard/Alpha',openedAt:now}]});
 h.context.fetch=async()=>({ok:true,json:async()=>data([alpha,beta,dupA,dupB])});
 await h.api.get();
 assert.deepEqual([...h.api.navigation.starred],['p1/workboard/Alpha','p1/workboard/Beta','workboard/Dup','workboard/Gone'],'unique legacy keys move; ambiguous and unknown keys stay');
 assert.deepEqual([...h.api.navigation.recent.map(r=>r.key)],['p1/workboard/Alpha','p1/workboard/Beta'],'recent entries that collapse onto one key are deduplicated, and the open plan is the latest visit');
 assert.deepEqual({...h.api.ui.collapsedPlans},{'p1/workboard/Alpha':true,'p1/workboard/Beta':false,'workboard/Dup':true,'workboard/Gone':true});
 assert.equal(h.api.ui.view,'plan:p1/workboard/Alpha');
 assert.deepEqual(JSON.parse(h.storage["wb-navigation"]).starred,[...h.api.navigation.starred],'migrated preferences are saved once');
 assert.equal(JSON.parse(h.storage['wb-ui']).collapsedPlans['p1/workboard/Alpha'],true);
 h.api.navigation.section='starred';
 assert.deepEqual([...h.api.sidebarPlans().map(p=>p.name)],['Alpha','Beta'],'the Starred collection shows the old stars');
 const writes=h.writes.length;await h.api.get();assert.equal(h.writes.length,writes,'a second state load does not rewrite preferences');
 h.api.togglePlanStar('p1/workboard/Alpha');
 assert.equal(h.api.navigation.starred.includes('p1/workboard/Alpha'),false,'clicking the star removes the migrated key instead of adding a second one');
 assert.equal(h.api.navigation.starred.includes('workboard/Alpha'),false);
});
test('Stored keys are left alone until the first state with plans arrives',async()=>{
 const h=harness({collapsedPlans:{'workboard/Alpha':true}},{starred:['workboard/Alpha'],recent:[]});
 h.context.fetch=async()=>({ok:true,json:async()=>data([])});await h.api.get();
 assert.deepEqual([...h.api.navigation.starred],['workboard/Alpha']);
 h.context.fetch=async()=>({ok:true,json:async()=>data([{...plan('Implementing','Alpha'),project:'p1'}])});await h.api.get();
 assert.deepEqual([...h.api.navigation.starred],['p1/workboard/Alpha']);assert.deepEqual({...h.api.ui.collapsedPlans},{'p1/workboard/Alpha':true});
});
