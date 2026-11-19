"use strict";
const nativeRequire=require;const factories={"main.source":function(module,exports,require){
"use strict";
const {Plugin,PluginSettingTab,Setting,Notice,Modal,Platform,requestUrl}=require('obsidian');
const {ViewPlugin,Decoration,EditorView}=require('@codemirror/view');
const {parseFile}=require('./model');
const {Transport}=require('./transport');
const {publish}=require('./engine');
const {recurrenceRepairs}=require('./identity');
const {createDavRequest}=require('./mobile-network');
const {installAbyssMarkerHider}=require('./marker-ui');
const uid=()=>{const b=new Uint8Array(16);crypto.getRandomValues(b);return [...b].map(x=>x.toString(16).padStart(2,'0')).join('');};
const defaults={enabled:true,devices:'mobile',server:'https://dav.fruux.com/',user:'',password:'',timezone:'Europe/Moscow',leadMinutes:0,delaySeconds:5,pollSeconds:300,exclude:'files/\nhome/\ntemplates/\nperiodic/statuses/\nperiodic/tasks.md',namespace:'',state:{}};
class TextModal extends Modal{constructor(app,title,body){super(app);this.title=title;this.body=body;}onOpen(){this.contentEl.createEl('h2',{text:this.title});this.contentEl.createEl('pre',{text:this.body,cls:'an-report'});}}
class JournalModal extends Modal {
 constructor(plugin) { super(plugin.app); this.plugin = plugin; }
 onOpen() {
  this.contentEl.createEl('h2', {text:'Журнал Abyss Notifications'});
  const report = this.contentEl.createEl('pre', {cls:'an-report'});
  this.render = () => { report.textContent = this.plugin.logRows.slice().reverse().join('\n'); };
  this.plugin.logListeners.add(this.render);
  this.render();
 }
 onClose() { this.plugin.logListeners.delete(this.render); }
}
function hideMarkers(owner){return ViewPlugin.fromClass(class{
 constructor(view){this.update({view});}update({view}){const ranges=[];if(owner.settings.hideMarkers)for(const v of view.visibleRanges){const start=view.state.doc.lineAt(v.from).from,end=view.state.doc.lineAt(v.to).to,text=view.state.doc.sliceString(start,end);for(const m of text.matchAll(/<!-- (?:dav|gcal):[a-f0-9]{32} -->/g))ranges.push(Decoration.replace({}).range(start+m.index,start+m.index+m[0].length));}this.decorations=Decoration.set([...new Map(ranges.map(r=>[r.from,r])).values()].sort((a,b)=>a.from-b.from));}
 },{decorations:v=>v.decorations,provide:p=>EditorView.atomicRanges.of(v=>v.plugin(p)?.decorations||Decoration.none)});}
module.exports=class Notifications extends Plugin{
 async onload(){
  const stored=await this.loadData();this.saved=JSON.stringify(stored);this.settings={...defaults,...stored,hideMarkers:true};if(!/^[a-f0-9]{32}$/.test(this.settings.namespace))this.settings.namespace=uid();
  if(!stored){try{const path=(this.app.vault.configDir||'.obsidian')+'/plugins/task-calendar-bridge/data.json';if(await this.app.vault.adapter.exists(path)){const old=JSON.parse(await this.app.vault.adapter.read(path));this.settings.server=old.davServer||defaults.server;this.settings.user=old.davUser||'';this.settings.password=old.davPassword||'';this.settings.timezone=old.timezone||defaults.timezone;}}catch{/* Connection can be configured manually. */}}
  this.settings.state=this.settings.state||{};this.cache=new Map();this.writing=new Set();this.revision=0;this.logRows=[];this.stopped=false;this.running=false;this.lastEdit=0;this.errors=[];
  try{const logPath=this.manifest.dir+'/journal-'+(Platform.isIosApp?'ios':Platform.isAndroidApp?'android':'desktop')+'.log';if(await this.app.vault.adapter.exists(logPath))this.logRows=(await this.app.vault.adapter.read(logPath)).split('\n').filter(Boolean).slice(-150);}catch{/* A missing journal is normal on first launch. */}
  this.logListeners = new Set();
  this.retryKey = 'abyss-notifications:retry:' + this.settings.namespace;
  const savedRetry = this.app.loadLocalStorage?.(this.retryKey);
  this.failures = Math.max(0, Math.min(4, Math.trunc(savedRetry?.failures) || 0));
  this.retryAt = Math.min(Number(savedRetry?.retryAt) || 0, Date.now() + 30 * 60000);
  if (this.retryAt > Date.now()) this.phase = this.retryMessage();
  this.native=createDavRequest(requestUrl,{ios:!!Platform.isIosApp});this.addSettingTab(new Settings(this.app,this));
  this.addCommand({id:'sync',name:'Синхронизировать сейчас',callback:()=>this.sync(true)});
  this.addCommand({id:'status',name:'Состояние и пропущенные задачи',callback:()=>this.showStatus()});
  this.addCommand({id:'log',name:'Открыть журнал',callback:()=>this.showLog()});
  this.registerEditorExtension(hideMarkers(this));this.stopHider=installAbyssMarkerHider(this,document);
  for(const name of ['create','modify','delete','rename'])this.registerEvent(this.app.vault.on(name,(f)=>{if(f.extension==='md'&&!this.writing.has(f.path)){this.cache.delete(f.path);this.revision++;this.lastEdit=Date.now();this.schedule();}}));
  this.registerDomEvent(document,'visibilitychange',()=>{clearTimeout(this.timer);if(!document.hidden)this.schedule();});
  this.restartPolling();this.app.workspace.onLayoutReady(()=>this.schedule());await this.save();this.log('Плагин запущен');
 }
 onunload(){this.stopped=true;void this.flushLog();clearTimeout(this.timer);clearInterval(this.pollTimer);this.stopHider?.();}
 allowed(){return this.settings.enabled&&(this.settings.devices==='both'||this.settings.devices===(Platform.isMobileApp||Platform.isIosApp||Platform.isAndroidApp?'mobile':'desktop'));}
 restartPolling(){clearInterval(this.pollTimer);clearTimeout(this.timer);if(this.allowed()&&!this.stopped)this.registerInterval(this.pollTimer=setInterval(()=>this.schedule(0),Math.max(60,this.settings.pollSeconds)*1000));}
 schedule(delay=500){if(this.stopped||!this.allowed()||document.hidden)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.sync(),Math.max(delay,this.lastEdit+this.settings.delaySeconds*1000-Date.now(),this.retryAt-Date.now()));}
 retryMessage() {
  return 'Следующая автоматическая попытка после ' + new Date(this.retryAt).toLocaleTimeString() + '. Ручной запуск доступен сейчас.';
 }
 setRetry(failed) {
  this.failures = failed ? Math.min(this.failures + 1, 4) : 0;
  const minutes = [0, 5, 10, 20, 30][this.failures];
  this.retryAt = failed ? Date.now() + minutes * 60000 : 0;
  this.app.saveLocalStorage?.(this.retryKey, {failures:this.failures, retryAt:this.retryAt});
  if (failed) this.schedule();
 }
 eligible(path){return !path.split('/').some(p=>p.startsWith('.'))&&!path.includes('.sync-conflict-')&&!this.settings.exclude.split('\n').map(x=>x.trim()).filter(Boolean).some(x=>x.endsWith('/')?path.startsWith(x):path===x);}
 async save(){const data=JSON.stringify(this.settings);this.saveQueue=(this.saveQueue||Promise.resolve()).catch(()=>{}).then(async()=>{if(data!==this.saved){await this.saveData(JSON.parse(data));this.saved=data;}});await this.saveQueue;}
 async onExternalSettingsChange(){const data=await this.loadData();if(JSON.stringify(data)===this.saved)return;if(this.running){if(data){this.settings.devices=data.devices||'mobile';this.settings.enabled=data.enabled!==false;}this.externalPending=true;return;}if(data){Object.assign(this.settings,data);this.saved=JSON.stringify(this.settings);this.cache.clear();this.restartPolling();this.schedule();}}
 log(message,meta=''){this.logRows.push(new Date().toISOString()+' '+message+(meta?' · '+meta:''));if(this.logRows.length>200)this.logRows.shift();this.logDirty=true;
  for (const render of this.logListeners) render();
  if (!this.logTimer && !this.stopped) this.logTimer = setTimeout(() => { this.logTimer = null; void this.flushLog(); }, 1000);
 }
 async flushLog(){
  clearTimeout(this.logTimer);
  this.logTimer = null;
  if (!this.logDirty) return this.logWrite;
  this.logDirty = false;
  const snapshot = this.logRows.join('\n');
  const platform = Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'desktop';
  const path = this.manifest.dir + '/journal-' + platform + '.log';
  this.logWrite = (this.logWrite || Promise.resolve()).then(() => this.app.vault.adapter.write(path, snapshot)).catch(() => { this.logDirty = true; });
  return this.logWrite;
 }
 showLog(){new JournalModal(this).open();}
 showStatus(){new TextModal(this.app,'Состояние Abyss Notifications',[this.phase||'Ожидание',this.lastSuccess?'Последний успешный обмен: '+this.lastSuccess:'',this.result?'Операции на сервере: записано '+this.result.writes+'; удалено '+this.result.deletes+'; задач в обмене: '+this.result.selected:'',this.errors.length?'Пропущенные задачи сохранены на сервере без изменений; остальные синхронизированы.':'',...this.errors.map(e=>(e.title?'«'+e.title+'»\n':'')+e.path+':'+(e.line+1)+' — '+e.message)].filter(Boolean).join('\n')).open();}
 legacyActive(){return !!this.app.plugins?.enabledPlugins?.has('task-calendar-bridge');}
 async snapshot(){
  const tasks=[],seen=new Set();let reads=0,parses=0;
  for(const f of this.app.vault.getMarkdownFiles()){
   if(!this.eligible(f.path))continue;seen.add(f.path);const signature=f.stat.mtime+':'+f.stat.size;let entry=this.cache.get(f.path);
   if(!entry||entry.signature!==signature){const text=await this.app.vault.read(f);reads++;entry={signature,text,tasks:parseFile(text,f.path)};parses++;this.cache.set(f.path,entry);}tasks.push(...entry.tasks);
  }
  for(const path of this.cache.keys())if(!seen.has(path))this.cache.delete(path);
  this.log('Индекс заметок','чтений '+reads+', разборов '+parses);return tasks;
 }
 async assignIds(tasks,guard){
  const repairs=recurrenceRepairs(tasks,this.settings.state),changes=[...repairs,...tasks.filter(t=>t.selected&&!t.error&&!t.id).map(task=>({task}))],byPath=new Map();
  for(const change of changes){if(!byPath.has(change.task.path))byPath.set(change.task.path,[]);byPath.get(change.task.path).push(change);}
  for(const [path,rows] of byPath){await guard();const file=this.app.vault.getAbstractFileByPath(path),entry=this.cache.get(path);if(!file)throw Error('Заметка ещё меняется.');const lines=entry.text.split(/\r?\n/);for(const {task:t,oldId}of rows){const next=uid();lines[t.line]=oldId?lines[t.line].replace(new RegExp('<!-- (?:dav|gcal):'+oldId+' -->'),'<!-- dav:'+next+' -->'):lines[t.line]+' <!-- dav:'+next+' -->';}const desired=lines.join(entry.text.includes('\r\n')?'\r\n':'\n');this.writing.add(path);try{await this.app.vault.process(file,current=>{if(current!==entry.text)throw Error('Заметка ещё меняется.');return desired;});const actual=await this.app.vault.read(file);if(actual!==desired){this.revision++;throw Error('Заметка ещё меняется.');}this.cache.set(path,{signature:file.stat.mtime+':'+file.stat.size,text:desired,tasks:parseFile(desired,path)});if(rows.some(r=>r.oldId))this.log('Восстановлены метки экземпляров повторяющейся задачи','количество '+rows.filter(r=>r.oldId).length);}finally{this.writing.delete(path);}}
  return [...this.cache.values()].flatMap(e=>e.tasks);
 }
 async sync(manual=false){
  if(this.stopped||!manual&&(!this.allowed()||document.hidden))return;
  if(!manual && this.retryAt > Date.now()){this.schedule();return;}
  if(this.running){if(manual)this.manualQueued=true;return;}
  if(this.legacyActive()){this.phase='Сначала отключи старый Abyss Fruux Bridge: оба плагина одновременно не работают.';this.log('Обмен пропущен',this.phase);return;}
  if(!this.settings.user||!this.settings.password){this.phase='Укажи данные fruux в настройках Abyss Notifications.';this.log('Обмен пропущен',this.phase);return;}
  if(!manual && Date.now()-this.lastEdit<this.settings.delaySeconds*1000){this.phase='Ожидаю окончания ввода';this.schedule();return;}
  this.running=true;clearTimeout(this.timer);this.errors=[];this.result=null;const revision=this.revision,start=Date.now();let requests=0;
  const guard=async()=>{if(this.stopped||document.hidden||this.revision!==revision||!manual&&!this.allowed()){const e=Error('Обмен отложен: заметка меняется или приложение скрыто.');e.deferred=true;throw e;}};
  const settings={...this.settings};this.phase='Отправляю задачи';this.log('Начало обмена',manual?'вручную':'автоматически');
  try{
   let tasks=await this.snapshot();await guard();tasks=await this.assignIds(tasks,guard);await guard();
   this.errors=tasks.filter(t=>t.selected&&t.error).map(t=>({path:t.path,line:t.line,title:t.title,message:t.error}));
   const account=JSON.stringify([settings.server,settings.user]);if(this.settings.account!==account){this.settings.state={};this.settings.account=account;}
   const transport=new Transport(async p=>{await guard();requests++;this.log('Запрос',p.method+' → '+new URL(p.url).hostname);try{const r=await this.native(p);this.log('Ответ',p.method+' HTTP '+r.status);return r;}catch(error){if(error?.code==='DAV_TIMEOUT'||error?.code==='DAV_IN_FLIGHT')throw error;throw Error('Нет ответа CalDAV. Проверь доступ к fruux из Obsidian; повторим при следующем обмене.');}},{davServer:settings.server,davUser:settings.user,davPassword:settings.password,timezone:settings.timezone,davHomeHint:this.settings.homeAccount===account?this.settings.home:''});
   transport.resourceCache=this.remoteResources||(this.remoteResources=new Map());
   this.result=await publish({tasks,transport,settings,vault:this.app.vault.getName(),state:this.settings.state,guard,save:()=>this.save(),log:(op,kind,id,reason)=>this.log(op==='put'?'Запись отправлена':op==='confirmed'?'Версия подтверждена без повторной отправки':'Запись удалена',[kind,reason].filter(Boolean).join(' · '))});
   this.settings.home=transport.homeUrl;this.settings.homeAccount=account;this.errors=[...new Map([...this.errors,...this.result.issues].map(x=>[x.path+':'+x.line+':'+x.message,x])).values()];this.phase=(this.errors.length?'Частично: ':'Готово: ')+'изменено задач '+this.result.changed+(this.errors.length?'; пропущено '+this.errors.length:'');this.lastSuccess=new Date().toLocaleString();await this.save();
   const recovered = this.failures > 0;
   if(recovered) this.setRetry(false);
   if(!this.errors.length && (manual || recovered || this.result.changed)) new Notice(this.phase,4500);
  }catch(e){if(e.deferred){this.phase=e.message;this.log('Тихий повтор');this.schedule();}else{
   this.setRetry(true);
   this.phase=e.message+' '+this.retryMessage();
   const reason = e.code==='DAV_TIMEOUT' || e.code==='DAV_IN_FLIGHT' || /^(CalDAV|Нет ответа CalDAV)/.test(e.message) ? e.message : 'Подробности в состоянии плагина.';
   this.log('Ошибка обмена',reason+' '+this.retryMessage());
  }}
  finally{this.running=false;this.log('Завершение','запросов '+requests+', мс '+(Date.now()-start));await this.flushLog();if(this.externalPending){this.externalPending=false;await this.onExternalSettingsChange();}if(this.manualQueued){this.manualQueued=false;await this.sync(true);}else if(this.revision!==revision)this.schedule();}
 }
};
class Settings extends PluginSettingTab{
 constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
 display(){
  const p=this.plugin,s=p.settings,e=this.containerEl;e.empty();e.addClass('an-settings');e.createEl('h2',{text:'Abyss Notifications · 1.0.9'});e.createEl('p',{text:'Obsidian → fruux → телефон. Дата без времени — напоминание без сигнала; одно время — напоминание с сигналом; длительность — событие.'});
  e.createEl('p',{text:p.legacyActive()?'Для запуска отключи старый Abyss Fruux Bridge.':p.phase||(p.allowed()?'Автоматический обмен разрешён на этом устройстве.':'На этом устройстве доступен ручной запуск.')});
  new Setting(e).setName('Обмен').addButton(b=>b.setButtonText('Синхронизировать').onClick(async()=>{await p.sync(true);this.display();}));
  new Setting(e).setName('Состояние и пропущенные задачи').addButton(b=>b.setButtonText('Открыть').onClick(()=>p.showStatus())).addButton(b=>b.setButtonText('Журнал').onClick(()=>p.showLog()));
  new Setting(e).setName('Автоматически на').addDropdown(d=>d.addOptions({mobile:'Только телефоне',desktop:'Только компьютере',both:'Обоих устройствах'}).setValue(s.devices).onChange(async v=>{s.devices=v;await p.save();p.restartPolling();p.schedule();this.display();}));
  new Setting(e).setName('Автоматический обмен').addToggle(t=>t.setValue(s.enabled).onChange(async v=>{s.enabled=v;await p.save();p.restartPolling();p.schedule();}));
  const text=(key,label,secret=false)=>new Setting(e).setName(label).addText(t=>{t.setValue(String(s[key]));t.inputEl.type=secret?'password':'text';t.inputEl.autocomplete='off';t.inputEl.addEventListener('change',async()=>{s[key]=t.getValue().trim();await p.save();});});
  text('server','Сервер CalDAV');text('user','Логин устройства fruux');text('password','Пароль устройства fruux',true);text('timezone','Часовой пояс');
  new Setting(e).setName('Подключение').addButton(b=>b.setButtonText('Проверить').onClick(async()=>{try{if(p.running)throw Error('Дождись окончания обмена.');const transport=new Transport(p.native,{davServer:s.server,davUser:s.user,davPassword:s.password});await transport.discover('ALL');new Notice('Подключение работает. Данные на сервере не менялись.');}catch(err){new Notice(err.message,8000);}}));
  new Setting(e).setName('Уведомление').addDropdown(d=>d.addOptions({'0':'В указанное время','5':'За 5 минут','10':'За 10 минут','15':'За 15 минут','30':'За 30 минут'}).setValue(String(s.leadMinutes)).onChange(async v=>{s.leadMinutes=+v;await p.save();p.schedule();}));
  new Setting(e).setName('Пауза после ввода').addDropdown(d=>d.addOptions({'3':'3 секунды','5':'5 секунд','10':'10 секунд','15':'15 секунд'}).setValue(String(s.delaySeconds)).onChange(async v=>{s.delaySeconds=+v;await p.save();}));
  new Setting(e).setName('Проверять сервер').setDesc('Правки заметок отправляются после паузы ввода. Эта проверка восстанавливает изменения, сделанные в приложениях телефона.').addDropdown(d=>d.addOptions({'60':'Раз в минуту','300':'Раз в 5 минут','900':'Раз в 15 минут'}).setValue(String(s.pollSeconds)).onChange(async v=>{s.pollSeconds=+v;await p.save();p.restartPolling();}));
  new Setting(e).setName('Не читать эти пути').setDesc('Папки заканчивай знаком /. Один путь на строку.').addTextArea(t=>t.setValue(s.exclude).onChange(async v=>{s.exclude=v;await p.save();}));
  e.createEl('p',{text:'Коллекции: '+p.app.vault.getName()+' — Напоминания / '+p.app.vault.getName()+' — Календарь. Изменения на телефоне не импортируются. Завершённые задачи Obsidian тоже выгружаются. Данные подключения хранятся в настройках плагина в хранилище.'});
 }
}

},
"model":function(module,exports,require){
"use strict";
const {validDate,recurrence}=require('./recurrence');
const {localEpoch,localParts,timezoneComponent}=require('./time');
const marker=/<!-- (?:dav|gcal):([a-f0-9]{32}) -->/g;
const taskLine=/^(\s*)(?:[-*+]|\d+[.)])\s+\[([^\]])\]\s+(.*)$/;
const indent=line=>{let n=0;for(const c of line.match(/^\s*/)[0])n=c==='\t'?n+4-n%4:n+1;return n;};
function descriptionFor(lines,index){
 const parentIndent=indent(lines[index]),out=[];
 for(let j=index+1;j<lines.length;j++){
  if(!lines[j].trim()){out.push('');continue;}
  if(indent(lines[j])<=parentIndent)break;
  if(taskLine.test(lines[j])){const childIndent=indent(lines[j]);while(j+1<lines.length&&(!lines[j+1].trim()||indent(lines[j+1])>childIndent))j++;continue;}
  out.push(lines[j].trimStart().replace(/^(?:[-*+]\s+)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}):\s*/,'').replace(/^[-*+]\s+>\s?/,''));
 }return out.join('\n').trim();
}
function parseFile(text,path){
 const lines=text.split(/\r?\n/),tasks=[],ancestors=[];let front=lines[0]?.trim()==='---',fence='';
 for(let i=0;i<lines.length;i++){
  const line=lines[i];if(front){if(i&&/^---\s*$/.test(line))front=false;continue;}
  const f=line.match(/^\s*(`{3,}|~{3,})/);if(f){if(!fence)fence=f[1][0];else if(f[1][0]===fence)fence='';continue;}if(fence)continue;
  const level=indent(line);if(line.trim())while(ancestors.length&&ancestors.at(-1).indent>=level)ancestors.pop();
  const m=line.match(taskLine);if(!m)continue;
  const raw=m[3],id=[...raw.matchAll(marker)][0]?.[1],tags=[...raw.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]+)/gu)].map(m=>m[2]);
  const task={id,path,line:i,rawLine:line,done:/[xX-]/.test(m[2]),eligible:(tags.length>0||!!ancestors.at(-1)?.eligible)&&!tags.includes('#task/default')};
  ancestors.push({indent:level,eligible:task.eligible});
  const date=(emoji,field)=>raw.match(new RegExp(emoji+'\\s*(\\d{4}-\\d{2}-\\d{2})'))?.[1]||raw.match(new RegExp('\\['+field+'::\\s*(\\d{4}-\\d{2}-\\d{2})\\s*\\]'))?.[1];
  task.dueDate=date('📅','due')||'';task.startDate=date('🛫','start')||'';
  task.date=task.dueDate||date('⏳','scheduled')||task.startDate||'';
  const clock=raw.match(/(?:⏰\s*|\[time::\s*)(\d{1,2}:\d{2})(?:\s*[-–—]\s*(\d{1,2}:\d{2}))?/)||raw.match(/^(?:#[\p{L}\p{N}_/-]+\s+)*(\d{1,2}:\d{2})(?:\s*[-–—]\s*(\d{1,2}:\d{2}))?(?=\s)/u);
  task.time=clock?.[1]?.padStart(5,'0')||'';task.duration=0;
  const dur=raw.match(/⏱\uFE0F?\s*([^📅⏳🛫🔁➕✅❌<\[]+)/u)?.[1]?.trim()||raw.match(/\[duration::\s*([^\]]+)\]/)?.[1]?.trim();
  if(clock?.[2]){const end=clock[2].padStart(5,'0');task.duration=minutes(end)-minutes(task.time);if(task.duration<0)task.duration+=1440;if(!validTime(end)||task.duration===0)task.error='Некорректное окончание интервала';}
  if(dur){const d=duration(dur);if(!d||task.duration&&task.duration!==d)task.error='Некорректная или противоречивая длительность';else task.duration=d;}
  task.kind=task.time&&task.duration?'calendar':'reminders';
  if(task.date&&!validDate(task.date))task.error='Некорректная дата';if(task.time&&!validTime(task.time))task.error='Некорректное время';
  if(/[⏱]/u.test(raw)&&!dur)task.error='Не указана длительность';
  const repeat=raw.match(/🔁\s*(.*?)(?=\s*(?:📅|⏳|🛫|➕|✅|❌|⏰|⏱|<!--|\[|$))/u)?.[1]?.trim()||raw.match(/\[repeat::\s*([^\]]+)\]/)?.[1]?.trim()||'';
  task.repeatText=repeat;task.whenDone=/\bwhen done$/i.test(repeat);
  // A completion-relative repeat is scheduled by Obsidian, never guessed on the server.
  try{task.rule=task.whenDone?'':recurrence(repeat)[0]?.replace(/^RRULE:/,'')||'';}catch(e){if(!task.done)task.error=e.message;task.rule='';}
  if(task.kind==='calendar'&&task.startDate&&task.dueDate){
   if(!validDate(task.startDate)||task.startDate>task.dueDate)task.error='Дата начала должна быть корректной и не позже срока';
   else if(task.startDate<task.dueDate){
    if(repeat)task.error='Диапазон начала–срока и отдельный повтор пока не совмещаются';
    else task.rangeDays=Math.round((Date.parse(task.dueDate+'T12:00:00Z')-Date.parse(task.startDate+'T12:00:00Z'))/86400000)+1;
   }
  }
  task.title=raw.replace(marker,'').replace(/[📅⏳🛫➕✅❌]\s*\d{4}-\d{2}-\d{2}/gu,'').replace(/🔁\s*.*?(?=\s*(?:📅|⏳|🛫|➕|✅|❌|⏰|⏱|<!--|\[|$))/gu,'').replace(/⏱\uFE0F?\s*[^📅⏳🛫🔁➕✅❌<\[]+/gu,'').replace(/⏰\s*\d{1,2}:\d{2}(?:\s*[-–—]\s*\d{1,2}:\d{2})?/g,'').replace(/\[(?:due|scheduled|start|repeat|time|duration)::[^\]]*\]/g,'').replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu,'$1').replace(/^\s*\d{1,2}:\d{2}(?:\s*[-–—]\s*\d{1,2}:\d{2})?\s+/,'').replace(/\s+/g,' ').trim();
  task.description=descriptionFor(lines,i);task.completed=date('✅','completion')||'';task.created=date('➕','created')||'';
  task.selected=task.eligible&&!!task.date;
  if(task.selected&&!task.title)task.error='Пустое название';tasks.push(task);
 }return tasks;
}
const validTime=t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
function duration(s){let m;if((m=s.match(/^(\d{1,3}):([0-5]\d)$/)))return +m[1]*60+(+m[2]);if((m=s.match(/^(?:(\d+)h)?(?:(\d+)m)?$/))&&(m[1]||m[2])){const d=+(m[1]||0)*60+(+m[2]||0);return d<=10080?d:0;}return 0;}
const escape=s=>String(s||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
function fold(line){let out='',n=0;for(const c of line){const size=new TextEncoder().encode(c).length;if(n+size>75){out+='\r\n ';n=1;}out+=c;n+=size;}return out;}
const utc=epoch=>new Date(epoch).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
function semantic(task,zone,lead,vault){return JSON.stringify(['single-reminder-v5',task.title,task.description,task.date,task.startDate,task.rangeDays,task.time,task.duration,task.done,task.rule,task.completed,task.created,task.path,zone,lead,vault]);}
function serialize(task,{namespace,zone,lead=0,vault,stamp=Date.now()}){
 const kind=task.kind==='calendar'?'VEVENT':'VTODO',eventDate=task.rangeDays?task.startDate:task.date,epoch=localEpoch(eventDate,task.time||'00:00',zone),title=(kind==='VEVENT'&&task.done?'✅ ':'')+task.title;
 // Local TZID retains the wall clock across daylight-saving changes in recurrences.
 const start=eventDate.replace(/-/g,'')+'T'+task.time.replace(':','')+'00';
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Abyss Notifications//EN',...(task.time?timezoneComponent(zone,eventDate):[]),'BEGIN:'+kind,'UID:an-'+namespace+'-'+task.id+'@obsidian','DTSTAMP:'+utc(stamp),'LAST-MODIFIED:'+utc(stamp),'SUMMARY:'+escape(title),'DESCRIPTION:'+escape(task.description)];
 if(task.time)lines.push('DTSTART;TZID='+zone+':'+start);
 if(kind==='VEVENT'){const p=localParts(epoch+task.duration*60000,zone);lines.push('DTEND;TZID='+zone+':'+p.date.replace(/-/g,'')+'T'+p.time.replace(':','')+'00','STATUS:CONFIRMED','X-OBSIDIAN-COMPLETED:'+(task.done?'TRUE':'FALSE'));}
 // RFC 5545 requires DUE strictly after DTSTART. Alerts are anchored to the exact requested START.
 else{lines.push(task.time?'DUE;TZID='+zone+':'+start.slice(0,-2)+'01':'DUE;VALUE=DATE:'+task.date.replace(/-/g,''),'STATUS:'+(task.done?'COMPLETED':'NEEDS-ACTION'),'PERCENT-COMPLETE:'+(task.done?'100':'0'));if(task.done)lines.push('COMPLETED:'+utc(task.completed?localEpoch(task.completed,'12:00',zone):epoch));}
 if(task.created&&validDate(task.created))lines.push('CREATED:'+utc(localEpoch(task.created,'12:00',zone)));
 if(task.rangeDays)lines.push('RRULE:FREQ=DAILY;COUNT='+task.rangeDays);
 else if(kind==='VEVENT'&&task.rule&&!task.done)lines.push('RRULE:'+task.rule);
 if(!task.done&&task.time)lines.push('BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:'+escape(task.title),'TRIGGER;RELATED=START:'+(lead?'-PT'+lead+'M':'PT0S'),'END:VALARM');
 lines.push('END:'+kind,'END:VCALENDAR');return lines.map(fold).join('\r\n')+'\r\n';
}
module.exports={parseFile,duration,serialize,semantic};

},
"recurrence":function(module,exports,require){
"use strict";
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
}
function recurrence(text) {
  if (!text) return [];
  let s = text.toLowerCase().trim();
  if (s.includes('when done')) throw new Error('Повтор «when done» зависит от выполнения. Его нельзя точно перенести в календарь.');
  const until = s.match(/ until (\d{4}-\d{2}-\d{2})$/);
  if (until) { if (!validDate(until[1])) throw new Error('Некорректная дата окончания повтора'); s = s.slice(0,until.index); }
  const m = s.match(/^every(?: (\d+))? (day|days|week|weeks|month|months|year|years|weekday|weekdays)(?: on (.+))?$/);
  if (!m || Number(m[1] || 1)<1) throw new Error('Неподдерживаемый повтор: '+text);
  const freq = {day:'DAILY',week:'WEEKLY',month:'MONTHLY',year:'YEARLY',weekday:'WEEKLY'}[m[2].replace(/s$/, '')];
  let rule = 'RRULE:FREQ='+freq+';INTERVAL='+(m[1]||1);
  if (m[2].startsWith('weekday')) rule+=';BYDAY=MO,TU,WE,TH,FR';
  if (m[3]) {
    const days = {monday:'MO',tuesday:'TU',wednesday:'WE',thursday:'TH',friday:'FR',saturday:'SA',sunday:'SU'};
    const parts = m[3].split(/\s*,\s*|\s+and\s+/).map(x=>days[x.trim()]);
    if (freq!=='WEEKLY' || parts.some(x=>!x)) throw new Error('Поддерживается «every week on Monday, Friday»; сложный повтор не отправлен.');
    rule+=';BYDAY='+parts.join(',');
  }
  if (until) rule+=';UNTIL='+until[1].replace(/-/g,'')+'T235959Z';
  return [rule];
}

module.exports={validDate,recurrence};

},
"time":function(module,exports,require){
"use strict";
function dateParts(date){return date.match(/^(\d{4})-(\d{2})-(\d{2})$/)?.slice(1).map(Number);}
const formatters=new Map();
function dateFormatter(zone,dateOnly=false){
  const key=zone+'|'+dateOnly;if(formatters.has(key))return formatters.get(key);
  const value=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',...(dateOnly?{}:{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})});
  if(formatters.size>=16)formatters.delete(formatters.keys().next().value);formatters.set(key,value);return value;
}
function localParts(epoch,zone){
  const p=Object.fromEntries(dateFormatter(zone).formatToParts(new Date(epoch)).map(p=>[p.type,p.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,second:p.second};
}
function localEpoch(date,time,zone){
  const parts=dateParts(date);if(!parts||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('Некорректная дата или время задачи.');
  const target=Date.UTC(parts[0],parts[1]-1,parts[2],Number(time.slice(0,2)),Number(time.slice(3)));let epoch=target;
  for(let i=0;i<5;i++){
    const p=localParts(epoch,zone),d=dateParts(p.date),observed=Date.UTC(d[0],d[1]-1,d[2],Number(p.time.slice(0,2)),Number(p.time.slice(3))),difference=target-observed;
    if(!difference)return epoch;epoch+=difference;
  }
  throw Error('Это время не существует в выбранном часовом поясе.');
}

const zoneCache=new Map();
function timezoneComponent(zone,date){
 const year=Math.floor(Number(date.slice(0,4))/10)*10,key=zone+'|'+year;if(zoneCache.has(key))return zoneCache.get(key);
 const offset=epoch=>{const p=localParts(epoch,zone),d=dateParts(p.date);return Math.round((Date.UTC(...[d[0],d[1]-1,d[2],+p.time.slice(0,2),+p.time.slice(3)])-epoch)/60000);};
 const format=n=>(n<0?'-':'+')+String(Math.floor(Math.abs(n)/60)).padStart(2,'0')+String(Math.abs(n)%60).padStart(2,'0');
 const local=epoch=>new Date(epoch).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z/,'');
 let left=Date.UTC(year-1,0,1),previous=offset(left);const first=previous,transitions=[];
 for(let m=1;m<=32*12;m++){const right=Date.UTC(year-1,m,1),next=offset(right);if(next!==previous){let a=left,b=right;while(b-a>60000){const mid=Math.floor((a+b)/120000)*60000;if(offset(mid)===previous)a=mid;else b=mid;}transitions.push({epoch:b,from:previous,to:next});}left=right;previous=next;}
 const out=['BEGIN:VTIMEZONE','TZID:'+zone,'BEGIN:STANDARD','DTSTART:'+String(year-1)+'0101T000000','TZOFFSETFROM:'+format(first),'TZOFFSETTO:'+format(first),'END:STANDARD'];
 for(const t of transitions){const kind=t.to>t.from?'DAYLIGHT':'STANDARD',onset=new Date(t.epoch+t.from*60000);out.push('BEGIN:'+kind,'DTSTART:'+local(+onset),'TZOFFSETFROM:'+format(t.from),'TZOFFSETTO:'+format(t.to));
  // Extend the last observed stable annual rule; historical changes remain exact observances.
  const later=transitions.filter(x=>x.from===t.from&&x.to===t.to&&x.epoch>t.epoch),before=transitions.filter(x=>x.from===t.from&&x.to===t.to&&x.epoch<t.epoch).at(-1);
  if(!later.length&&before){const prev=new Date(before.epoch+before.from*60000),ordinal=d=>d.getUTCDate()+7>new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()?-1:Math.ceil(d.getUTCDate()/7);if(onset.getUTCFullYear()===prev.getUTCFullYear()+1&&onset.getUTCMonth()===prev.getUTCMonth()&&onset.getUTCDay()===prev.getUTCDay()&&ordinal(onset)===ordinal(prev)&&onset.getUTCHours()===prev.getUTCHours()&&onset.getUTCMinutes()===prev.getUTCMinutes())out.push('RRULE:FREQ=YEARLY;BYMONTH='+(onset.getUTCMonth()+1)+';BYDAY='+ordinal(onset)+['SU','MO','TU','WE','TH','FR','SA'][onset.getUTCDay()]);}
  out.push('END:'+kind);
 }out.push('END:VTIMEZONE');if(zoneCache.size>=8)zoneCache.delete(zoneCache.keys().next().value);zoneCache.set(key,out);return out;
}
module.exports={localEpoch,localParts,timezoneComponent};

},
"transport":function(module,exports,require){
"use strict";
const {CaldavReader}=require('./discovery');
const {equivalent}=require('./projection');
const DAV='DAV:';
const xml=s=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
class Transport extends CaldavReader{
 etag(headers){return Object.entries(headers||{}).find(([key])=>key.toLowerCase()==='etag')?.[1]||'';}
 async resource(url,etag){
  if(!etag)return null;const key=this.user+'\n'+url+'\n'+etag;if(this.resourceCache?.has(key))return this.resourceCache.get(key);
  const r=await this.request({url:this.safeUrl(url),method:'GET',headers:{Authorization:'Basic '+btoa(String.fromCharCode(...new TextEncoder().encode(this.user+':'+this.password))),'If-Match':etag},throw:false});
  if(r.status===404||r.status===412)return null;if(r.status!==200)throw Error('CalDAV: HTTP '+r.status+' при GET.');
  const version=this.etag(r.headers);if(version&&version!==etag)return null;
  const body=r.text||'';if(this.resourceCache){if(this.resourceCache.size>=256)this.resourceCache.delete(this.resourceCache.keys().next().value);this.resourceCache.set(key,body);}return body;
 }
 async matches(url,etag,body){const actual=await this.resource(url,etag);return actual!==null&&equivalent(actual,body,this.zone);}
 constructor(request,settings){super(request,settings);this.zone=settings.timezone||'Europe/Moscow';}
 async mutation(method,url,body,etag){
  if(!['PUT','DELETE','MKCALENDAR','PROPPATCH'].includes(method))throw Error('Неизвестная операция CalDAV.');
  if(method==='DELETE'&&!etag)throw Error('Удаление без версии записи запрещено.');
  const headers={Authorization:'Basic '+btoa(String.fromCharCode(...new TextEncoder().encode(this.user+':'+this.password)))};
  if(etag)headers['If-Match']=etag;else if(method==='PUT')headers['If-None-Match']='*';
  const r=await this.request({url:this.safeUrl(url),method,headers,contentType:method==='PUT'?'text/calendar; charset=utf-8':'application/xml; charset=utf-8',...(body!==undefined?{body}:{}),throw:false});
  if(method==='DELETE'&&r.status===404)return '';
  const accepted=method==='PROPPATCH'?[207]:method==='MKCALENDAR'?[201]:method==='DELETE'?[200,204]:[200,201,204];
  if(!accepted.includes(r.status)){const e=Error('CalDAV: HTTP '+r.status+' при '+method+'.');e.status=r.status;throw e;}
  if(method==='PROPPATCH'&&(!r.text||!require('./discovery').parseResponses(r.text).some(p=>p.get(DAV,'displayname'))))throw Error('Сервер не подтвердил название коллекции.');
  let version=this.etag(r.headers);
  if(method==='PUT'&&!version){
   // Some iOS/proxy responses omit ETag. Bind a version only after a conditional read
   // confirms that it is still our uploaded content, never a concurrent phone edit.
   const rows=await this.read(url,'PROPFIND','<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>');
   const candidate=rows[0]?.get(DAV,'getetag')?.textContent?.trim();
   if(candidate&&await this.matches(url,candidate,body))version=candidate;
  }
  return version;
 }
 async ensure(namespace,vault){
  const lists=await this.discover('ALL'),out={};
  for(const [kind,component,suffix] of [['reminders','VTODO','Напоминания'],['calendar','VEVENT','Календарь']]){
   const url=new URL('an-'+namespace+'-'+kind+'/',this.homeUrl.replace(/\/?$/,'/')).href,name=vault+' — '+suffix,list=lists.find(l=>l.url===url);
   if(!list){try{await this.mutation('MKCALENDAR',url,'<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>'+xml(name)+'</d:displayname><c:supported-calendar-component-set><c:comp name="'+component+'"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>');}catch(e){if(e.status!==405)throw e;const found=await this.discover('ALL');if(!found.some(l=>l.url===url))throw e;}}
   else if(list.name!==name)await this.mutation('PROPPATCH',url,'<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>'+xml(name)+'</d:displayname></d:prop></d:set></d:propertyupdate>');
   out[kind]=url;
  }return out;
 }
 async index(url){
  const rows=await this.read(url,'PROPFIND','<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>','1'),out=new Map();
  for(const row of rows){const href=this.safeUrl(row.href,url),root=new URL(url);if(href===root.href)continue;const u=new URL(href);if(!u.pathname.startsWith(root.pathname))throw Error('Запись вне коллекции.');if(row.get(DAV,'resourcetype')?.children.length)continue;const etag=row.get(DAV,'getetag')?.textContent?.trim();if(!etag)throw Error('Неполный список версий: запись остановлена.');out.set(href,etag);}return out;
 }
}
module.exports={Transport};

},
"discovery":function(module,exports,require){
"use strict";
// First-stage CalDAV connection: discovery and task preview, deliberately read-only.
const DAV='DAV:',CAL='urn:ietf:params:xml:ns:caldav';
const children=(node,ns,name)=>Array.from(node.children||[]).filter(n=>n.namespaceURI===ns&&n.localName===name);
const descendants=(node,ns,name)=>Array.from(node.getElementsByTagNameNS(ns,name));
const firstText=(node,ns,name)=>descendants(node,ns,name)[0]?.textContent?.trim()||'';
function parseResponses(xml){
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.getElementsByTagName('parsererror').length)throw Error('Сервер вернул некорректный XML.');
  if(descendants(doc,DAV,'multistatus').length!==1)throw Error('Сервер не вернул полный ответ multistatus. Обмен остановлен.');
  return descendants(doc,DAV,'response').map(response=>{
    const props=[];
    for(const stat of children(response,DAV,'propstat')){
      if(!/^HTTP\/\S+\s+2\d\d\b/.test(firstText(stat,DAV,'status')))continue;
      for(const prop of children(stat,DAV,'prop'))props.push(...Array.from(prop.children));
    }
    return {href:children(response,DAV,'href')[0]?.textContent?.trim()||'',get:(ns,name)=>props.find(p=>p.namespaceURI===ns&&p.localName===name)};
  });
}
function previewTodos(ics){
  const result=[];let task=null,depth=0;
  for(const line of ics.replace(/\r?\n[ \t]/g,'').split(/\r?\n/)){
    if(line==='BEGIN:VTODO'){task={title:'Без названия'};depth=1;continue;}
    if(!task)continue;
    if(line.startsWith('BEGIN:')){depth++;continue;}
    if(line.startsWith('END:')){if(--depth===0){result.push(task);task=null;}continue;}
    if(depth!==1)continue;
    const colon=line.indexOf(':');if(colon<0)continue;
    const property=line.slice(0,colon).split(';')[0],value=line.slice(colon+1);
    if(property==='SUMMARY')task.title=value.replace(/\\[nN]/g,'\n').replace(/\\([,;\\])/g,'$1');
  }
  return result;
}
function connectionFailure(error,method,url){
  // Never echo arbitrary native error text: it can contain credentials or request headers.
  const parts=[],seen=new Set();function collect(e,depth=0){if(e==null||depth>3||seen.has(e))return;if(typeof e==='string'||typeof e==='number'){parts.push(String(e).slice(0,4000));return;}if(typeof e!=='object')return;seen.add(e);for(const key of ['message','code','errorMessage','localizedDescription','description','reason','cause','error','status','statusCode'])collect(e[key],depth+1);}collect(error);const source=parts.join(' ');
  let reason='сетевая ошибка приложения';
  if(/-1001\b|ETIMEDOUT|timed?\s*out|timeout/i.test(source))reason='сервер не ответил вовремя (тайм-аут)';
  else if(/-1003\b|-1006\b|ENOTFOUND|EAI_AGAIN|resolve|DNS|hostname.*not.*found/i.test(source))reason='не удалось найти адрес сервера (DNS)';
  else if(/-120\d\b|certificate|SSL|TLS|CERT_/i.test(source))reason='не удалось установить защищённое соединение (TLS/сертификат)';
  else if(/-1009\b|not.*connected.*internet|offline|ENETUNREACH/i.test(source))reason='Obsidian не видит доступного сетевого подключения';
  else if(/-1004\b|ECONNREFUSED|connect.*refused/i.test(source))reason='не удалось установить соединение с сервером';
  else if(/-1005\b|ECONNRESET|connection.*lost/i.test(source))reason='соединение с сервером прервалось';
  else if(/not implemented|unimplemented|unsupported.*method|Expected one of/i.test(source))reason='сетевой API приложения не поддержал метод запроса';
  else if(/DAV_IN_FLIGHT/.test(source))reason='предыдущий запрос iOS ещё выполняется; повторная отправка приостановлена';
  const safeNative=['Request failed','Failed to fetch','Load failed','Network request failed'].find(s=>source.toLowerCase().includes(s.toLowerCase()));
  const native=source.match(/(?:^|\s|[=(])(-1[02]\d\d)\b/)?.[1];
  return Error('CalDAV: '+reason+(native?' ['+native+']':safeNative?' ['+safeNative+']':'')+'. Запрос '+method+' → '+new URL(url).hostname+' не получил HTTP-ответа.');
}
class CaldavReader{
  constructor(request,settings){
    this.request=request;this.user=settings.davUser||'';this.password=settings.davPassword||'';
    try{this.base=new URL(settings.davServer||'https://dav.fruux.com/');}catch{throw Error('Проверь HTTPS-адрес сервера CalDAV.');}
    if(this.base.protocol!=='https:'||this.base.username||this.base.password)throw Error('Для CalDAV нужен HTTPS-адрес без логина и пароля внутри ссылки.');
    if(!this.user||!this.password)throw Error('Введи логин и пароль устройства fruux в настройках.');
    this.homeHint=settings.davHomeHint?this.safeUrl(settings.davHomeHint):'';
  }
  safeUrl(href,base=this.base.href){
    const url=new URL(href,base);
    if(url.origin!==this.base.origin||url.username||url.password)throw Error('Сервер предложил другой адрес подключения. Автоматическая передача пароля на него отключена.');
    return url.href;
  }
  async read(url,method,body,depth='0'){
    if(!['PROPFIND','REPORT'].includes(method))throw Error('Этот режим CalDAV разрешает только чтение.');
    const safeUrl=this.safeUrl(url);
    const token=btoa(String.fromCharCode(...new TextEncoder().encode(this.user+':'+this.password)));
    let response;
    try{response=await this.request({url:safeUrl,method,headers:{Authorization:'Basic '+token,Depth:depth},contentType:'application/xml; charset=utf-8',body,throw:false});}
    catch(e){throw connectionFailure(e,method,safeUrl);}
    if(response.status===401||response.status===403)throw Error('CalDAV не принял доступ. Проверь логин и пароль устройства, а также права на список.');
    if(response.status!==207)throw Error('CalDAV вернул HTTP '+response.status+'. Нужен адрес сервиса CalDAV, а не веб-страницы.');
    if(response.text.length>5*1024*1024)throw Error('Ответ CalDAV слишком большой для предварительного просмотра.');
    return parseResponses(response.text);
  }
  async discover(component='VTODO'){
    if(this.homeHint)return this.discoverHome(this.homeHint,component);
    const principalQuery='<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop></d:propfind>';
    const root=await this.read(this.base.href,'PROPFIND',principalQuery);
    let home=root.map(r=>r.get(CAL,'calendar-home-set')).find(Boolean),homeBase=this.base.href;
    if(!home){
      const principal=root.map(r=>r.get(DAV,'current-user-principal')).find(Boolean);
      const href=principal&&firstText(principal,DAV,'href');
      if(!href)throw Error('Сервер не сообщил адрес пользователя CalDAV.');
      homeBase=this.safeUrl(href);
      const result=await this.read(homeBase,'PROPFIND',principalQuery);
      home=result.map(r=>r.get(CAL,'calendar-home-set')).find(Boolean);
    }
    const homeHref=home&&firstText(home,DAV,'href');
    if(!homeHref)throw Error('Сервер не сообщил адрес списков CalDAV.');
    const homeUrl=this.safeUrl(homeHref,homeBase);
    return this.discoverHome(homeUrl,component);
  }
  async discoverHome(homeUrl,component='VTODO'){
    this.homeUrl=homeUrl;
    const query='<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:sync-token/><cs:getctag/></d:prop></d:propfind>';
    const lists=await this.read(homeUrl,'PROPFIND',query,'1'),found=new Map();
    this.discoveredVersions=new Map();
    for(const item of lists){
      const type=item.get(DAV,'resourcetype'),components=item.get(CAL,'supported-calendar-component-set');
      if(!type||!descendants(type,CAL,'calendar').length||!components||!descendants(components,CAL,'comp').some(c=>component==='ALL'||c.getAttribute('name')===component))continue;
      const url=this.safeUrl(item.href,homeUrl),name=item.get(DAV,'displayname')?.textContent?.trim()||'Список задач';
      found.set(url,{url,name});
      const version=item.get(DAV,'sync-token')?.textContent?.trim()||item.get('http://calendarserver.org/ns/','getctag')?.textContent?.trim();if(version)this.discoveredVersions.set(url,version);
    }
    return [...found.values()];
  }
  async diagnose(onProgress=()=>{}){
    const rows=[],publicUrl=this.base.hostname==='dav.fruux.com'?'https://fruux.com/':this.base.origin+'/',auth='Basic '+btoa(String.fromCharCode(...new TextEncoder().encode(this.user+':'+this.password)));
    const run=async(label,params)=>{onProgress([...rows,label+': проверяю…'].join('\n\n'));const start=Date.now();try{const r=await this.request({...params,throw:false});rows.push(label+': HTTP '+r.status+' ('+Math.round((Date.now()-start)/1000)+' с)');}catch(e){rows.push(label+': '+connectionFailure(e,params.method,params.url).message);}onProgress(rows.join('\n\n'));};
    await run('1. HTTPS без пароля',{url:publicUrl,method:'GET'});
    await run('2. Сервер с авторизацией',{url:this.base.href,method:'GET',headers:{Authorization:auth}});
    const body='<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
    await run('3. CalDAV PROPFIND',{url:this.homeHint||this.base.href,method:'PROPFIND',contentType:'application/xml; charset=utf-8',headers:{Authorization:auth,Depth:'0'},body});
    return rows.join('\n\n');
  }
  async preview(listUrl){
    const query='<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>';
    const rows=await this.read(listUrl,'REPORT',query,'1'),tasks=[];
    for(const row of rows){const data=row.get(CAL,'calendar-data');if(data)tasks.push(...previewTodos(data.textContent));}
    return tasks;
  }
}

module.exports={CaldavReader,parseResponses};

},
"projection":function(module,exports,require){
"use strict";
const {localEpoch}=require('./time');
const unescape=s=>(s||'').replace(/\\[nN]/g,'\n').replace(/\\([,;\\])/g,'$1');
function fields(lines){return lines.map(l=>{const i=l.indexOf(':');if(i<0)return null;const [name,...rest]=l.slice(0,i).split(';'),params={};for(const r of rest){const e=r.indexOf('=');if(e>=0)params[r.slice(0,e).toUpperCase()]=r.slice(e+1).replace(/^"|"$/g,'');}return{name:name.toUpperCase(),params,value:l.slice(i+1)};}).filter(Boolean);}
function timestamp(p,zone){
 if(!p)return null;const m=p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);if(!m)throw Error('Unsupported date');
 if(!m[4])return m[1]+'-'+m[2]+'-'+m[3];
 return m[7]?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]):localEpoch(m[1]+'-'+m[2]+'-'+m[3],m[4]+':'+m[5],p.params.TZID||zone)+(+m[6])*1000;
}
function comparable(ics,zone,ignoreAlarms=false){
 const lines=ics.replace(/\r?\n[ \t]/g,'').split(/\r?\n/),starts=lines.filter(l=>/^BEGIN:V(?:TODO|EVENT)$/.test(l));if(starts.length!==1)throw Error('Complex resource');
 const component=starts[0].slice(6),from=lines.indexOf(starts[0]),top=[],alarms=[];let depth=0,block=[];
 for(const l of lines.slice(from+1)){if(l==='END:'+component&&depth===0)break;if(l.startsWith('BEGIN:')){if(!depth)block=[];depth++;block.push(l);continue;}if(l.startsWith('END:')){block.push(l);depth--;if(!depth&&block[0]==='BEGIN:VALARM')alarms.push(block);continue;}if(depth)block.push(l);else top.push(l);}
 const props=fields(top),get=n=>props.find(p=>p.name===n),start=timestamp(get('DTSTART'),zone),end=timestamp(get(component==='VEVENT'?'DTEND':'DUE'),zone),date=component==='VEVENT'?[start,end]:[end??start];
 // Obsidian exposes minute precision; tolerate the compatibility second added to VTODO DUE.
 const dates=date.map(t=>typeof t==='number'?Math.floor(t/60000):t);
 const rule=(get('RRULE')?.value||'').toUpperCase().split(';').filter(Boolean).filter(x=>x!=='INTERVAL=1'&&x!=='WKST=MO').map(x=>/^BY[A-Z]+=/.test(x)?x.split('=')[0]+'='+x.split('=')[1].split(',').sort().join(','):x).sort().join(';');
 const alarmValues=[];
 for(const block of ignoreAlarms?[]:alarms){if(block.some(l=>/^(?:(?:X-APPLE-)?PROXIMITY|(?:X-APPLE-)?STRUCTURED-LOCATION|GEO)[;:]/i.test(l)))continue;const a=fields(block),trigger=a.find(p=>p.name==='TRIGGER'),action=a.find(p=>p.name==='ACTION')?.value||'DISPLAY';if(!trigger)throw Error('Missing trigger');let time;
  const d=trigger.value.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if(d){const anchor=trigger.params.RELATED==='END'?end:start;if(typeof anchor!=='number')throw Error('Missing alarm anchor');time=anchor+(d[1]?-1:1)*((+d[2]||0)*604800+(+d[3]||0)*86400+(+d[4]||0)*3600+(+d[5]||0)*60+(+d[6]||0))*1000;}
  else time=timestamp(trigger,zone);
  alarmValues.push([action,typeof time==='number'?Math.floor(time/60000):time,a.find(p=>p.name==='REPEAT')?.value||'',a.find(p=>p.name==='DURATION')?.value||'']);
 }
 const done=component==='VTODO'?['COMPLETED','CANCELLED'].includes(get('STATUS')?.value)||get('PERCENT-COMPLETE')?.value==='100':get('X-OBSIDIAN-COMPLETED')?.value==='TRUE'||/^✅\s/.test(unescape(get('SUMMARY')?.value));
 const exceptional=props.filter(p=>['RDATE','EXDATE','RECURRENCE-ID'].includes(p.name)).map(p=>[p.name,p.params,p.value]);
 return JSON.stringify([component,get('UID')?.value||'',unescape(get('SUMMARY')?.value),unescape(get('DESCRIPTION')?.value),get('URL')?.value||'',dates,done,rule,alarmValues.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),exceptional]);
}
function equivalent(actual,expected,zone){try{return comparable(actual,zone)===comparable(expected,zone);}catch{return false;}}
function describeResource(ics,zone){try{const v=JSON.parse(comparable(ics,zone,true));return{component:v[0],uid:v[1],done:v[6],cloneKey:JSON.stringify([v[0],v[2],v[3],v[5]])};}catch{return null;}}
module.exports={equivalent,describeResource};

},
"engine":function(module,exports,require){
"use strict";
const {semantic,serialize}=require('./model');
const {describeResource}=require('./projection');
async function publish({tasks,transport,settings,vault,state,save,guard=async()=>{},log=()=>{}}){
 const collections=await transport.ensure(settings.namespace,vault),indexes={};for(const kind of ['reminders','calendar'])indexes[kind]=await transport.index(collections[kind]);
 const desired=new Map(),protectedIds=new Set(),issues=[],counts=new Map(),changedIds=new Set();let writes=0,deletes=0;
 for(const t of tasks)if(t.id)counts.set(t.id,(counts.get(t.id)||0)+1);
 for(const task of tasks){if(!task.id)continue;if(counts.get(task.id)>1){protectedIds.add(task.id);issues.push({path:task.path,line:task.line,title:task.title,message:'Скопирована служебная метка. Удали метку у копии задачи; её записи пока сохранены без изменений.'});continue;}if(task.error){protectedIds.add(task.id);issues.push({path:task.path,line:task.line,title:task.title,message:task.error});continue;}if(task.selected)desired.set(task.id,task);}
 const canonicalHref=(kind,id)=>new URL('an-'+settings.namespace+'-'+id+'.ics',collections[kind]).href,paths=new Map(),knownPaths=new Map(),cleanup=[];
 const href=(kind,id)=>paths.get(kind+':'+id)||canonicalHref(kind,id);
 const ownId=url=>{const u=new URL(url),m=decodeURIComponent(u.pathname.split('/').pop()).match(new RegExp('^an-'+settings.namespace+'-([a-f0-9]{32})\\.ics$'));return m?.[1]||knownPaths.get(url);};
 for(const [key,record]of Object.entries(state)){const [kind,id]=key.split(':');if(!indexes[kind]||!/^[a-f0-9]{32}$/.test(id)||!record.href||!indexes[kind].has(record.href)||!record.href.startsWith(collections[kind]))continue;if(!indexes[kind].has(canonicalHref(kind,id)))paths.set(key,record.href);knownPaths.set(record.href,id);}
 // Validate every desired payload before deleting or moving any record.
 const payloads=new Map();for(const [id,task] of desired)try{payloads.set(id,serialize(task,{namespace:settings.namespace,zone:settings.timezone,lead:settings.leadMinutes,vault}));}catch(e){protectedIds.add(id);desired.delete(id);issues.push({path:task.path,line:task.line,title:task.title,message:e.message});}
 const cloneKeys=new Map();for(const [id,task]of desired){if(task.kind!=='reminders')continue;const meta=describeResource(payloads.get(id),settings.timezone);if(meta){if(!cloneKeys.has(meta.cloneKey))cloneKeys.set(meta.cloneKey,[]);cloneKeys.get(meta.cloneKey).push(id);}}
 // Apple may move a resource, or complete a recurring reminder by creating a new UID.
 // Adopt unchanged UIDs; only remove completed foreign copies that match a source task
 // by title, description and exact date/time. Unrelated native entries are preserved.
 if(transport.resource)for(const kind of ['reminders','calendar'])for(const [url,etag]of indexes[kind]){
  if(ownId(url))continue;await guard();const ics=await transport.resource(url,etag);if(ics===null)continue;const meta=describeResource(ics,settings.timezone);if(!meta)continue;
  const namespace=meta.uid.match(/^an-([a-f0-9]{32})-[a-f0-9]{32}(?:@obsidian)?$/)?.[1];if(namespace&&namespace!==settings.namespace)continue;
  const match=meta.uid.match(new RegExp('^an-'+settings.namespace+'-([a-f0-9]{32})(?:@obsidian)?$')),id=match?.[1];
  if(id){knownPaths.set(url,id);if(protectedIds.has(id))continue;if(desired.get(id)?.kind===kind&&!indexes[kind].has(canonicalHref(kind,id))&&!paths.has(kind+':'+id))paths.set(kind+':'+id,url);else cleanup.push({url,etag,kind,id});}
  else if(kind==='reminders'&&meta.component==='VTODO'&&meta.done&&cloneKeys.has(meta.cloneKey)){const ids=cloneKeys.get(meta.cloneKey);if(ids.length===1)cleanup.push({url,etag,kind,id:ids[0]});}
 }
 // Delete the previous representation first: a failed move leaves a retryable gap, never a second reminder.
 for(const kind of ['reminders','calendar'])for(const [url,etag] of indexes[kind]){
  const id=ownId(url);if(!id||protectedIds.has(id))continue;const task=desired.get(id);if(task?.kind===kind){if(url!==href(kind,id)&&!cleanup.some(x=>x.url===url))cleanup.push({url,etag,kind,id});continue;}
  await guard();await transport.mutation('DELETE',url,undefined,etag);indexes[kind].delete(url);delete state[kind+':'+id];deletes++;changedIds.add(id);await save();log('delete',kind,id);
 }
 for(const [id,task] of desired){
  const kind=task.kind,url=href(kind,id),etag=indexes[kind].get(url),key=kind+':'+id,hash=semantic(task,settings.timezone,settings.leadMinutes,vault),record=state[key];
  if(etag&&record?.hash===hash&&record.etag===etag){if(record.href!==url){record.href=url;await save();}continue;}
  if(etag&&record?.hash===hash&&transport.matches&&await transport.matches(url,etag,payloads.get(id))){state[key]={hash,etag,path:task.path,href:url};await save();log('confirmed',kind,id);continue;}
  await guard();const body=payloads.get(id);
  const reason=!etag?'создание':record?.hash!==hash?'изменения в Obsidian':!record.etag?'не была подтверждена версия записи':'изменения на сервере';
  const nextEtag=await transport.mutation('PUT',url,body,etag);state[key]={hash,etag:nextEtag,path:task.path,href:url};writes++;changedIds.add(id);await save();log('put',kind,id,reason);
 }
 for(const item of cleanup){if(protectedIds.has(item.id)||!indexes[item.kind].has(item.url)||item.url===href(item.kind,item.id)&&desired.get(item.id)?.kind===item.kind)continue;await guard();await transport.mutation('DELETE',item.url,undefined,item.etag);indexes[item.kind].delete(item.url);deletes++;changedIds.add(item.id);log('delete',item.kind,item.id,'выполненная копия или лишняя запись той же задачи');}
 for(const key of Object.keys(state)){const [kind,id]=key.split(':');if(!desired.has(id)&&!protectedIds.has(id)&&!indexes[kind]?.has(href(kind,id)))delete state[key];}
 return {writes,deletes,changed:changedIds.size,issues,selected:desired.size,collections};
}
module.exports={publish};

},
"identity":function(module,exports,require){
"use strict";
// A Tasks/Abyss recurrence completion can copy the entire Markdown line, including our ID.
// Only repair an identifiable generation chain; unrelated/ambiguous copies stay protected.
function recurrenceRepairs(tasks,state={}){
 const groups=new Map(),result=[];
 for(const t of tasks)if(t.id){if(!groups.has(t.id))groups.set(t.id,[]);groups.get(t.id).push(t);}
 for(const [id,rows]of groups){
  if(rows.length<2||rows.some(t=>!t.eligible||t.error||!t.date)||rows.filter(t=>!t.done).length>1||!rows.some(t=>t.done))continue;
  const family=t=>t.repeatText?.toLowerCase().replace(/\s+/g,' ').trim()||(/(?:^|\s)#task\/(?:regular|recurring)(?=\s|$)/u.test(t.rawLine)?'@regular':'');
  const families=new Set(rows.map(family).filter(Boolean));if(families.size!==1||rows.some(t=>!t.done&&!family(t)||t.title!==rows[0].title))continue;
  if(new Set(rows.map(t=>t.date)).size!==rows.length||rows.some(t=>(t.rawLine.match(/<!-- (?:dav|gcal):[a-f0-9]{32} -->/g)||[]).length!==1))continue;
  const records=['reminders','calendar'].map(k=>state[k+':'+id]).filter(Boolean),dates=new Set();
  for(const record of records){try{const hash=JSON.parse(record.hash);if(Array.isArray(hash)&&hash[1]===rows[0].title&&/^\d{4}-\d{2}-\d{2}$/.test(hash[3]))dates.add(hash[3]);}catch{/* Earliest generation remains the fallback when no usable checkpoint exists. */}}
  if(dates.size>1)continue;
  const savedDate=[...dates][0],keeper=rows.find(t=>t.date===savedDate)||rows.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.path.localeCompare(b.path)||a.line-b.line)[0];
  for(const t of rows)if(t!==keeper)result.push({task:t,oldId:id});
 }
 return result;
}
module.exports={recurrenceRepairs};

},
"mobile-network":function(module,exports,require){
"use strict";
// Keep desktop requests unchanged. iOS explicitly receives UTF-8 bytes and normalized headers.
function createDavRequest(nativeRequest,{ios=false,timeoutMs=120000}={}){
 const platform = ios ? 'iOS' : 'Obsidian';
 const pending=new Map();let stalled=0;
 return async params=>{
  if(stalled){const e=Error('Предыдущий запрос '+platform+' ещё не завершён. Новые запросы приостановлены, чтобы не повторить запись.');e.code='DAV_IN_FLIGHT';throw e;}
  const headers=Object.fromEntries(Object.entries(params.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
  if(params.contentType&&!headers['content-type'])headers['content-type']=params.contentType;
  let body=params.body;
  if(ios && typeof body==='string'){const bytes=new TextEncoder().encode(body);body=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}
  const key=JSON.stringify([params.url,params.method,headers.authorization||'',typeof params.body==='string'?params.body:'']);
  if(pending.has(key)){const e=Error('Этот запрос уже выполняется.');e.code='DAV_IN_FLIGHT';throw e;}
  const record={timedOut:false};pending.set(key,record);let timer;
  const operation=Promise.resolve().then(()=>nativeRequest(ios ? {...params,headers,...(body!==undefined?{body}:{})} : params));
  const settled=operation.finally(()=>{pending.delete(key);if(record.timedOut)stalled--;});
  try{return await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>{record.timedOut=true;stalled++;const e=Error(platform+' не завершил запрос за '+Math.round(timeoutMs/1000)+' секунд. Ожидание прекращено; нативный запрос не отменён.');e.code='DAV_TIMEOUT';reject(e);},timeoutMs);})]);}
  finally{clearTimeout(timer);}
 };
}
module.exports={createDavRequest};

},
"marker-ui":function(module,exports,require){
"use strict";
const markerPattern=()=>/<!-- (?:gcal|dav):[a-f0-9]{32} -->/g;
const selector='.abyss-calendar-item, .abyss-calendar-title, .abyss-calendar-preview-title';
const wrapperSelector='span.task-calendar-bridge-hidden-marker';
function wrapMarkerText(node){
  const text=node.nodeValue,pattern=markerPattern();let match,last=0,changed=false;
  const doc=node.ownerDocument,fragment=doc.createDocumentFragment();
  while((match=pattern.exec(text))){
    changed=true;
    if(match.index>last)fragment.appendChild(doc.createTextNode(text.slice(last,match.index)));
    const span=doc.createElement('span');span.className='task-calendar-bridge-hidden-marker';
    span.hidden=true;span.setAttribute('aria-hidden','true');span.style.display='none';
    span.textContent=match[0];fragment.appendChild(span);last=match.index+match[0].length;
  }
  if(!changed)return false;
  if(last<text.length)fragment.appendChild(doc.createTextNode(text.slice(last)));
  node.replaceWith(fragment);return true;
}
function installAbyssMarkerHider(owner,doc){
  if(!doc?.body||typeof MutationObserver==='undefined')return ()=>{};
  let stopped=false;
  function restore(){
    for(const span of doc.querySelectorAll(wrapperSelector))span.replaceWith(doc.createTextNode(span.textContent));
  }
  function clean(root){
    if(stopped||!owner.settings.hideMarkers)return;
    // Only presentation nodes in the Abyss calendar; never editors, task data,
    // source notes, event handlers, or the Abyss plugin's files/settings.
    const walker=doc.createTreeWalker(root,4),nodes=[];let node;
    while((node=walker.nextNode())){
      const parent=node.parentElement;
      if(parent&&!parent.closest(wrapperSelector)&&!parent.closest('input,textarea,[contenteditable="true"],.cm-editor')&&markerPattern().test(node.nodeValue))nodes.push(node);
    }
    for(const text of nodes)wrapMarkerText(text);
  }
  function scan(node){
    if(!owner.settings.hideMarkers)return;
    const element=node.nodeType===1?node:node.parentElement;
    if(!element)return;
    const parent=element.closest(selector);
    if(parent)clean(parent);
    else for(const root of element.querySelectorAll(selector))clean(root);
  }
  const observer=new MutationObserver(records=>{
    for(const record of records){
      if(record.type==='characterData')scan(record.target);
      else for(const node of record.addedNodes)scan(node);
    }
  });
  observer.observe(doc.body,{subtree:true,childList:true,characterData:true});
  scan(doc.body);
  const refresh=()=>{if(owner.settings.hideMarkers)scan(doc.body);else restore();};
  owner.refreshAbyssMarkers=refresh;
  return ()=>{stopped=true;observer.disconnect();restore();if(owner.refreshAbyssMarkers===refresh)delete owner.refreshAbyssMarkers;};
}
module.exports={installAbyssMarkerHider,wrapMarkerText};

}};const cache={};function localRequire(name){if(!name.startsWith("./"))return nativeRequire(name);const key=name.slice(2);if(!cache[key]){const m={exports:{}};cache[key]=m;factories[key](m,m.exports,localRequire);}return cache[key].exports;}module.exports=localRequire("./main.source");
