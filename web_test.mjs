import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';
const html=readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(saved={layout:"board"},nav={},stored={}){
 const ids={}, handlers={}, timers=[], requests=[], streams=[],storage={'wb-ui':JSON.stringify(saved),'wb-navigation':JSON.stringify(nav),...stored},writes=[];let context;
 function element(id){return {id,innerHTML:'',textContent:'',className:'',hidden:false,isConnected:true,scrollTop:0,value:'',selectionStart:0,selectionEnd:0,attributes:{},listeners:{},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},removeAttribute(k){delete this.attributes[k];},show(){this.open=true;this.modal=false;},showModal(){this.open=true;this.modal=true;},close(){this.open=false;},addEventListener(name,fn){this.listeners[name]=fn;},focus(){context.document.activeElement=this;},select(){this.selectionStart=0;this.selectionEnd=this.value.length;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}};}
 ['inspector-toggle','inspector-resize','command-dialog','command-input','command-results','view','top','tabs','nav','q','refresh','upd','error','live','connection','save-state','plan-sidebar','sidebar-toggle','quick-plan','quick-plan-content','quick-plan-scroll','quick-close','quick-tab-overview','quick-tab-checklist','quick-tab-activity','quick-star','quick-refresh','quick-full','quick-error','update-card','update-segment','update-dismiss','update-minimize','update-retry','update-apply','update-skip','app-version','status-totals','error-raw','error-details','settings-check-updates','setup-keep','setup-skip-confirm','setup-choose','onboarding-card','settings-add','settings-nav-add','error-text','error-detail','error-retry','warnings','crash','onboarding','settings','settings-open','settings-search','settings-main','settings-close','settings-choose','settings-path','setup-path','setup-next','setup-finish','setup-back','setup-skip'].forEach(id=>ids[id]=element(id));
 context=vm.createContext({console,Date,URL,URLSearchParams,encodeURI,encodeURIComponent,decodeURIComponent,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(i){timers[i-1]=null;},setInterval(){},location:{hash:''},localStorage:{getItem(key){return storage[key] || null;},setItem(k,v){storage[k]=v;writes.push(k);}},window:{addEventListener(name,fn){handlers[name]=fn;}},document:{querySelectorAll(){return [];},activeElement:null,documentElement:{attributes:{},setAttribute(k,v){this.attributes[k]=v;}},getElementById(id){return ids[id];},addEventListener(name,fn){handlers[name]=fn;}},fetch(path){requests.push(path);return Promise.resolve({ok:true,json:async()=>data([])});},EventSource:class{constructor(){streams.push(this);}}});
 const instrumented=source.replace('jumpHash(); get(); connect(); initUpdates(); loadSettings();',`globalThis.api={acceptState,normalizePlan,patchChildren,patchRegion,planCache,routeHash,syncRoute,milestoneProgress,statusTone,statusGlyph,workspacePlans,archivedPlan,autoArchiveOn,openArchive,viewArchive,closePlanTab,commandState,openCommands,closeCommands,runCommand,commandItems,renderCommands,switchLayout,updateUI,receiveUpdate,updateAction,showUpdateCard,dismissUpdateCard,renderUpdate,updateCardKind,applyTheme,shortcutsOn,setupGo,openSetup,errorUI,pollUpdates,initUpdates,navigation,renderSidebar,sidebarPlans,openPlan,togglePlanStar,recordPlanVisit,taskRows,filteredTaskRows,focusedTask,refresh, viewList,    dateKey,  handleViewAction, planByKey, render,  owner, needsAttention, feedFor,  stepsHTML,  prs, jumpHash, connection, showError, connect, get, openColumnMenu,applyColumnMenu,sortTaskColumn,groupedTaskRows,setTaskGroups,columnInput,get columnMenu(){return columnMenu;},setData(j){D=j;}, ui, setup, settingsUI, renderSetup, renderSettings, openSettings, closeSettings, loadSettings, addProject, chooseFolder, removeProject, toggleProject, saveSetting, finishSetup, handleSettingsAction, settingsInput, settingsChange, settingsKey, showWarnings, showCrash, crashAction, copyDiagnostics, syncSetup, key, repoLabel, viewHome, integrationsUI, loadIntegrations, integrationAction, integrationDiff, setupInstallClients, addIntegration, changeTarget, dropTarget, chooseSkillsFolder, chooseInstructionFile, pastedIntegration, startEdit, saveEdit, get settingsData(){return settingsData;}, set settingsData(v){settingsData=v;}};`);
 vm.runInContext(instrumented,context);
 const routes=[];context.history={pushState(state,title,hash){routes.push(hash);context.location.hash=hash;context.location.href='http://127.0.0.1:17891/'+hash;},replaceState(state,title,hash){routes[routes.length-1]=hash;context.location.hash=hash;context.location.href='http://127.0.0.1:17891/'+hash;}};
 return {api:context.api,ids,context,handlers,requests,streams,storage,writes,routes,flush(){timers.splice(0).forEach(fn=>fn&&fn());}};
}
function plan(status='Implementing',name='Cải thiện tìm kiếm'){return {repo:'ledger',name,owner:'Minh',revision:'a'.repeat(64),status,tone:'doing',step:1,mtime:new Date().toISOString(),gh:'https://github.com/krik/ledger',root:'C:/sample',goal:'Gọn hơn #12',spec:'plan.md',next:'Kiểm tra kết quả #12',steps:[{status:'doing',text:'Kiểm tra tìm kiếm'},{status:'todo',text:'Xác minh #12'}],milestones:[],decisions:[{key:'202611090900',when:'09/11 09:00',text:'Giữ tiếng Việt'}],questions:[{key:'202611090930',when:'09/11 09:30',ask:'Chốt giao diện?',answer:'',open:true}]};}
function data(plans){return {state:{plans},activity:[],stale:{},now:new Date().toISOString(),error:''};}
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
 await h.api.updateAction('skip');assert.equal(calls[0][0],'/api/updates/skip');assert.equal(calls[0][1].headers['X-Agent-Ops'],'1');assert.equal(JSON.parse(calls[0][1].body).version,'v0.1.3');assert.equal(h.ids['update-card'].hidden,true);
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
 h.api.setData({...data([p]),appVersion:'v0.1.2'});h.api.ui.layout='list';h.api.ui.taskStatus='blocked';h.api.ui.taskGroup='plan';h.api.ui.collapsedPlans={['ledger/'+p.name]:true};
 h.ids.view.scrollTop=223;h.ids.view.scrollLeft=40;
 h.context.fetch=async()=>({ok:true,json:async()=>({...data([p]),appVersion:'v0.1.3'})});await h.api.get();assert.equal(reloads,1);
 const saved=JSON.parse(h.storage['wb-update-view']);assert.equal(saved.version,'v0.1.3');assert.equal(saved.ui.taskStatus,'blocked');
 const fresh=harness();fresh.storage['wb-update-view']=h.storage['wb-update-view'];fresh.context.fetch=h.context.fetch;await fresh.api.get();
 assert.equal(fresh.api.ui.layout,'list');assert.equal(fresh.api.ui.taskStatus,'blocked');assert.equal(fresh.api.ui.taskGroup,'plan');assert.equal(fresh.api.ui.collapsedPlans['ledger/'+p.name],true);
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

test('Debounced search preserves header, navigation, scroll and focus',()=>{const h=harness();h.api.setData(data([plan()]));h.api.render();const top=h.ids.top.innerHTML,nav=h.ids.nav.innerHTML,input=h.ids.q;h.ids.view.scrollTop=115;h.ids.view.scrollLeft=312;input.focus();input.value='Minh';input.oninput();assert.equal(h.api.ui.q,'Minh');h.flush();assert.equal(h.ids.top.innerHTML,top);assert.equal(h.ids.nav.innerHTML,nav);assert.equal(h.ids.view.scrollTop,115);assert.equal(h.ids.view.scrollLeft,312);assert.equal(h.context.document.activeElement,input);});
test('Work keeps decisions and questions in separate tabs',()=>{const h=harness(),p=plan();h.api.setData(data([p]));h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab='checklist';h.api.render();assert.match(h.ids.view.innerHTML,/Kiểm tra tìm kiếm/);assert.doesNotMatch(h.ids.view.innerHTML,/Giữ tiếng Việt|Chốt giao diện/);assert.match(h.ids.tabs.innerHTML,/Decisions/);assert.match(h.ids.top.innerHTML,/Overview/);});
test('Historical entries in different plans do not suppress each other',()=>{const h=harness(),a=plan(),b=plan('Testing','Kiểm thử');h.api.setData(data([a,b]));assert.equal(h.api.feedFor(null).length,4);});
test('Encoded toast hash opens the matching plan Summary',()=>{const h=harness();h.context.location.hash='#plan='+encodeURIComponent('ledger/Cải thiện tìm kiếm');h.api.jumpHash();assert.equal(h.api.ui.view,'plan:ledger/Cải thiện tìm kiếm');assert.equal(h.api.ui.tab,'summary');});
test('Command search opens a plan with the keyboard and returns focus on Escape',()=>{
 const h=harness(),p=plan();h.api.setData(data([p]));h.ids.q.focus();
 const key=(value,extra={})=>h.handlers.keydown({key:value,target:{tagName:'INPUT'},preventDefault(){},...extra});
 key('k',{ctrlKey:true});assert.equal(h.ids['command-dialog'].open,true);assert.equal(h.context.document.activeElement,h.ids['command-input']);
 h.ids['command-input'].value='cai thien';h.handlers.input({target:h.ids['command-input']});
 assert.equal(h.api.commandState.items.length,1);key('Enter');assert.equal(h.api.ui.view,'plan:ledger/'+p.name);assert.equal(h.ids['command-dialog'].open,false);
 key('Escape');assert.equal(h.api.ui.view,'plan:ledger/'+p.name);
 h.ids.q.focus();key('k',{ctrlKey:true});key('Escape');assert.equal(h.context.document.activeElement,h.ids.q);
 h.api.ui.view='plan:ledger/'+p.name;key('Escape',{target:{tagName:'BUTTON'}});assert.equal(h.api.ui.view,'home');
});
test('Command search executes a view action and ignores Enter on an empty result',()=>{
 const h=harness();h.api.openCommands();h.ids['command-input'].value='Overview';h.handlers.input({target:h.ids['command-input']});h.api.runCommand(0);
 assert.equal(h.api.ui.layout,'summary');assert.equal(h.api.ui.view,'home');
 h.api.openCommands();h.ids['command-input'].value='no such command';h.handlers.input({target:h.ids['command-input']});h.api.runCommand(0);
 assert.equal(h.api.commandState.open,true);assert.equal(h.api.ui.layout,'summary');h.api.closeCommands();
});
test('View and sidebar modifier shortcuts work while typing; a new workspace starts on Summary',()=>{
 const h=harness({});assert.equal(h.api.ui.layout,'summary');
 const key=(value)=>h.handlers.keydown({key:value,ctrlKey:true,target:{tagName:'INPUT'},preventDefault(){}});
 key('2');assert.equal(h.api.ui.layout,'list');key('b');assert.equal(h.api.navigation.collapsed,true);key('b');assert.equal(h.api.navigation.collapsed,false);
});

test('Archive separates explicit Done plans without changing sources or hiding direct links',()=>{
 const h=harness({}),a=plan('Implementing','Active'),b=plan('Done','Finished'),c=plan('Implementing','Complete checklist');
 c.steps.forEach(s=>s.status='done');h.api.setData(data([a,b,c]));const before=JSON.stringify([a,b,c]);h.api.settingsData={autoArchiveDone:true};h.api.render();
 assert.deepEqual(Array.from(h.api.workspacePlans(),p=>p.name),['Active','Complete checklist']);assert.equal(h.api.planByKey('ledger/Finished'),b);
 h.api.openArchive();assert.equal(h.api.ui.view,'archive');assert.match(h.ids.view.innerHTML,/Finished/);assert.doesNotMatch(h.ids.view.innerHTML,/Complete checklist|>Active</);
 h.api.openPlan('ledger/Finished');assert.equal(h.api.ui.view,'plan:ledger/Finished');h.api.openArchive();assert.equal(JSON.stringify([a,b,c]),before);
 b.status='Reviewing';h.api.render();assert.match(h.ids.view.innerHTML,/No archived plans/);assert.equal(h.api.workspacePlans().length,3);
 h.api.settingsData={autoArchiveDone:false};h.api.ui.view='home';h.api.render();assert.equal(h.api.sidebarPlans().length,3);assert.equal(h.requests.length,0);
});

test('Workspace plan tabs persist, close independently and leave source plans intact',()=>{
 const h=harness(),a=plan('Testing','Alpha'),b=plan('Testing','Beta');h.api.setData(data([a,b]));
 for(const p of [a,b]){h.api.ui.view='plan:ledger/'+p.name;h.api.render();}
 assert.deepEqual(Array.from(h.api.navigation.openPlans),['ledger/Alpha','ledger/Beta']);h.api.closePlanTab('ledger/Beta');assert.equal(h.api.ui.view,'plan:ledger/Alpha');
 h.api.closePlanTab('ledger/Alpha');assert.equal(h.api.ui.view,'home');assert.equal(h.api.planByKey('ledger/Beta'),b);assert.equal(h.requests.length,0);
});

test('Offline status and error banner expose the reason',()=>{const h=harness();h.api.connection(false);assert.equal(h.ids.connection.textContent,'Reconnecting…');h.api.showError('Node failed: test');assert.equal(h.ids.error.hidden,false);assert.equal(h.ids['error-text'].textContent,'Couldn’t read plans — test');assert.equal(h.ids['error-raw'].textContent,'Node failed: test');assert.equal(h.ids['error-raw'].hidden,true);assert.equal(h.ids['error-details'].hidden,false);h.handlers.click({target:hit('[data-error-details]')});assert.equal(h.ids['error-raw'].hidden,false);assert.equal(h.ids['error-details'].textContent,'Hide details');h.api.showError('');assert.equal(h.ids.error.hidden,true);});
test('User text is escaped and pull request numbers link at all lengths',()=>{const h=harness();assert.equal(h.api.prs('<script>#1 #123456</script>','https://github.com/krik/ledger').includes('<script>'),false);assert.match(h.api.prs('#1 #123456','https://github.com/krik/ledger'),/pull\/123456/);});

test('SSE reconnect refetches state and clears the reconnecting label',async()=>{const h=harness();h.api.connect();const es=h.streams[0];es.onerror();assert.equal(h.ids.connection.textContent,'Reconnecting…');es.onopen();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.ids.connection.textContent,'Live');assert.deepEqual(h.requests,['/api/state']);});

const settle=()=>new Promise(resolve=>setImmediate(resolve));

function actionEvent(attr,value,extras={}) {
 const control={getAttribute(name){return name===attr?value:extras[name];}};
 return {target:{closest(selector){return selector==='['+attr+']'?control:null;}}};
}
test('List shows actual checklist tasks with parent plans and read-only statuses',()=>{
 const h=harness(),p=plan();p.agent='Claude';p.steps[0].executors=['Anti'];const html=h.api.viewList([p]);
 for(const label of ['Work','Plan','Status'])assert.match(html,new RegExp('>'+label+'<'));
 for(const label of ['Agent','Latest result','Updated'])assert.doesNotMatch(html,new RegExp('>'+label+'<'));
 assert.match(html,/Kiểm tra tìm kiếm/);assert.match(html,/data-open-task=/);assert.doesNotMatch(html,/anti\.png|\/icons\//);
 assert.doesNotMatch(html,/data-agent=|data-executor=|data-status=/);
});
test('Daily history uses Vietnam dates across UTC midnight and handles leap February',()=>{
 const h=harness();
 assert.equal(h.api.dateKey('2026-11-08T18:00:00Z'),'2026-11-09');
 assert.equal(h.api.dateKey('broken'),'');

});
test('Saved agent and attention filters cannot hide plans on a newly opened window',()=>{
 const h=harness({layout:'summary',view:'waiting',agent:'Codex',q:'old query'});
 const ps=Array.from({length:6},(_,i)=>plan('Implementing','Plan '+i));
 h.api.setData(data(ps));h.api.render();
 assert.equal(h.api.ui.layout,'summary');assert.equal(h.api.ui.view,'home');assert.equal(h.api.ui.agent,undefined);assert.equal(h.api.ui.q,'');
 assert.match(h.ids.top.innerHTML,/6 of 6 plans/);assert.match(h.ids.view.innerHTML,/Plan 5/);
});
test('Choosing a layout exits the attention-only view',()=>{
 const h=harness();h.api.setData(data([plan()]));h.api.ui.view='waiting';
 h.api.handleViewAction(actionEvent('data-layout','summary'));
 assert.equal(h.api.ui.view,'home');assert.match(h.ids.view.innerHTML,/ledger-table-row/);
});
test('F5 checks fresh progress while preserving view, search and filters and preventing browser reload',async()=>{
 const h=harness(),p=plan(),j=data([p]);j.state.generatedAt='2026-11-09T05:00:00Z';h.api.setData(j);
 h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.q='test';h.api.ui.layout='list';h.api.render();
 const calls=[];h.context.fetch=async(path,options)=>{
  calls.push([path,options]);if(path==='/api/refresh')return {ok:true,json:async()=>({refreshedAt:'2026-11-09T05:05:00Z'})};
  const updated=structuredClone(j);updated.state.generatedAt='2026-11-09T05:05:00Z';return {ok:true,json:async()=>updated};
 };
 let prevented=false;h.handlers.keydown({key:'F5',target:{tagName:'INPUT'},preventDefault(){prevented=true;}});await settle();
 assert.ok(prevented);assert.deepEqual(calls.map(c=>c[0]),['/api/refresh','/api/state']);assert.equal(calls[0][1].method,'POST');
 assert.equal(h.api.ui.view,'plan:'+p.repo+'/'+p.name);assert.equal(h.api.ui.q,'test');assert.equal(h.api.ui.layout,'list');
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

test('List defaults to individual In progress tasks even when their parent plan has a different stage',()=>{
 const h=harness({layout:'list',taskStatus:'done'}),p=plan('Done','Parent plan');
 p.steps=[{status:'todo',text:'Not started',line:5},{status:'doing',text:'Actual current work',line:6},{status:'done',text:'Already shipped',line:7}];
 p.milestones=[{id:'M1',steps:p.steps}];h.api.setData(data([p]));h.api.render();
 assert.equal(h.api.ui.taskStatus,'doing');assert.match(h.ids.top.innerHTML,/1 of 3 tasks/);assert.match(h.ids.view.innerHTML,/Status: In progress/);assert.match(h.ids.view.innerHTML,/data-column-menu="status"/);
 assert.match(h.ids.view.innerHTML,/Actual current work/);assert.doesNotMatch(h.ids.view.innerHTML,/Not started|Already shipped/);
 assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,1);
 assert.equal(h.api.taskRows([p]).length,3);assert.match(h.ids.view.innerHTML,/Plan status: Done/);
});

test('A plan in progress cannot turn To do tasks into work in progress, and empty List offers all statuses',()=>{
 const h=harness({layout:'list'}),p=plan();p.steps=[{status:'todo',text:'Queued task'}];h.api.setData(data([p]));h.api.render();
 assert.match(h.ids.view.innerHTML,/No tasks in progress/);assert.match(h.ids.view.innerHTML,/1 checklist tasks are available/);assert.match(h.ids.view.innerHTML,/data-task-status-all/);
 h.api.handleViewAction(actionEvent('data-task-status-all',''));
 assert.equal(h.api.ui.taskStatus,'all');assert.match(h.ids.view.innerHTML,/Queued task/);assert.match(h.ids.top.innerHTML,/1 of 1 tasks/);
});

test('Status filters and task search combine and Clear filters resets them',()=>{
 const h=harness({layout:'list'}),p=plan();
 p.steps=[{status:'doing',text:'Search resolver'},{status:'todo',text:'Search UI'},{status:'done',text:'Closed search'}];
 h.api.setData(data([p]));h.api.ui.taskStatus='todo';h.api.render();
 assert.match(h.ids.view.innerHTML,/Search UI/);assert.doesNotMatch(h.ids.view.innerHTML,/Search resolver|Closed search/);
 h.api.ui.taskStatus='doing';h.api.ui.q='Closed';h.api.render();assert.match(h.ids.view.innerHTML,/No matching tasks/);
 h.api.ui.q='resolver';h.api.render();assert.match(h.ids.view.innerHTML,/Search resolver/);
 h.api.openColumnMenu('status');const ev=actionEvent('data-column-field','status');ev.target.value='done';h.handlers.change(ev);h.api.applyColumnMenu();
 assert.equal(h.api.ui.taskStatus,'done');assert.match(h.ids.view.innerHTML,/No matching tasks/);
 h.api.handleViewAction(actionEvent('data-clear-filters',''));assert.equal(h.api.ui.taskStatus,'all');assert.equal(h.api.ui.q,'');
 assert.match(h.ids.top.innerHTML,/3 of 3 tasks/);
});

test('Clicking a task opens and focuses its exact source row, including duplicate milestone and loose text',()=>{
 const h=harness({layout:'list'}),p=plan(),a={status:'doing',text:'Duplicate',line:5,milestone:''},b={status:'doing',text:'Duplicate',line:8,milestone:'M1'};
 p.steps=[a,b];p.milestones=[{id:'M1',title:'Delivery',steps:[{...b}]}];h.api.setData(data([p]));h.api.render();
 let scrolled=false,focused=false;h.ids['task-line-5']={scrollIntoView(){scrolled=true;},focus(){focused=true;}};
 h.api.handleViewAction(actionEvent('data-open-task',p.repo+'/'+p.name,{'data-task-index':'0','data-task-revision':p.revision}));
 assert.equal(h.api.ui.view,'plan:'+p.repo+'/'+p.name);assert.equal(h.api.ui.tab,'summary');assert.equal(h.api.focusedTask(p).line,5);
 assert.ok(scrolled && focused);assert.match(h.ids.view.innerHTML,/task-focused s-doing" id="task-line-5"/);assert.match(h.ids.view.innerHTML,/id="task-line-8"/);
 assert.match(h.ids.top.innerHTML,/Overview/);assert.equal((h.ids.view.innerHTML.match(/id="task-line-8"/g)||[]).length,1);
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
 const h=harness({layout:'list'}),p=plan();p.steps[1].status='done';h.api.setData(data([p]));
 h.api.ui.taskStatus='done';h.api.ui.q='Xác minh';h.api.render();
 h.context.fetch=async path=>({ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([p])});
 await h.api.refresh();assert.equal(h.api.ui.taskStatus,'done');assert.equal(h.api.ui.q,'Xác minh');
 assert.match(h.ids.view.innerHTML,/Xác minh #12/);assert.doesNotMatch(h.ids.view.innerHTML,/Kiểm tra tìm kiếm/);
});


function changeControl(h,attr,value,extra={}){const ev=actionEvent(attr,extra.key || '');Object.assign(ev.target,{value,...extra});h.handlers.change(ev);}
function listRows(h){return Array.from(h.api.filteredTaskRows(h.api.taskRows(h.context.__plans || [])),r=>r.s.text);}
function setList(h,ps){h.context.__plans=ps;h.api.setData(data(ps));h.api.ui.layout='list';h.api.ui.taskStatus='all';h.api.render();}

test('Plan header drafts a multi-selection, distinguishes identical names by repo and applies only on Apply',()=>{
 const h=harness(),a=plan('Implementing','Same'),b=plan('Implementing','Same'),c=plan('Implementing','Other');b.repo='second';setList(h,[a,b,c]);
 const before=JSON.stringify([a,b,c]);h.api.handleViewAction(actionEvent('data-column-menu','plan'));
 assert.match(h.ids.view.innerHTML,/role="dialog" aria-label="Plan filter and sort"/);
 h.api.handleViewAction(actionEvent('data-column-plans','none'));
 changeControl(h,'data-column-plan-choice','',{key:'ledger/Same',checked:true});
 changeControl(h,'data-column-plan-choice','',{key:'ledger/Other',checked:true});
 assert.equal(h.api.ui.taskPlans,null);assert.equal(listRows(h).length,6);
 h.api.handleViewAction(actionEvent('data-column-apply',''));
 assert.deepEqual(Array.from(h.api.ui.taskPlans),['ledger/Same','ledger/Other']);assert.equal(listRows(h).length,4);
 assert.doesNotMatch(h.ids.view.innerHTML,/second ·/);assert.match(h.ids.view.innerHTML,/Plans: Same \(ledger\), Other \(ledger\)/);
 h.api.openColumnMenu('plan');h.api.handleViewAction(actionEvent('data-column-plans','none'));h.api.applyColumnMenu();
 assert.equal(listRows(h).length,0);assert.match(h.ids.view.innerHTML,/None selected/);
 h.api.openColumnMenu('plan');h.api.handleViewAction(actionEvent('data-column-clear','plan'));assert.equal(listRows(h).length,6);
 assert.equal(JSON.stringify([a,b,c]),before);assert.equal(h.requests.length,0);
});

test('Plan option search narrows choices without applying a task filter; cancel and Escape discard drafts',()=>{
 const h=harness();setList(h,[plan('Implementing','Alpha'),plan('Implementing','Beta')]);h.api.openColumnMenu('plan');
 const ev=actionEvent('data-column-plan-search','');ev.target.value='Alpha';h.handlers.input(ev);
 assert.match(h.ids.view.innerHTML,/data-column-plan-choice="ledger\/Alpha"/);assert.doesNotMatch(h.ids.view.innerHTML,/data-column-plan-choice="ledger\/Beta"/);assert.equal(listRows(h).length,4);
 h.api.handleViewAction(actionEvent('data-column-plans','none'));h.api.handleViewAction(actionEvent('data-column-cancel',''));assert.equal(h.api.ui.taskPlans,null);
 h.api.openColumnMenu('work');changeControl(h,'data-column-field','Never');let prevented=false;
 h.handlers.keydown({key:'Escape',target:{tagName:'INPUT'},preventDefault(){prevented=true;}});
 assert.ok(prevented);assert.equal(h.api.columnMenu,null);assert.equal(h.api.ui.view,'home');assert.equal(h.api.ui.taskWork,'');
});

test('All task headers sort in either direction and use numeric text order',()=>{
 const h=harness(),ps=['10','2','3'].map((n,i)=>{const p=plan('Implementing','Plan '+n);p.steps=[{text:'Work '+n,status:['doing','todo','done'][i]}];return p;});
 setList(h,ps);
 const expected={work:[[2,3,10],[10,3,2]],plan:[[2,3,10],[10,3,2]],status:[[10,2,3],[3,2,10]]};
 for(const column of ['agent','result','updated'])assert.doesNotMatch(h.ids.view.innerHTML,new RegExp('data-column-menu="'+column+'"'));
 for(const [column,orders]of Object.entries(expected))for(const [i,direction]of ['asc','desc'].entries()){
  h.api.openColumnMenu(column);h.api.handleViewAction(actionEvent('data-column-sort',column,{'data-direction':direction}));
  assert.deepEqual(listRows(h),orders[i].map(n=>'Work '+n),column+' '+direction);assert.match(h.ids.view.innerHTML,new RegExp('aria-sort="'+(i?'descending':'ascending')+'"'));assert.equal(h.api.columnMenu,null);
 }
 h.api.sortTaskColumn('work','default');assert.equal(h.api.ui.taskSort,null);assert.deepEqual(listRows(h),['Work 10','Work 2','Work 3']);
 assert.equal(h.requests.length,0);
});

test('Header text and status filters combine; clearing one column preserves the rest',()=>{
 const h=harness(),p=plan();p.steps=[{text:'Search current',status:'doing'},{text:'Search queued',status:'todo'},{text:'Other work',status:'doing'}];setList(h,[p]);
 for(const [c,v]of [['work',' Search '],['status','doing']]){h.api.openColumnMenu(c);changeControl(h,'data-column-field',v);h.api.applyColumnMenu();}
 assert.deepEqual(listRows(h),['Search current']);assert.equal(h.api.ui.taskWork,'Search');
 h.api.openColumnMenu('status');h.api.handleViewAction(actionEvent('data-column-clear','status'));assert.deepEqual(listRows(h),['Search current','Search queued']);assert.equal(h.api.ui.taskWork,'Search');assert.equal(h.api.ui.taskStatus,'all');
});

test('Group by Plan renders accurate counts and independently expands or collapses each repository plan',()=>{
 const h=harness(),a=plan('Implementing','Same'),b=plan('Implementing','Same');b.repo='second';setList(h,[a,b]);
 changeControl(h,'data-task-group','plan');assert.equal((h.ids.view.innerHTML.match(/class="task-group-heading"/g)||[]).length,2);assert.equal((h.ids.view.innerHTML.match(/2 of 2 tasks matched/g)||[]).length,2);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','ledger/Same'));assert.equal(h.api.ui.collapsedPlans['ledger/Same'],true);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,2);assert.match(h.ids.view.innerHTML,/aria-expanded="false"/);
 changeControl(h,'data-task-group','none');assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
 changeControl(h,'data-task-group','plan');assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,2);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','ledger/Same'));assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,4);
});

test('Plan group progress includes hidden done tasks and stays visible when collapsed or expanded',()=>{
 const h=harness(),p=plan('Blocked - waiting for input','Plan <one>');
 p.steps=['done','doing','done','todo','partial','blocked'].map((status,i)=>({status,text:'Task '+i}));
 p.milestones=[{id:'M1',title:'Duplicate presentation',steps:p.steps}];
 setList(h,[p]);h.api.ui.taskStatus='doing';changeControl(h,'data-task-group','plan');
 const assertProgress=()=>{
   const heading=h.ids.view.innerHTML.match(/<tbody class="task-group-heading"[^>]*>[\s\S]*?<\/tbody>/)[0];
   assert.match(heading,/1 of 6 tasks matched/);assert.match(heading,/2\/6 · 33%/);
   assert.match(heading,/aria-valuenow="33"/);assert.match(heading,/aria-valuetext="2 of 6 tasks complete across the whole plan"/);
   assert.match(heading,/status-blocked">Blocked<\/span>/);assert.match(heading,/Plan &lt;one&gt;/);
   assert.match(heading,/class="task-group-status"/);assert.match(heading,/Open plan/);
 };
 assertProgress();assert.equal(listRows(h).length,1);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','ledger/Plan <one>'));
 assertProgress();assert.doesNotMatch(h.ids.view.innerHTML,/data-open-task=/);assert.match(h.ids.view.innerHTML,/aria-expanded="false"/);
 h.api.handleViewAction(actionEvent('data-task-group-toggle','ledger/Plan <one>'));
 assertProgress();assert.equal(listRows(h).length,1);
});

test('Same-named plans retain independent completion and plan stages are not inferred from completion',()=>{
 const h=harness(),a=plan('Done','Same'),b=plan('Implementing','Same');b.repo='api';
 a.steps=[{status:'done',text:'Done'},{status:'todo',text:'Unfinished'}];
 b.steps=[{status:'done',text:'One'},{status:'done',text:'Two'},{status:'done',text:'Three'}];
 setList(h,[a,b]);changeControl(h,'data-task-group','plan');
 const headings=Array.from(h.ids.view.innerHTML.matchAll(/<tbody class="task-group-heading"[^>]*>([\s\S]*?)<\/tbody>/g),m=>m[1]).sort((a,b)=>a.includes('api ·')?-1:b.includes('api ·')?1:0);
 assert.match(headings[0],/api · 3 of 3 tasks matched/);assert.match(headings[0],/3\/3 · 100%/);assert.match(headings[0],/status-doing">Implementing/);
 assert.match(headings[1],/ledger · 2 of 2 tasks matched/);assert.match(headings[1],/1\/2 · 50%/);assert.match(headings[1],/status-done">Done/);
});

test('Refresh updates whole-plan completion in a collapsed group while retaining its task filter',async()=>{
 const h=harness({layout:'list'}),p=plan();p.steps=[{status:'done',text:'One'},{status:'doing',text:'Two'},{status:'todo',text:'Three'}];
 setList(h,[p]);h.api.ui.taskStatus='doing';changeControl(h,'data-task-group','plan');
 h.api.handleViewAction(actionEvent('data-task-group-toggle','ledger/'+p.name));
 assert.match(h.ids.view.innerHTML,/1\/3 · 33%/);
 const newer=structuredClone(p);newer.revision='b'.repeat(64);newer.steps[2].status='done';
 h.context.fetch=async path=>({ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([newer])});
 await h.api.refresh();
 assert.equal(h.api.ui.taskStatus,'doing');assert.equal(h.api.ui.collapsedPlans['ledger/'+p.name],true);
 assert.match(h.ids.view.innerHTML,/1 of 3 tasks matched/);assert.match(h.ids.view.innerHTML,/2\/3 · 67%/);
 assert.doesNotMatch(h.ids.view.innerHTML,/data-open-task=/);
});

test('Expand/collapse all affects visible filtered groups and Clear filters keeps grouping, collapse and sort',()=>{
 const h=harness(),a=plan('Implementing','Alpha'),b=plan('Implementing','Beta');setList(h,[a,b]);changeControl(h,'data-task-group','plan');h.api.ui.collapsedPlans['ledger/Beta']=true;
 h.api.ui.taskPlans=['ledger/Alpha'];h.api.ui.taskWork='Kiểm';h.api.sortTaskColumn('work','desc');
 h.api.handleViewAction(actionEvent('data-task-groups','collapse'));assert.equal(h.api.ui.collapsedPlans['ledger/Alpha'],true);assert.equal((h.ids.view.innerHTML.match(/data-open-task=/g)||[]).length,0);
 h.api.handleViewAction(actionEvent('data-task-groups','expand'));assert.equal(h.api.ui.collapsedPlans['ledger/Alpha'],false);assert.equal(h.api.ui.collapsedPlans['ledger/Beta'],true);
 h.api.handleViewAction(actionEvent('data-clear-filters',''));assert.equal(h.api.ui.taskPlans,null);assert.equal(h.api.ui.taskWork,'');assert.equal(h.api.ui.taskGroup,'plan');assert.equal(h.api.ui.taskSort.direction,'desc');assert.equal(h.api.ui.collapsedPlans['ledger/Beta'],true);assert.match(h.ids.top.innerHTML,/4 of 4 tasks/);
});

test('Grouped task sorting stays within plans while Plan sort reverses the group order',()=>{
 const h=harness(),a=plan('Implementing','Alpha'),b=plan('Implementing','Beta');a.steps=[{text:'Z',status:'doing'},{text:'A',status:'doing'}];b.steps=[{text:'M',status:'doing'}];setList(h,[b,a]);changeControl(h,'data-task-group','plan');h.api.sortTaskColumn('work','asc');
 const groups=h.api.groupedTaskRows(h.api.filteredTaskRows(h.api.taskRows([a,b])));assert.deepEqual(Array.from(groups,g=>g.plan.name),['Alpha','Beta']);assert.deepEqual(Array.from(groups[0].rows,r=>r.s.text),['A','Z']);assert.match(h.ids.view.innerHTML,/within each plan/);
 h.api.sortTaskColumn('plan','desc');assert.ok(h.ids.view.innerHTML.indexOf('data-task-group-toggle="ledger/Beta"')<h.ids.view.innerHTML.indexOf('data-task-group-toggle="ledger/Alpha"'));
});

test('F5 preserves groups, collapsed plans, sort, applied header filters and an open unapplied menu draft',async()=>{
 const h=harness({layout:'list'}),p=plan();setList(h,[p]);changeControl(h,'data-task-group','plan');h.api.ui.taskPlans=['ledger/'+p.name];h.api.ui.collapsedPlans['ledger/'+p.name]=true;h.api.sortTaskColumn('status','desc');h.api.openColumnMenu('work');changeControl(h,'data-column-field','unapplied text');
 h.context.fetch=async path=>{h.requests.push(path);return {ok:true,json:async()=>path==='/api/refresh'?{refreshedAt:new Date().toISOString()}:data([p])};};
 h.handlers.keydown({key:'F5',target:{tagName:'INPUT'},preventDefault(){}});await settle();
 assert.equal(h.api.ui.taskGroup,'plan');assert.equal(h.api.ui.collapsedPlans['ledger/'+p.name],true);assert.equal(h.api.ui.taskSort.column,'status');assert.equal(h.api.ui.taskPlans.length,1);assert.equal(h.api.ui.taskWork,'');assert.equal(h.api.columnMenu.value,'unapplied text');assert.match(h.ids.view.innerHTML,/value="unapplied text"/);assert.deepEqual(h.requests,['/api/refresh','/api/state']);
});

test('Outside pointer closes a draft without rerendering the clicked control, and view preferences survive reopen',()=>{
 const h=harness({layout:'list',taskGroup:'plan',collapsedPlans:{'ledger/Alpha':true},taskSort:{column:'plan',direction:'desc'},taskPlans:['old'],taskWork:'old'});setList(h,[plan('Implementing','Alpha')]);
 assert.equal(h.api.ui.taskGroup,'plan');assert.equal(h.api.ui.collapsedPlans['ledger/Alpha'],true);assert.equal(h.api.ui.taskSort.direction,'desc');assert.equal(h.api.ui.taskPlans,null);assert.equal(h.api.ui.taskWork,'');
 h.api.openColumnMenu('plan');const before=h.ids.view.innerHTML;h.handlers.pointerdown({target:{closest(){return null;}}});assert.equal(h.api.columnMenu,null);assert.equal(h.ids.view.innerHTML,before);
});

test('Plan Activity omits repeated context names while keeping actual people and global plan context',()=>{
 const h=harness(),p=plan('Testing','Example-plan');p.owner=p.name;p.decisions=[];p.questions=[];
 const j=data([p]);j.activity=[{repo:p.repo,plan:p.name,actor:p.name,kind:'done',text:'Checks passed',ts:new Date().toISOString()},{repo:p.repo,plan:p.name,actor:'Minh',kind:'decision',text:'Ship after review',ts:new Date().toISOString()}];h.api.setData(j);h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab='activity';h.api.render();
 assert.match(h.ids.top.innerHTML,/<h1>Example-plan<\/h1>/);assert.doesNotMatch(h.ids.top.innerHTML,/slot B · Example-plan|ledger · Example-plan/);
 assert.doesNotMatch(h.ids.view.innerHTML,/>Example-plan</);assert.match(h.ids.view.innerHTML,/class="msg context-actor"/);assert.match(h.ids.view.innerHTML,/<b>Minh<\/b>/);assert.doesNotMatch(h.ids.view.innerHTML,/\/icons\//);assert.match(h.ids.view.innerHTML,/Checks passed/);
 assert.equal(j.activity[0].actor,'Example-plan');
});

test('Starred plans are local persistent preferences scoped by repository and do not change execution data',()=>{
 const h=harness(),a=plan('Testing','Same'),b=plan('Testing','Same');b.repo='other';h.api.setData(data([a,b]));h.api.render();const before=JSON.stringify([a,b]),view=h.api.ui.view;
 h.api.handleViewAction(actionEvent('data-star-plan','ledger/Same'));assert.deepEqual(Array.from(h.api.navigation.starred),['ledger/Same']);assert.equal(h.api.ui.view,view);
 h.api.handleViewAction(actionEvent('data-plan-collection','starred'));assert.deepEqual(Array.from(h.api.sidebarPlans(),p=>p.repo),['ledger']);assert.match(h.ids['plan-sidebar'].innerHTML,/Unstar Same/);assert.doesNotMatch(h.ids['plan-sidebar'].innerHTML,/data-preview-plan="other\/Same"/);
 const re=harness({},JSON.parse(h.storage['wb-navigation']));re.api.setData(data([a,b]));re.api.render();assert.equal(re.api.navigation.section,'starred');assert.equal(re.api.navigation.starred.length,1);
 h.api.handleViewAction(actionEvent('data-star-plan','ledger/Same'));assert.match(h.ids['plan-sidebar'].innerHTML,/Star plans to keep them here/);assert.equal(h.api.navigation.starred.length,0);
 assert.equal(JSON.stringify([a,b]),before);assert.equal(h.requests.length,0);assert.ok(h.writes.includes('wb-navigation'));
});

test('Recent records deliberate plan opens, deduplicates them and ignores data refresh and tab switches',async()=>{
 const h=harness(),a=plan('Testing','Alpha'),b=plan('Testing','Beta');h.api.setData(data([a,b]));h.api.render();assert.equal(h.api.navigation.recent.length,0);
 h.api.openPlan('ledger/Alpha');h.api.openPlan('ledger/Beta');h.api.openPlan('ledger/Alpha');assert.deepEqual(Array.from(h.api.navigation.recent,r=>r.key),['ledger/Alpha','ledger/Beta']);
 const recent=JSON.stringify(h.api.navigation.recent);h.api.ui.tab='activity';h.api.render();
 h.context.fetch=async()=>({ok:true,json:async()=>data([b,a])});await h.api.get();assert.equal(JSON.stringify(h.api.navigation.recent),recent);
 h.api.ui.view='home';h.api.render();h.api.handleViewAction(actionEvent('data-plan-collection','recent'));assert.deepEqual(Array.from(h.api.sidebarPlans(),p=>p.name),['Alpha','Beta']);
 h.api.ui.view='plan:ledger/Beta';h.api.render();assert.equal(h.api.navigation.recent[0].key,'ledger/Beta');const stamp=h.api.navigation.recent[0].openedAt;h.api.render();assert.equal(h.api.navigation.recent[0].openedAt,stamp);
});

test('Recent stays bounded and unavailable plans do not appear but retain their saved stars',()=>{
 const ps=Array.from({length:15},(_,i)=>plan('Testing','Plan '+i)),h=harness({}, {starred:['missing/old','missing/old'],recent:[{key:'bad',openedAt:'invalid'}],section:'recent',collapsed:true});h.api.setData(data(ps));
 for(const p of ps)h.api.recordPlanVisit(p.repo+'/'+p.name);assert.equal(h.api.navigation.recent.length,12);assert.equal(h.api.navigation.starred.length,1);
 h.api.render();assert.equal(h.ids['plan-sidebar'].hidden,true);assert.equal(h.ids['sidebar-toggle'].getAttribute('aria-expanded'),'false');h.api.handleViewAction(actionEvent('data-sidebar-toggle',''));assert.equal(h.ids['plan-sidebar'].hidden,false);
 h.api.handleViewAction(actionEvent('data-plan-collection','starred'));assert.equal(h.api.sidebarPlans().length,0);assert.deepEqual(Array.from(h.api.navigation.starred),['missing/old']);
});










function disclosureTag(html,cls){return html.match(new RegExp('<details class="'+cls+'"[^>]*>'))?.[0] || '';}
function toggleDisclosure(h,tag,open){const key=tag.match(/data-plan-disclosure="([^"]+)"/)[1];h.handlers.toggle({target:{open,getAttribute(name){return name==='data-plan-disclosure'?key:name==='data-disclosure-auto' && tag.includes('data-disclosure-auto')?'1':null;}}});return key;}
function focusPlan(){
 const p=plan('Shipping','Focus');p.questions=[];p.decisions=[];p.goal='Candidates can read the public job details.';p.next='Verify the deployed public page.';
 p.steps=[{text:'Release the corrected public page',status:'doing',line:10,milestone:'M2'},{text:'Review the corrected behavior',status:'done',line:11,milestone:'M2'},{text:'Find the missing job data',status:'done',line:5,milestone:'M1'},{text:'Connect public job details',status:'done',line:6,milestone:'M1'}];
 p.milestones=[{id:'M1',title:'Job content',state:'done',steps:p.steps.slice(2)},{id:'M2',title:'Release and verify',state:'doing',summary:'RPC applied; waiting for frontend deployment.',steps:p.steps.slice(0,2)}];return p;
}











// ---------- First-run setup, Settings, empty and error states ----------
function settingsPayload(projects=[],extra={}){return {setupRequired:!projects.length,setupComplete:false,notifications:true,startWithWindows:false,startupManaged:true,dataDir:'C:\\Users\\me\\AppData\\Local\\agent-ops',configFile:'config.json',stateFile:'state.json',projectsOverridden:'',warning:'',readOnly:'',version:'v0.2.0',projects,...extra};}
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
 assert.match(card(),/Step 1 of 4/);assert.match(card(),/aria-current="step"/);assert.match(card(),/Set up later/,'setup can be skipped before any project exists');
 h.handlers.click({target:hit('[data-setup-next]')});assert.match(card(),/Add your projects/);assert.match(card(),/Choose folder…/);assert.match(card(),/Paste a path instead/);assert.match(card(),/Step 2 of 4/);
 assert.match(card(),/id="setup-next" data-setup-next disabled title="Add a project to continue"/);
 h.handlers.click({target:hit('[data-setup-next]')});assert.match(card(),/Add your projects/,'cannot continue without a project');
 h.handlers.keydown({key:'Enter',ctrlKey:true,preventDefault(){},target:{}});assert.match(card(),/Add your projects/,'Ctrl+Enter cannot skip the project step either');
 h.handlers.click({target:hit('[data-project-choose]',{'data-project-choose':'setup'})});await drain();
 assert.deepEqual(calls.filter(c=>c.method!=='GET').map(c=>c.method+' '+c.path),['POST /api/settings/pick-folder','POST /api/projects']);
 const added=calls.find(c=>c.path==='/api/projects');assert.equal(added.body.path,'C:\\work');assert.equal(added.headers['X-Agent-Ops'],'1');assert.equal(added.headers['Content-Type'],'application/json');
 assert.match(card(),/Folder · 2 repositories · 3 plans/);assert.match(card(),/C:\\work/);assert.match(card(),/Project added · 3 plans found/);assert.match(card(),/data-project-remove="p1"/);assert.match(card(),/aria-label="Remove work"/);
 h.handlers.keydown({key:'Enter',ctrlKey:true,preventDefault(){},target:{}});assert.match(card(),/Connect AI clients/);assert.match(card(),/Step 3 of 4/);
 h.handlers.click({target:hit('[data-setup-clients-skip]')});assert.match(card(),/A few preferences/);assert.match(card(),/Start with Windows/);assert.match(card(),/Desktop notifications/);assert.match(card(),/role="radiogroup" aria-label="Theme"/);assert.match(card(),/Open ledger/);
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
 assert.match(page(),/Start with Windows/);assert.match(page(),/Data folder/);assert.match(page(),/agent-ops/);assert.match(page(),/Single-key shortcuts/);assert.match(page(),/Run setup again/);
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

test('Settings About opens the logs folder and copies diagnostics through protected requests',async()=>{
 const h=harness();
 const calls=settingsServer(h,{'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],'POST /api/settings/open-folder':()=>[200,{opened:true}],'GET /api/diagnostics':()=>[200,{text:'Agent Ops diagnostics\nVersion: v0.2.1\n'}]});
 const copied=[];h.context.navigator={clipboard:{writeText:async text=>{copied.push(text);}}};
 h.api.openSettings('about');await drain();
 const page=()=>h.ids.settings.innerHTML;
 assert.match(page(),/Troubleshooting/);assert.match(page(),/Open logs folder/);assert.match(page(),/Copy diagnostics/);assert.match(page(),/never plan content, project names or paths/);assert.match(page(),/do not post them publicly/);
 h.handlers.click({target:hit('[data-open-logs]')});await drain();
 const open=calls.find(c=>c.path==='/api/settings/open-folder');
 assert.deepEqual(open.body,{target:'logs'});assert.equal(open.headers['X-Agent-Ops'],'1');
 h.handlers.click({target:hit('[data-copy-diagnostics]')});await drain();
 assert.deepEqual(copied,['Agent Ops diagnostics\nVersion: v0.2.1\n']);assert.match(page(),/Diagnostics copied/);
 h.context.navigator={};h.handlers.click({target:hit('[data-copy-diagnostics]')});await drain();
 assert.match(page(),/Copying is not available here/);
});

test('A crash marker shows a non-modal notice with Open logs and Dismiss',async()=>{
 const h=harness();h.ids.q.focus();
 const calls=settingsServer(h,{'POST /api/settings/open-folder':()=>[200,{opened:true}],'POST /api/diagnostics/dismiss-crash':()=>[200,{dismissed:true}],'GET /api/state':()=>[200,{...data([]),crash:{time:'2026-11-10T03:04:00Z',kind:'fatal',version:'v0.2.1',count:2}}]});
 await h.api.get();
 const el=h.ids.crash;
 assert.equal(el.hidden,false);assert.match(el.innerHTML,/closed unexpectedly last time/);assert.match(el.innerHTML,/2 errors/);assert.match(el.innerHTML,/Open logs/);assert.match(el.innerHTML,/Dismiss/);
 assert.equal(h.context.document.activeElement,h.ids.q,'the notice never takes focus');
 h.handlers.click({target:hit('[data-crash-logs]')});await drain();
 assert.deepEqual(calls.find(c=>c.path==='/api/settings/open-folder').body,{target:'logs'});assert.equal(el.hidden,false);
 h.handlers.click({target:hit('[data-crash-dismiss]')});await drain();
 const dismiss=calls.find(c=>c.path==='/api/diagnostics/dismiss-crash');
 assert.equal(dismiss.method,'POST');assert.equal(dismiss.headers['X-Agent-Ops'],'1');assert.equal(el.hidden,true);
 h.api.showCrash({time:'2026-11-10T03:04:00Z',kind:'panic',count:1});assert.match(el.innerHTML,/recovered from an internal error/);assert.doesNotMatch(el.innerHTML,/errors since/);
 h.api.showCrash(null);assert.equal(el.hidden,true);
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
 const h=harness(),p=plan();h.api.setData({...data([p]),state:{plans:[p],generatedAt:'2026-11-10T02:30:00Z'}});
 h.api.showError('Could not read project “work” (C:\\work): EACCES: permission denied');
 assert.equal(h.ids.error.hidden,false);assert.match(h.ids['error-text'].textContent,/project “work”/);assert.match(h.ids['error-detail'].textContent,/Showing the last successful check from \d\d:\d\d/);
 const calls=settingsServer(h,{'POST /api/refresh':()=>[200,{refreshedAt:'now'}],'/api/state':()=>[200,data([p])]});
 h.handlers.click({target:hit('[data-retry]')});await drain();assert.equal(calls[0].path,'/api/refresh');assert.equal(calls[0].headers['X-Agent-Ops'],'1');
 h.api.showWarnings(['Project “Gone” was not found at E:\\gone.']);assert.equal(h.ids.warnings.hidden,false);assert.match(h.ids.warnings.innerHTML,/Gone/);assert.match(h.ids.warnings.innerHTML,/data-settings-open="projects"/);
 h.api.showWarnings([]);assert.equal(h.ids.warnings.hidden,true);
});

test('Plans with the same repository folder in two projects keep separate keys and labels',()=>{
 const h=harness(),a={...plan(),project:'p1',projectName:'Work'},b={...plan(),project:'p2',projectName:'OSS'};
 h.api.setData(data([a,b]));
 assert.notEqual(h.api.key(a),h.api.key(b));assert.equal(h.api.planByKey('p2/ledger/'+a.name),b);
 assert.equal(h.api.planByKey('ledger/'+a.name),undefined,'ambiguous legacy links are not guessed');
 assert.equal(h.api.repoLabel(a),'ledger · Work');
 h.api.setData(data([a]));assert.equal(h.api.planByKey('ledger/'+a.name),a,'unique legacy link still opens');assert.equal(h.api.repoLabel(a),'ledger');
});

test('Stars, recent plans and collapsed groups saved before projects move to project-qualified keys',async()=>{
 const alpha={...plan('Implementing','Alpha'),project:'p1',projectName:'Work'},beta={...plan('Implementing','Beta'),project:'p1',projectName:'Work'};
 const dupA={...plan('Implementing','Dup'),project:'p1',projectName:'Work'},dupB={...plan('Implementing','Dup'),project:'p2',projectName:'OSS'};
 const now=new Date().toISOString();
 const h=harness(
  {collapsedPlans:{'ledger/Alpha':true,'ledger/Dup':true,'p1/ledger/Beta':false,'ledger/Gone':true},view:'plan:ledger/Alpha'},
  {starred:['ledger/Alpha','p1/ledger/Beta','ledger/Dup','ledger/Gone'],recent:[{key:'ledger/Beta',openedAt:now},{key:'p1/ledger/Beta',openedAt:now},{key:'ledger/Alpha',openedAt:now}]});
 h.context.fetch=async()=>({ok:true,json:async()=>data([alpha,beta,dupA,dupB])});
 await h.api.get();
 assert.deepEqual([...h.api.navigation.starred],['p1/ledger/Alpha','p1/ledger/Beta','ledger/Dup','ledger/Gone'],'unique legacy keys move; ambiguous and unknown keys stay');
 assert.deepEqual([...h.api.navigation.recent.map(r=>r.key)],['p1/ledger/Alpha','p1/ledger/Beta'],'recent entries that collapse onto one key are deduplicated, and the open plan is the latest visit');
 assert.deepEqual({...h.api.ui.collapsedPlans},{'p1/ledger/Alpha':true,'p1/ledger/Beta':false,'ledger/Dup':true,'ledger/Gone':true});
 assert.equal(h.api.ui.view,'plan:p1/ledger/Alpha');
 assert.deepEqual(JSON.parse(h.storage["wb-navigation"]).starred,[...h.api.navigation.starred],'migrated preferences are saved once');
 assert.equal(JSON.parse(h.storage['wb-ui']).collapsedPlans['p1/ledger/Alpha'],true);
 h.api.navigation.section='starred';
 assert.deepEqual([...h.api.sidebarPlans().map(p=>p.name)].sort(),['Alpha','Beta'],'the Starred collection preserves both migrated plans regardless of edit-time order');
 const writes=h.writes.length;await h.api.get();assert.equal(h.writes.length,writes,'a second state load does not rewrite preferences');
 h.api.togglePlanStar('p1/ledger/Alpha');
 assert.equal(h.api.navigation.starred.includes('p1/ledger/Alpha'),false,'clicking the star removes the migrated key instead of adding a second one');
 assert.equal(h.api.navigation.starred.includes('ledger/Alpha'),false);
});
test('Stored keys are left alone until the first state with plans arrives',async()=>{
 const h=harness({collapsedPlans:{'ledger/Alpha':true}},{starred:['ledger/Alpha'],recent:[]});
 h.context.fetch=async()=>({ok:true,json:async()=>data([])});await h.api.get();
 assert.deepEqual([...h.api.navigation.starred],['ledger/Alpha']);
 h.context.fetch=async()=>({ok:true,json:async()=>data([{...plan('Implementing','Alpha'),project:'p1'}])});await h.api.get();
 assert.deepEqual([...h.api.navigation.starred],['p1/ledger/Alpha']);assert.deepEqual({...h.api.ui.collapsedPlans},{'p1/ledger/Alpha':true});
});

// ---------- Read-only ledger and integrations ----------
const WRITE_PREFIXES=['/api/settings','/api/projects','/api/refresh','/api/updates/','/api/diagnostics','/api/integrations'];
function legacyPlan(){
 const p=plan('Implementing','Legacy');Object.assign(p,{agent:'Claude',agentSource:'report',executors:['Codex','Anti'],executorSource:'report',declaredExecutors:['Codex'],historicalExecutors:['Anti'],executionReports:[{result:'old'}],executionUpdatedAt:new Date().toISOString(),slot:{id:'B',by:'Linh'}});
 p.steps[0]=Object.assign(p.steps[0],{executors:['Codex'],executorSource:'report',sourceStatus:'doing',execution:{activeAgents:['Codex'],reportedAt:new Date().toISOString(),result:'Old run result'},executionHistory:{verifiedAt:'2026-11-07T00:00:00Z',summary:'Old verified history'}});
 return p;
}
function target(id,label,dir,extra={}){
 return {id,label,skillDir:dir,skillFile:dir+'\\task-plan\\SKILL.md',enabled:true,source:'detected',state:'not-installed',installedVersion:0,kept:false,instructions:{path:'',state:'none',line:'For substantial work, keep a plan.'},...extra};
}
function integrationsPayload(extra={}){
 return {skillVersion:2,
  targets:[target('aa11aa11','Claude Code','C:\\Users\\me\\.claude\\skills',{instructions:{path:'C:\\Users\\me\\.claude\\CLAUDE.md',state:'off',line:'x'}}),
   target('bb22bb22','Codex / shared skills','C:\\Users\\me\\.agents\\skills',{state:'modified',installedVersion:1,instructions:{path:'C:\\Users\\me\\.codex\\AGENTS.md',state:'outdated',line:'x'}}),
   target('cc33cc33','My tool','D:\\tools\\agent\\skills',{source:'custom',state:'missing-folder'})],
  suggestions:[{client:'gemini',label:'Antigravity / Gemini',skillDir:'C:\\Users\\me\\.gemini\\skills',instructionFile:'C:\\Users\\me\\.gemini\\GEMINI.md'}],
  migration:null,readOnly:'',...extra};
}

test('The script never calls the retired plan endpoints and every write sends X-Agent-Ops to an allowed endpoint',async()=>{
 assert.doesNotMatch(source,/\/api\/plans\//);assert.doesNotMatch(html,/X-Workboard/);assert.doesNotMatch(html,/workboard/i);assert.match(source,/'X-Agent-Ops'\]='1'/);
 const h=harness(),calls=[];h.api.setData(data([plan()]));
 h.context.fetch=async(path,options={})=>{calls.push({path,method:options.method || 'GET',headers:options.headers || {}});const body=path.startsWith('/api/integrations')?{...integrationsPayload(),added:'aa11aa11'}:path==='/api/settings/pick-folder'?{path:''}:path.startsWith('/api/settings') || path.startsWith('/api/projects')?settingsPayload([workProject],{setupRequired:false}):path==='/api/diagnostics'?{text:'x'}:data([plan()]);return {ok:true,status:200,json:async()=>body};};
 h.context.navigator={clipboard:{writeText:async()=>{}}};
 await h.api.refresh();await h.api.updateAction('skip');await h.api.updateAction('check');
 await h.api.saveSetting('settings','theme','dark');await h.api.addProject('settings','C:\\work');await h.api.toggleProject('p1',false);
 h.api.settingsUI.confirmRemove='p1';await h.api.removeProject('settings','p1');await h.api.chooseFolder('settings');await h.api.copyDiagnostics();await h.api.crashAction('dismiss');await h.api.crashAction('logs');
 await h.api.loadIntegrations();await h.api.integrationAction('aa11aa11','install');await h.api.addIntegration({skillDir:'D:\\x'});await h.api.changeTarget('aa11aa11',{enabled:false},'enable');
 h.api.integrationsUI.confirm='aa11aa11:drop';await h.api.dropTarget('aa11aa11');await h.api.chooseSkillsFolder();await h.api.finishSetup();
 const writes=calls.filter(c=>c.method!=='GET');
 assert.ok(writes.length>=16,'every write path was exercised');
 for(const c of writes){
  assert.equal(c.headers['X-Agent-Ops'],'1',c.method+' '+c.path);assert.equal(c.headers['X-Workboard'],undefined);
  assert.ok(WRITE_PREFIXES.some(prefix=>c.path.startsWith(prefix)),'unexpected write target '+c.path);
 }
 assert.ok(calls.every(c=>!c.path.startsWith('/api/plans')));
});

test('No drag, status control, agent or executor UI renders even when the state still carries old fields',()=>{
 const h=harness(),p=legacyPlan(),j=data([p]);
 j.activity=[{repo:p.repo,plan:p.name,actor:'Minh',agent:'Claude',executors:['Codex'],kind:'execution-report',text:'Ran tests',extra:'passed',ts:new Date().toISOString()},{repo:p.repo,plan:p.name,actor:'Minh',kind:'decision',text:'Keep it read-only',ts:new Date().toISOString()}];
 h.api.setData(j);
 const forbidden=/draggable|data-plan="|data-status=|status-select|data-column="|\/icons\/(codex|anti|claude)|agent-chip|>Coordinator<|Executed by|Not reported|Latest report|Verified history|Old run result|Old verified history|Agent workload|data-agent|data-executor|>Agent<|Linh/;
 for(const layout of ['list','summary']){h.api.ui.view='home';h.api.ui.layout=layout;h.api.ui.taskStatus='all';h.api.render();assert.doesNotMatch(h.ids.view.innerHTML+h.ids.top.innerHTML,forbidden,layout);}
 for(const tab of ['summary','checklist','activity']){h.api.ui.view='plan:'+p.repo+'/'+p.name;h.api.ui.tab=tab;h.api.render();assert.doesNotMatch(h.ids.view.innerHTML+h.ids.top.innerHTML,forbidden,tab);}
 assert.match(h.ids.top.innerHTML,/class="pill status-doing">Implementing</);
 assert.match(h.ids.view.innerHTML,/Keep it read-only/);
 assert.equal(h.api.owner(p),'Minh');
 for(const name of ['dragstart','dragover','drop','dragend'])assert.equal(h.handlers[name],undefined,name+' handler');
 assert.doesNotMatch(source,/savePlanField|moveStatus|agentChain|planRoles|executorBadges/);
});

const integrationCard=(page,id)=>page.match(new RegExp('<li class="project-card integration-card[^"]*" id="integration-'+id+'">[\\s\\S]*?</li>'))[0];

test('Settings Integrations lists folders with their state and matching actions, and posts them with the header',async()=>{
 const h=harness();let payload=integrationsPayload();
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],
  'GET /api/integrations':()=>[200,payload],
  'POST /api/integrations/aa11aa11/install':()=>{payload=integrationsPayload();payload.targets[0]={...payload.targets[0],state:'installed',installedVersion:2};payload.targets[1]={...payload.targets[1],state:'update-available',installedVersion:1};return [200,payload];},
  'POST /api/integrations/aa11aa11/remove':()=>[409,{error:'The skill file was modified locally. Review the diff first.'}],
  'POST /api/integrations/aa11aa11/instructions-on':()=>[200,payload],
 });
 h.api.openSettings('integrations');await drain();
 const page=()=>h.ids.settings.innerHTML,card=id=>integrationCard(page(),id);
 assert.match(page(),/data-settings-section="integrations"/);assert.match(page(),/Settings \/ Integrations/);
 assert.ok(page().indexOf('All projects')<page().indexOf('AI clients') && page().indexOf('AI clients')<page().indexOf('data-settings-section="about"'),'nav sits between Projects and About');
 assert.match(page(),/Add folder…/);assert.match(page(),/Paste a path instead/);
 assert.match(card('aa11aa11'),/Skill: Not installed/);assert.match(card('aa11aa11'),/data-integration-action="install"/);assert.match(card('aa11aa11'),/C:\\Users\\me\\.claude\\skills/);assert.match(card('aa11aa11'),/Detected/);
 assert.match(card('aa11aa11'),/Add a one-line reminder to CLAUDE\.md/);assert.doesNotMatch(card('aa11aa11'),/data-integration-instructions="aa11aa11" checked/);
 assert.match(card('aa11aa11'),/data-integration-enabled="aa11aa11" checked/);assert.match(card('aa11aa11'),/Edit path/);assert.match(card('aa11aa11'),/Remove from list/);
 assert.match(card('bb22bb22'),/tag is-danger">Modified locally/);assert.match(card('bb22bb22'),/View diff/);assert.match(card('bb22bb22'),/Keep mine/);assert.match(card('bb22bb22'),/data-integration-action="replace"/);assert.doesNotMatch(card('bb22bb22'),/data-integration-action="(install|remove)"/);
 assert.match(card('bb22bb22'),/reminder text is out of date/);assert.match(card('bb22bb22'),/Refresh reminder/);
 assert.match(card('cc33cc33'),/Missing folder/);assert.match(card('cc33cc33'),/Added by you/);assert.doesNotMatch(card('cc33cc33'),/data-integration-action=|data-integration-instructions/);
 // Suggestions are listed with Add, never added on their own.
 assert.match(page(),/Found on this computer/);assert.match(page(),/Suggestions only/);assert.match(page(),/Antigravity \/ Gemini[\s\S]*?data-integration-suggest="0"/);
 assert.equal(calls.filter(c=>c.method!=='GET').length,0,'opening the page posts nothing');
 // Replace asks first and says a backup is kept.
 h.handlers.click({target:hit('[data-integration-action]',{'data-integration-action':'replace','data-integration-target':'bb22bb22'})});
 assert.match(card('bb22bb22'),/Click again to replace/);assert.match(card('bb22bb22'),/backed up/);assert.equal(calls.filter(c=>c.method==='POST').length,0);
 h.handlers.click({target:hit('[data-integration-action]',{'data-integration-action':'install','data-integration-target':'aa11aa11'})});await drain();
 const install=calls.find(c=>c.path==='/api/integrations/aa11aa11/install');
 assert.equal(install.method,'POST');assert.equal(install.headers['X-Agent-Ops'],'1');assert.equal(install.headers['Content-Type'],'application/json');assert.deepEqual(install.body,{});
 assert.match(card('aa11aa11'),/Skill: Installed v2/);assert.match(card('aa11aa11'),/data-integration-action="remove"/);assert.match(card('aa11aa11'),/Remove skill/);assert.match(card('bb22bb22'),/Update available/);assert.match(card('bb22bb22'),/data-integration-action="update"/);
 h.handlers.click({target:hit('[data-integration-action]',{'data-integration-action':'remove','data-integration-target':'aa11aa11'})});assert.match(card('aa11aa11'),/Click again to remove/);assert.equal(calls.filter(c=>c.path.endsWith('/remove')).length,0);
 h.handlers.click({target:hit('[data-integration-action]',{'data-integration-action':'remove','data-integration-target':'aa11aa11'})});await drain();
 assert.equal(calls.filter(c=>c.path==='/api/integrations/aa11aa11/remove').length,1);assert.match(card('aa11aa11'),/role="alert">.*modified locally/);assert.doesNotMatch(card('bb22bb22'),/role="alert"/);
 h.api.settingsChange({checked:true,closest(s){return s==='[data-integration-instructions]'?{getAttribute:()=>'aa11aa11'}:null;}});await drain();
 assert.equal(calls.at(-1).path,'/api/integrations/aa11aa11/instructions-on');assert.equal(calls.at(-1).headers['X-Agent-Ops'],'1');
});

test('Folders are added from a suggestion, the native picker or a pasted path, with server errors inline',async()=>{
 const h=harness();let payload=integrationsPayload();
 const added={...integrationsPayload(),added:'dd44dd44'};added.targets=[...added.targets,target('dd44dd44','agent','D:\\tools\\agent\\skills',{source:'custom'})];
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],
  'GET /api/integrations':()=>[200,payload],
  'POST /api/settings/pick-folder':call=>[200,call.body.purpose==='skills'?{path:'D:\\tools\\agent\\skills'}:{path:'D:\\tools\\agent\\AGENTS.md'}],
  'POST /api/integrations':call=>call.body.skillDir==='D:\\work\\web'?[400,{error:'This folder is inside the project “web”. Choose the AI client\'s own skills folder, outside your repositories.'}]:[200,added],
 });
 h.api.openSettings('integrations');await drain();
 const page=()=>h.ids.settings.innerHTML;
 // Suggestion Add posts exactly the suggested folder and instruction file.
 h.handlers.click({target:hit('[data-integration-suggest]',{'data-integration-suggest':'0'})});await drain();
 let post=calls.filter(c=>c.path==='/api/integrations' && c.method==='POST').at(-1);
 assert.deepEqual(post.body,{skillDir:'C:\\Users\\me\\.gemini\\skills',instructionFile:'C:\\Users\\me\\.gemini\\GEMINI.md'});assert.equal(post.headers['X-Agent-Ops'],'1');
 assert.match(page(),/Added agent/);assert.match(integrationCard(page(),'dd44dd44'),/Added by you/);
 // Add folder… uses the native picker with the skills purpose.
 h.handlers.click({target:hit('[data-integration-choose]')});await drain();
 const pick=calls.filter(c=>c.path==='/api/settings/pick-folder');assert.deepEqual(pick.at(-1).body,{purpose:'skills'});
 assert.deepEqual(calls.filter(c=>c.path==='/api/integrations' && c.method==='POST').at(-1).body,{skillDir:'D:\\tools\\agent\\skills'});
 // Paste: an empty path is refused locally, a bad one shows the server's reason inline.
 h.handlers.click({target:hit('[data-integration-paste]')});assert.match(page(),/id="integration-path"/);assert.match(page(),/Instruction file \(optional\)/);
 const before=calls.length;h.handlers.click({target:hit('[data-integration-add]')});assert.equal(calls.length,before);assert.match(page(),/role="alert">.*Enter a full folder path/);
 h.api.settingsInput({closest(s){return s==='[data-integration-input]'?{getAttribute:()=>'path'}:null;},value:'D:\\work\\web'});
 h.handlers.click({target:hit('[data-integration-pick-file]')});await drain();
 assert.deepEqual(calls.filter(c=>c.path==='/api/settings/pick-folder').at(-1).body,{purpose:'instruction-file'});assert.match(page(),/value="D:\\tools\\agent\\AGENTS\.md"/);
 h.handlers.keydown({key:'Enter',preventDefault(){},target:{closest(s){return s==='[data-integration-input]'?{getAttribute:()=>'path'}:null;}}});await drain();
 post=calls.filter(c=>c.path==='/api/integrations' && c.method==='POST').at(-1);
 assert.deepEqual(post.body,{skillDir:'D:\\work\\web',instructionFile:'D:\\tools\\agent\\AGENTS.md'});
 assert.match(page(),/role="alert">.*inside the project “web”/);assert.match(page(),/aria-invalid="true"/);
});

test('Edit path, the enable switch and Remove from list send PATCH and DELETE; removing asks first',async()=>{
 const h=harness();let payload=integrationsPayload();
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],
  'GET /api/integrations':()=>[200,payload],
  'PATCH /api/integrations/aa11aa11':call=>call.body.skillDir==='C:\\bad'?[400,{error:'Neither this folder nor its parent folder exists.'}]:(payload=integrationsPayload(),payload.targets[0]={...payload.targets[0],...call.body},[200,payload]),
  'DELETE /api/integrations/cc33cc33':()=>{payload=integrationsPayload();payload.targets=payload.targets.slice(0,2);return [200,payload];},
 });
 h.api.openSettings('integrations');await drain();
 const page=()=>h.ids.settings.innerHTML;
 h.handlers.click({target:hit('[data-integration-edit]',{'data-integration-edit':'aa11aa11'})});
 assert.match(page(),/id="integration-edit-path"[^>]*value="C:\\Users\\me\\.claude\\skills"/);assert.match(page(),/id="integration-edit-label"[^>]*value="Claude Code"/);
 h.api.settingsInput({closest(s){return s==='[data-integration-input]'?{getAttribute:()=>'editPath'}:null;},value:'C:\\bad'});
 h.handlers.click({target:hit('[data-integration-save]')});await drain();
 let patch=calls.filter(c=>c.method==='PATCH').at(-1);assert.deepEqual(patch.body,{skillDir:'C:\\bad'});assert.equal(patch.headers['X-Agent-Ops'],'1');
 assert.match(integrationCard(page(),'aa11aa11'),/role="alert">.*Neither this folder/);assert.match(page(),/id="integration-edit-path"/,'the form stays open after an error');
 h.api.settingsInput({closest(s){return s==='[data-integration-input]'?{getAttribute:()=>'editLabel'}:null;},value:'Claude (work)'});
 h.api.settingsInput({closest(s){return s==='[data-integration-input]'?{getAttribute:()=>'editPath'}:null;},value:'C:\\Users\\me\\.claude\\skills'});
 h.handlers.click({target:hit('[data-integration-save]')});await drain();
 assert.deepEqual(calls.filter(c=>c.method==='PATCH').at(-1).body,{label:'Claude (work)'});assert.doesNotMatch(page(),/id="integration-edit-path"/);assert.match(page(),/<strong>Claude \(work\)<\/strong>/);
 h.api.settingsChange({checked:false,closest(s){return s==='[data-integration-enabled]'?{getAttribute:()=>'aa11aa11'}:null;}});await drain();
 assert.deepEqual(calls.filter(c=>c.method==='PATCH').at(-1).body,{enabled:false});
 assert.match(integrationCard(page(),'aa11aa11'),/tag is-off">Off/);assert.doesNotMatch(integrationCard(page(),'aa11aa11'),/data-integration-action=/);
 h.handlers.click({target:hit('[data-integration-drop]',{'data-integration-drop':'cc33cc33'})});
 assert.match(integrationCard(page(),'cc33cc33'),/Click again to remove/);assert.match(integrationCard(page(),'cc33cc33'),/Files on disk are not changed/);assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
 h.handlers.click({target:hit('[data-integration-drop]',{'data-integration-drop':'cc33cc33'})});await drain();
 assert.equal(calls.filter(c=>c.method==='DELETE')[0].path,'/api/integrations/cc33cc33');assert.doesNotMatch(page(),/id="integration-cc33cc33"/);
});

test('Integrations renders an escaped diff, the review-by-hand checklist and read-only mode',async()=>{
 const h=harness();let payload=integrationsPayload({migration:{at:'2026-11-10T03:00:00Z',backup:'C:\\Users\\me\\AppData\\Local\\agent-ops\\backup',checklist:[{file:'C:\\Users\\me\\.claude\\CLAUDE.md',line:12,text:'Report to the <old> board'}],kept:['C:\\Users\\me\\.codex\\AGENTS.md (modified locally)']}});
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],
  'GET /api/integrations':()=>[200,payload],
  'GET /api/integrations/bb22bb22/diff':()=>[200,{path:'C:\\Users\\me\\.agents\\skills\\task-plan\\SKILL.md',identical:false,lines:[{op:' ',text:'# task-plan'},{op:'-',text:'my <script>edit</script>'},{op:'+',text:'version: 2'}]}],
  'POST /api/integrations/bb22bb22/keep':()=>{payload=integrationsPayload();payload.targets[1]={...payload.targets[1],kept:true};return [200,payload];},
 });
 h.api.openSettings('integrations');await drain();
 const page=()=>h.ids.settings.innerHTML;
 assert.match(page(),/Review by hand/);assert.match(page(),/CLAUDE\.md:12/);assert.match(page(),/Report to the &lt;old&gt; board/);assert.match(page(),/modified locally\)/);assert.match(page(),/agent-ops\\backup/);
 h.handlers.click({target:hit('[data-integration-diff]',{'data-integration-diff':'bb22bb22'})});await drain();
 assert.equal(calls.find(c=>c.path==='/api/integrations/bb22bb22/diff').method,'GET');
 assert.match(page(),/class="diff-panel"/);assert.match(page(),/diff-line is-del"><span class="diff-op" aria-hidden="true">-<\/span>[\s\S]*?my &lt;script&gt;edit&lt;\/script&gt;/);assert.match(page(),/diff-line is-add"><span class="diff-op" aria-hidden="true">\+<\/span>[\s\S]*?version: 2/);assert.doesNotMatch(page(),/<script>/);
 assert.match(page(),/Hide diff/);
 h.handlers.click({target:hit('[data-integration-action]',{'data-integration-action':'keep','data-integration-target':'bb22bb22'})});await drain();
 assert.equal(calls.at(-1).path,'/api/integrations/bb22bb22/keep');assert.match(page(),/your version is kept/);assert.doesNotMatch(page(),/class="diff-panel"/,'the diff closes after an action');assert.doesNotMatch(page(),/Keep mine/);
 payload=integrationsPayload({readOnly:'Another Agent Ops window is changing these files.'});h.api.integrationsUI.data=null;await h.api.loadIntegrations();
 assert.match(page(),/callout-danger" role="alert">[\s\S]*?Another Agent Ops window/);
 for(const button of page().match(/<button[^>]*data-integration-(action|drop|edit|suggest|choose)[^>]*>/g))assert.match(button,/ disabled/);
 const before=calls.length;await h.api.integrationAction('aa11aa11','install');await h.api.addIntegration({skillDir:'D:\\x'});assert.equal(calls.length,before,'read-only mode posts nothing');
 h.api.settingsInput({id:'settings-search',value:'orca'});h.flush();assert.match(page(),/<h3>Integrations<\/h3>/);assert.match(page(),/Codex/);
});

test('Setup lists suggestions and folders needing the skill unchecked, and adds and installs only the checked ones',async()=>{
 const h=harness();let payload=integrationsPayload();payload.targets[1]={...payload.targets[1],state:'installed',installedVersion:2};
 const added={...payload,added:'ee55ee55'};
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload([workProject])],
  'GET /api/integrations':()=>[200,payload],
  'POST /api/integrations':()=>[200,added],
  'POST /api/integrations/ee55ee55/install':()=>[200,payload],
  'POST /api/integrations/aa11aa11/install':()=>[200,payload],
 });
 h.api.setData({...data([]),setupRequired:true,projects:[workProject]});h.api.syncSetup();await drain();
 const card=()=>h.ids.onboarding.innerHTML;
 h.handlers.click({target:hit('[data-setup-next]')});assert.match(card(),/Add your projects/);
 h.handlers.click({target:hit('[data-setup-next]')});await drain();
 assert.match(card(),/Connect AI clients/);assert.match(card(),/Step 3 of 4/);assert.match(card(),/aria-label="Step 3: Connect AI clients"/);
 assert.match(card(),/id="setup-client-s0" data-setup-client="s0">/);assert.match(card(),/Antigravity \/ Gemini/);assert.match(card(),/Found on this computer/);
 assert.match(card(),/id="setup-client-t-aa11aa11" data-setup-client="t-aa11aa11">/);assert.doesNotMatch(card(),/bb22bb22|cc33cc33/,'installed and missing folders are not offered');
 assert.doesNotMatch(card(),/ checked>/,'nothing is pre-checked');
 h.handlers.click({target:hit('[data-setup-next]')});await drain();
 assert.equal(calls.filter(c=>c.method==='POST').length,0,'continuing with nothing checked posts nothing');assert.match(card(),/A few preferences/);
 h.handlers.click({target:hit('[data-setup-back]')});await drain();assert.match(card(),/Connect AI clients/);
 h.api.settingsChange({checked:true,closest(s){return s==='[data-setup-client]'?{getAttribute:()=>'s0'}:null;}});assert.match(card(),/data-setup-client="s0" checked/);
 h.handlers.click({target:hit('[data-setup-next]')});await drain();
 const posts=calls.filter(c=>c.method==='POST');
 assert.deepEqual(posts.map(c=>c.path),['/api/integrations','/api/integrations/ee55ee55/install']);assert.deepEqual(posts[0].body,{skillDir:'C:\\Users\\me\\.gemini\\skills',instructionFile:'C:\\Users\\me\\.gemini\\GEMINI.md'});
 for(const p of posts)assert.equal(p.headers['X-Agent-Ops'],'1');
 assert.match(card(),/A few preferences/);assert.match(card(),/Step 4 of 4/);
});

test('Skipping the Connect AI clients step posts nothing and failed installs stay on the step with the reason',async()=>{
 const h=harness();const payload=integrationsPayload();
 const calls=settingsServer(h,{
  'GET /api/settings':()=>[200,settingsPayload([workProject])],
  'GET /api/integrations':()=>[200,payload],
  'POST /api/integrations/aa11aa11/install':()=>[409,{error:'The skill file changed on disk.'}],
 });
 h.api.setData({...data([]),setupRequired:true,projects:[workProject]});h.api.syncSetup();await drain();
 h.api.setupGo(2);await drain();const card=()=>h.ids.onboarding.innerHTML;
 h.api.settingsChange({checked:true,closest(s){return s==='[data-setup-client]'?{getAttribute:()=>'t-aa11aa11'}:null;}});
 h.handlers.click({target:hit('[data-setup-clients-skip]')});await drain();
 assert.equal(calls.filter(c=>c.method!=='GET').length,0,'Skip posts nothing');assert.match(card(),/A few preferences/);
 h.api.setupGo(2);await drain();h.api.settingsChange({checked:true,closest(s){return s==='[data-setup-client]'?{getAttribute:()=>'t-aa11aa11'}:null;}});
 h.handlers.keydown({key:'Enter',ctrlKey:true,preventDefault(){},target:{}});await drain();
 assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.match(card(),/Connect AI clients/);assert.match(card(),/role="alert">.*Claude Code: The skill file changed on disk/);
 h.handlers.keydown({key:'Escape',preventDefault(){},target:{}});assert.match(card(),/Skip setup\?/,'Escape still asks before skipping setup');
});

test('Integrations shows unfinished migration errors, escaped, with the next retry time',async()=>{
 const h=harness();const payload=integrationsPayload({migration:{at:'2026-11-10T03:00:00Z',done:false,attempts:1,nextRetryAt:'2026-11-10T03:15:00Z',backup:'D:/b',errors:['D:/home/.claude/settings.json: the file changed <while> editing'],checklist:[],kept:[]}});
 settingsServer(h,{'GET /api/settings':()=>[200,settingsPayload([workProject],{setupRequired:false})],'GET /api/integrations':()=>[200,payload]});
 h.api.openSettings('integrations');await drain();
 const page=h.ids.settings.innerHTML;
 assert.match(page,/Review by hand/);assert.match(page,/not finished/);assert.match(page,/datetime="2026-11-10T03:15:00Z"/);
 assert.match(page,/role="alert"><li><span>D:\/home\/\.claude\/settings\.json: the file changed &lt;while&gt; editing/);assert.doesNotMatch(page,/<while>/);
});

test('Ledger routes replace retired layouts and every plan opens in the workspace',()=>{
 const h=harness({layout:'timeline'}),p=focusPlan();h.api.setData(data([p]));h.api.render();
 assert.equal(h.api.ui.layout,'summary');assert.match(h.ids.nav.innerHTML,/Overview/);
 assert.doesNotMatch(h.ids.nav.innerHTML,/>Board<|>Timeline<|>Summary</);
 h.api.openPlan('ledger/Focus');assert.equal(h.api.ui.view,'plan:ledger/Focus');
 assert.match(h.ids.top.innerHTML,/Goal/);assert.match(h.ids.top.innerHTML,/3\/4/);
 assert.doesNotMatch(html,/<dialog[^>]+quick-plan|data-inspector-toggle/);
 assert.equal(h.requests.length,0);
});

test('Plan milestones keep source order, summaries, completed children and loose steps exactly once',()=>{
 const h=harness(),p=focusPlan();p.steps.push({text:'Loose source task',status:'todo',line:30});
 h.api.setData(data([p]));h.api.openPlan('ledger/Focus');const page=h.ids.view.innerHTML;
 assert.ok(page.indexOf('Job content')<page.indexOf('Release and verify'));
 assert.equal((page.match(/RPC applied;/g)||[]).length,1);
 for(const s of p.steps)assert.equal((page.match(new RegExp(s.text,'g'))||[]).length,1,s.text);
 const milestones=Array.from(page.matchAll(/<details class="ledger-milestone"[^>]*>/g),m=>m[0]);
 assert.doesNotMatch(milestones[0],/ open/);assert.match(milestones[1],/ open/);
 assert.match(page,/aria-label="Milestone progress for M2"[^>]+aria-valuetext="1 of 2 steps"/);
 assert.match(page,/Other steps/);
});

test('Blocked and waiting reasons precede Next and source state never hides unfinished children',()=>{
 for(const state of ['Blocked','Waiting for owner']){
  const h=harness(),p=focusPlan();p.status=state+' - API <unavailable>';p.milestones[1].state='done';
  h.api.setData(data([p]));h.api.openPlan('ledger/Focus');
  assert.ok(h.ids.top.innerHTML.indexOf('API &lt;unavailable&gt;')<h.ids.top.innerHTML.indexOf('<strong>Next'));
  assert.match(h.ids.view.innerHTML,/Release the corrected public page/);
  assert.match(h.ids.view.innerHTML.match(/<details class="ledger-milestone"[^>]*M2[^>]*>/)[0],/ open/);
  assert.equal(p.milestones[1].state,'done');assert.equal(p.steps[0].status,'doing');
 }
});

test('Milestone progress accepts the optional contract and falls back conservatively',()=>{
 const h=harness(),m={steps:[{status:'done'},{status:'todo'}],progress:{done:4,total:7}};
 assert.deepEqual({...h.api.milestoneProgress(m)},{done:4,total:7});
 for(const progress of [null,{done:-1,total:2},{done:3,total:2},{done:1.5,total:2}]){
  m.progress=progress;assert.deepEqual({...h.api.milestoneProgress(m)},{done:1,total:2});
 }
});

test('Milestone collapse survives refresh and a changed revision updates its summary',async()=>{
 const h=harness(),p=focusPlan();h.api.setData(data([p]));h.api.openPlan('ledger/Focus');
 const tag=Array.from(h.ids.view.innerHTML.matchAll(/<details class="ledger-milestone"[^>]*>/g),m=>m[0])[1];
 const token=toggleDisclosure(h,tag,false),newer=structuredClone(p);newer.revision='b'.repeat(64);newer.milestones[1].summary='Fresh source summary';
 h.context.fetch=async()=>({ok:true,json:async()=>data([newer])});await h.api.get();
 assert.equal(h.api.ui.planDetails[token],false);assert.match(h.ids.view.innerHTML,/Fresh source summary/);
 assert.doesNotMatch(Array.from(h.ids.view.innerHTML.matchAll(/<details class="ledger-milestone"[^>]*>/g),m=>m[0])[1],/ open/);
});

test('Revision refresh retains unchanged plan objects and cached rows, updates only changed content',()=>{
 const h=harness(),a=plan('Testing','Alpha'),b=plan('Testing','Beta');
 h.api.acceptState(data([a,b]));h.api.render();const before=h.api.planByKey('ledger/Alpha'),cached=h.api.planCache.get('overview|ledger/Alpha');
 const newer=structuredClone(b);newer.revision='b'.repeat(64);newer.next='New next step';
 h.api.acceptState(data([structuredClone(a),newer]));h.api.render();
 assert.equal(h.api.planByKey('ledger/Alpha'),before);assert.equal(h.api.planCache.get('overview|ledger/Alpha'),cached);
 assert.match(h.ids.view.innerHTML,/New next step/);assert.notEqual(h.api.planByKey('ledger/Beta').revision,b.revision);
 h.api.acceptState(data([newer]));h.api.render();assert.equal(h.api.planCache.has('overview|ledger/Alpha'),false);
});

test('Identical refresh performs no region HTML writes and preserves focus and scroll',async()=>{
 const h=harness(),p=focusPlan();h.api.acceptState(data([p]));h.api.openPlan('ledger/Focus');
 const writes={};for(const id of ['view','nav','top','tabs','plan-sidebar']){
  let value=h.ids[id].innerHTML;writes[id]=0;Object.defineProperty(h.ids[id],'innerHTML',{get:()=>value,set(v){writes[id]++;value=v;}});
 }
 h.ids.q.focus();h.ids.q.setSelectionRange(2,4);h.ids.view.scrollTop=125;h.ids.view.scrollLeft=35;
 h.context.fetch=async()=>({ok:true,json:async()=>data([structuredClone(p)])});await h.api.get();
 assert.deepEqual(writes,{view:0,nav:0,top:0,tabs:0,'plan-sidebar':0});
 assert.equal(h.context.document.activeElement,h.ids.q);assert.equal(h.ids.q.selectionStart,2);
 assert.equal(h.ids.view.scrollTop,125);assert.equal(h.ids.view.scrollLeft,35);
});

test('Missing new fields, malformed entries and diagnostics cannot break neighboring plans',async()=>{
 const h=harness(),good=plan('Testing','Good'),bad={repo:'ledger',name:'Malformed',revision:'bad',status:'Blocked',diagnostics:[{message:'Invalid <header>'},'Missing marker']};
 h.context.fetch=async()=>({ok:true,json:async()=>({state:{plans:[bad,null,good]},now:new Date().toISOString()})});
 assert.ok(await h.api.get());assert.match(h.ids.view.innerHTML,/Good/);assert.match(h.ids.view.innerHTML,/Malformed/);
 assert.match(h.ids.view.innerHTML,/Invalid &lt;header&gt;/);assert.doesNotMatch(h.ids.view.innerHTML,/<header>/);
 h.api.openPlan('ledger/Malformed');assert.match(h.ids.view.innerHTML,/No milestones or steps recorded/);assert.match(h.ids.top.innerHTML,/Plan warning \(2\)/);
 assert.equal(h.ids.error.hidden,true);
});

test('Nested-only steps and duplicated flat/nested transport entries render once',()=>{
 const h=harness(),nested={repo:'ledger',name:'Nested',status:'Testing',milestones:[{id:'M1',title:'First',steps:[{text:'Nested task',status:'doing'}]}]};
 h.api.acceptState(data([nested]));h.api.openPlan('ledger/Nested');assert.equal(h.api.planByKey('ledger/Nested').steps.length,1);
 assert.equal((h.ids.view.innerHTML.match(/Nested task/g)||[]).length,1);
 nested.steps=[{text:'Nested task',status:'doing'}];h.api.acceptState(data([nested]));h.api.render();
 assert.equal((h.ids.view.innerHTML.match(/Nested task/g)||[]).length,1);
});

test('Sidebar, Overview and grouped List keep duplicate names under separate projects and repos',()=>{
 const h=harness(),a=plan('Testing','Same'),b=plan('Testing','Same');
 a.project='one';a.projectName='Project One';b.project='two';b.projectName='Project Two';
 const j=data([a,b]);j.state.repos=[{project:'one',name:'ledger',worktrees:[{path:'D:/isolated/<tree>',branch:'feat/<branch>'}]}];
 h.api.acceptState(j);h.api.render();
 for(const page of [h.ids.view.innerHTML,h.ids['plan-sidebar'].innerHTML]){
  assert.match(page,/Project One/);assert.match(page,/Project Two/);assert.match(page,/one\/ledger\/Same/);assert.match(page,/two\/ledger\/Same/);
  assert.match(page,/feat\/&lt;branch&gt;/);assert.match(page,/D:\/isolated\/&lt;tree&gt;/);
 }
 h.api.switchLayout('list');h.api.ui.taskStatus='all';h.api.render();assert.match(h.ids.view.innerHTML,/ledger-list-project/);assert.match(h.ids.view.innerHTML,/ledger-list-repo/);
 assert.ok(h.ids.view.innerHTML.indexOf('Project One')<h.ids.view.innerHTML.indexOf('one/ledger/Same'));
});

test('Attention counts plans consistently when entered from List and displays its reason',()=>{
 const h=harness(),p=plan('Blocked - Source blocker');p.questions=[];h.api.setData(data([p]));h.api.ui.layout='list';h.api.ui.view='waiting';h.api.render();
 assert.match(h.ids.top.innerHTML,/1 of 1 plans/);assert.match(h.ids.view.innerHTML,/Source blocker/);assert.doesNotMatch(h.ids.view.innerHTML,/task-list-table/);
});

test('Routes write and restore views, sections, filters, tabs, encoded keys and source lines',()=>{
 const h=harness({}),p=focusPlan();p.project='project #1';p.name='Plan / ? # ü';h.api.setData(data([p]));h.api.jumpHash();
 h.api.openPlan(h.api.key(p));assert.equal(h.context.location.hash,'#/plan/'+encodeURIComponent(h.api.key(p))+'/summary');
 h.handlers.click(actionEvent('data-tab','activity'));assert.match(h.context.location.hash,/\/activity$/);
 h.api.switchLayout('list');h.api.ui.taskStatus='blocked';h.api.ui.q='check #1';h.api.render();
 const saved=h.context.location.hash;assert.match(saved,/#\/list\?q=check\+%231&status=blocked&group=plan/);
 h.api.openArchive();assert.equal(h.context.location.hash,'#/archive');h.context.location.hash=saved;h.handlers.popstate();
 assert.equal(h.api.ui.layout,'list');assert.equal(h.api.ui.taskStatus,'blocked');assert.equal(h.api.ui.q,'check #1');
 h.context.location.hash='#/plan/'+encodeURIComponent(h.api.key(p))+'/summary?step=L11';h.handlers.hashchange();
 assert.equal(h.api.focusedTask(h.api.planByKey(h.api.key(p))).line,11);assert.match(h.ids.view.innerHTML,/task-focused/);
});

test('Settings sections and setup have routes and returning to a view closes panels',()=>{
 const h=harness({});h.api.jumpHash();h.api.openSettings('integrations');assert.equal(h.context.location.hash,'#/settings/integrations');
 h.api.openSettings('projects');assert.equal(h.context.location.hash,'#/settings/projects');h.api.closeSettings();assert.equal(h.context.location.hash,'#/');
 h.context.location.hash='#/setup';h.handlers.hashchange();assert.equal(h.api.setup.open,true);
 h.context.location.hash='#/attention';h.handlers.popstate();assert.equal(h.api.setup.open,false);assert.equal(h.api.settingsUI.open,false);assert.equal(h.api.ui.view,'waiting');
});

test('Unavailable and malformed deep links preserve a readable ledger and do not silently select another plan',()=>{
 const h=harness({});h.api.setData(data([plan('Testing','Good')]));h.context.location.hash='#/plan/missing%2Fplan/summary';h.handlers.hashchange();
 assert.match(h.ids.view.innerHTML,/Plan unavailable/);assert.equal(h.api.ui.view,'plan:missing/plan');
 h.context.location.hash='#/plan/%broken/summary';assert.doesNotThrow(()=>h.handlers.hashchange());assert.match(h.ids.view.innerHTML,/Plan unavailable/);
});

test('Stage glyphs remain static, labelled and independent of completion in both themes',()=>{
 const h=harness();for(const [status,tone] of [['Planning','todo'],['Implementing','doing'],['Fixing review','doing'],['Shipping','doing'],['Reviewing','review'],['Testing','review'],['Waiting for CI','review'],['Waiting for owner','waiting'],['Blocked','blocked'],['Done','done']]){
  assert.equal(h.api.statusTone(status),tone);assert.match(h.api.statusGlyph(status),new RegExp('aria-label="'+status+'"'));assert.doesNotMatch(h.api.statusGlyph(status),/spin/);
 }
 assert.match(html,/summary:focus-visible/);assert.match(html,/forced-colors:active/);assert.match(html,/prefers-reduced-motion:\s*reduce/);
 assert.doesNotMatch(html,/@font-face|rel="preload"[^>]+font/);
});

const edgePath=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
test('Native DOM preserves unaffected plan nodes, focus, caret, scroll, disclosures and browser history', {skip:!edgePath,timeout:60000},()=>{
 const fixture=mkdtempSync(join(fileURLToPath(new URL('.',import.meta.url)),'.test-ledger-ui-'));
 try{
  const payload=data(Array.from({length:28},(_,i)=>({...plan('Testing','Plan '+i),project:'p1',projectName:'Project One',mtime:new Date(Date.now()-i*60000).toISOString()})));
  const detail=focusPlan();detail.steps.push(...Array.from({length:30},(_,i)=>({status:'todo',text:'Loose task '+i,line:50+i})));
  payload.state.plans[0].diagnostics=[{message:'Sample plan warning'}];
  payload.state.plans.push(detail);
  const check=`(async function(){
    var status=document.createElement('pre');status.id='ledger-dom-result';document.body.appendChild(status);var results=[],assert=function(condition,message){if(!condition)throw Error(message);results.push(message);status.textContent=JSON.stringify({ok:false,error:'Pending after '+message,results:results});};
    window.fetch=async function(){return {ok:true,json:async function(){return {setupRequired:false,setupComplete:true,projects:[],theme:'system'};}};};localStorage.clear();
    ui.view='home';ui.layout='summary';ui.q='';navigation.section='all';navigation.collapsed=false;acceptState(${JSON.stringify(payload)});jumpHash();render();
    var row=document.querySelector('.ledger-table-row[data-render-key="p1/ledger/Plan 0"]'),side=document.querySelector('.sidebar-plan[data-render-key="p1/ledger/Plan 0"]'),button=row.querySelector('button');
    var warning=row.querySelector('details');warning.open=true;button.focus();var observer=new MutationObserver(function(){});observer.observe(row,{subtree:true,attributes:true,childList:true,characterData:true});
    var changed=JSON.parse(JSON.stringify(D));changed.state.plans[1].revision='b'.repeat(64);changed.state.plans[1].next='Updated only second plan';changed.state.plans[1].mtime=new Date(Date.now()+60000).toISOString();acceptState(changed);render();
    assert(row===document.querySelector('.ledger-table-row[data-render-key="p1/ledger/Plan 0"]'),'unaffected plan node retained');
    assert(side===document.querySelector('.sidebar-plan[data-render-key="p1/ledger/Plan 0"]'),'unaffected sidebar node retained');
    assert(observer.takeRecords().length===0,'unaffected plan has zero DOM mutations');observer.disconnect();
    assert(warning.open,'open diagnostic stays open across sibling refresh');
    assert(document.activeElement===button,'focus survives reordered sibling');assert(document.querySelector('#view').textContent.includes('Updated only second plan'),'changed revision updates visible row');
    openPlan('ledger/Focus');var summary=document.querySelectorAll('.ledger-milestone>summary')[1],disclosure=summary.parentNode;summary.focus();disclosure.open=false;await new Promise(function(r){setTimeout(r,30);});
    var token=disclosure.getAttribute('data-plan-disclosure');assert(ui.planDetails[token]===false,'native disclosure persists explicit collapse');
    var changed=JSON.parse(JSON.stringify(D));changed.state.plans[0].revision='c'.repeat(64);acceptState(changed);render();assert(document.activeElement===summary,'milestone focus survives unrelated revision');assert(!disclosure.open,'collapsed milestone stays collapsed');
    var input=$('q');input.value='task';ui.q='task';input.focus();input.setSelectionRange(1,3);render();assert(document.activeElement===input,'search DOM node and focus retained');assert(input.selectionStart===1 && input.selectionEnd===3,'search caret retained');
    ui.q='';input.value='';render();var view=$('view');view.style.height='130px';view.style.flex='none';view.scrollTop=100;var top=view.scrollTop;render();assert(top>0 && view.scrollTop===top,'detail scroll retained');
    var tab=$('plan-tab-summary');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert(ui.tab==='activity' || ui.tab==='questions','tabs respond to arrow keys');assert(document.activeElement.getAttribute('role')==='tab','tab focus follows selection');
    openPlan('ledger/Focus');var planURL=location.hash;switchLayout('list');var listURL=location.hash;
    await new Promise(function(resolve){window.addEventListener('popstate',resolve,{once:true});history.back();});await new Promise(function(r){setTimeout(r,10);});assert(location.hash===planURL && ui.view==='plan:ledger/Focus','Back restores plan route');
    await new Promise(function(resolve){window.addEventListener('popstate',resolve,{once:true});history.forward();});await new Promise(function(r){setTimeout(r,10);});assert(location.hash===listURL && ui.layout==='list','Forward restores list route');
    location.hash='#/plan/ledger%2FFocus/summary?step=L11';await new Promise(function(r){setTimeout(r,30);});assert(document.querySelector('#task-line-11').classList.contains('task-focused'),'source-line deep link highlights the exact task');assert(document.querySelectorAll('[id="task-line-11"]').length===1,'step DOM IDs stay unique');
    applyTheme('dark');assert(getComputedStyle(document.documentElement).colorScheme==='dark','dark theme applied');applyTheme('light');assert(getComputedStyle(document.documentElement).colorScheme==='light','light theme applied');
    var report=document.getElementById('ledger-dom-result');report.textContent=JSON.stringify({ok:true,results:results});document.body.appendChild(report);
  })().catch(function(e){var report=document.getElementById('ledger-dom-result');report.textContent=JSON.stringify({ok:false,error:e.stack});document.body.appendChild(report);});`;
  const page=html.replace('jumpHash(); get(); connect(); initUpdates(); loadSettings();',check);
  new vm.Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const pagePath=join(fixture,'index.html');writeFileSync(pagePath,page);
  const run=spawnSync(edgePath,['--headless=new','--disable-gpu','--enable-logging=stderr','--no-first-run','--no-default-browser-check','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND','--user-data-dir='+join(fixture,'profile'),'--virtual-time-budget=5000','--dump-dom',pathToFileURL(pagePath).href],{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:8<<20});
  assert.equal(run.error,undefined,String(run.error));assert.equal(run.status,0,run.stderr);
  const report=run.stdout.match(/<pre id="ledger-dom-result">([\s\S]*?)<\/pre>/);
  assert.ok(report,'Edge did not complete the isolated DOM checks: '+run.stderr.slice(-1500));
  const result=JSON.parse(report[1].replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
  assert.equal(result.ok,true,result.error);assert.ok(result.results.length>=16);
 }finally{
  // The fixture and Edge profile are both descendants of the freshly created worktree-local directory.
  assert.ok(fixture.startsWith(fileURLToPath(new URL('.',import.meta.url))));rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
