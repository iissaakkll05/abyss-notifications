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
function hideMarkers(owner){return ViewPlugin.fromClass(class{
 constructor(view){this.update({view});}update({view}){const ranges=[];if(owner.settings.hideMarkers)for(const v of view.visibleRanges){const start=view.state.doc.lineAt(v.from).from,end=view.state.doc.lineAt(v.to).to,text=view.state.doc.sliceString(start,end);for(const m of text.matchAll(/<!-- (?:dav|gcal):[a-f0-9]{32} -->/g))ranges.push(Decoration.replace({}).range(start+m.index,start+m.index+m[0].length));}this.decorations=Decoration.set([...new Map(ranges.map(r=>[r.from,r])).values()].sort((a,b)=>a.from-b.from));}
 },{decorations:v=>v.decorations,provide:p=>EditorView.atomicRanges.of(v=>v.plugin(p)?.decorations||Decoration.none)});}
module.exports=class Notifications extends Plugin{
 async onload(){
  const stored=await this.loadData();this.settings={...defaults,...stored,hideMarkers:true};if(!/^[a-f0-9]{32}$/.test(this.settings.namespace))this.settings.namespace=uid();
  if(!stored){try{const path=(this.app.vault.configDir||'.obsidian')+'/plugins/task-calendar-bridge/data.json';if(await this.app.vault.adapter.exists(path)){const old=JSON.parse(await this.app.vault.adapter.read(path));this.settings.server=old.davServer||defaults.server;this.settings.user=old.davUser||'';this.settings.password=old.davPassword||'';this.settings.timezone=old.timezone||defaults.timezone;}}catch{/* Connection can be configured manually. */}}
  this.settings.state=this.settings.state||{};this.cache=new Map();this.writing=new Set();this.revision=0;this.logRows=[];this.stopped=false;this.running=false;this.lastEdit=0;this.errors=[];
  try{const logPath=this.manifest.dir+'/journal-'+(Platform.isIosApp?'ios':Platform.isAndroidApp?'android':'desktop')+'.log';if(await this.app.vault.adapter.exists(logPath))this.logRows=(await this.app.vault.adapter.read(logPath)).split('\n').filter(Boolean).slice(-150);}catch{/* A missing journal is normal on first launch. */}
  this.native=createDavRequest(requestUrl,{ios:!!Platform.isIosApp});this.addSettingTab(new Settings(this.app,this));
  this.addCommand({id:'sync',name:'Синхронизировать сейчас',callback:()=>this.sync(true)});
  this.addCommand({id:'status',name:'Состояние и пропущенные задачи',callback:()=>this.showStatus()});
  this.addCommand({id:'log',name:'Открыть журнал',callback:()=>this.showLog()});
  this.registerEditorExtension(hideMarkers(this));this.stopHider=installAbyssMarkerHider(this,document);
  for(const name of ['create','modify','delete','rename'])this.registerEvent(this.app.vault.on(name,(f)=>{if(f.extension==='md'&&!this.writing.has(f.path)){this.cache.delete(f.path);this.revision++;this.lastEdit=Date.now();this.schedule();}}));
  this.registerDomEvent(document,'visibilitychange',()=>{clearTimeout(this.timer);if(!document.hidden)this.schedule();});
  this.restartPolling();this.app.workspace.onLayoutReady(()=>this.schedule());await this.save();this.log('Плагин запущен');
 }
 onunload(){this.stopped=true;clearTimeout(this.timer);clearInterval(this.pollTimer);this.stopHider?.();}
 allowed(){return this.settings.enabled&&(this.settings.devices==='both'||this.settings.devices===(Platform.isMobileApp||Platform.isIosApp||Platform.isAndroidApp?'mobile':'desktop'));}
 restartPolling(){clearInterval(this.pollTimer);clearTimeout(this.timer);if(this.allowed()&&!this.stopped)this.registerInterval(this.pollTimer=setInterval(()=>this.schedule(0),Math.max(60,this.settings.pollSeconds)*1000));}
 schedule(delay=500){if(this.stopped||!this.allowed()||document.hidden)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.sync(),Math.max(delay,this.lastEdit+this.settings.delaySeconds*1000-Date.now()));}
 eligible(path){return !path.split('/').some(p=>p.startsWith('.'))&&!path.includes('.sync-conflict-')&&!this.settings.exclude.split('\n').map(x=>x.trim()).filter(Boolean).some(x=>x.endsWith('/')?path.startsWith(x):path===x);}
 async save(){const data=JSON.stringify(this.settings);this.saveQueue=(this.saveQueue||Promise.resolve()).catch(()=>{}).then(async()=>{if(data!==this.saved){await this.saveData(JSON.parse(data));this.saved=data;}});await this.saveQueue;}
 async onExternalSettingsChange(){const data=await this.loadData();if(this.running){if(data){this.settings.devices=data.devices||'mobile';this.settings.enabled=data.enabled!==false;}this.externalPending=true;return;}if(data){Object.assign(this.settings,data);this.saved=JSON.stringify(this.settings);this.cache.clear();this.restartPolling();this.schedule();}}
 log(message,meta=''){this.logRows.push(new Date().toISOString()+' '+message+(meta?' · '+meta:''));if(this.logRows.length>200)this.logRows.shift();this.logDirty=true;}
 async flushLog(){if(!this.logDirty)return;this.logDirty=false;try{await this.app.vault.adapter.write(this.manifest.dir+'/journal-'+(Platform.isIosApp?'ios':Platform.isAndroidApp?'android':'desktop')+'.log',this.logRows.join('\n'));}catch{/* Journal failure cannot block export. */}}
 showLog(){new TextModal(this.app,'Журнал Abyss Notifications',this.logRows.join('\n')||'Обмен ещё не запускался.').open();}
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
  if(this.running){if(manual)this.manualQueued=true;return;}
  if(this.legacyActive()){this.phase='Сначала отключи старый Abyss Fruux Bridge: оба плагина одновременно не работают.';if(manual)new Notice(this.phase,8000);return;}
  if(!this.settings.user||!this.settings.password){if(manual)new Notice('Укажи данные fruux в настройках Abyss Notifications.');return;}
  if(Date.now()-this.lastEdit<this.settings.delaySeconds*1000){this.phase='Ожидаю окончания ввода';if(manual)new Notice('Закончи ввод и повтори команду через несколько секунд.');else this.schedule();return;}
  this.running=true;clearTimeout(this.timer);this.errors=[];this.result=null;const revision=this.revision,start=Date.now();let requests=0;
  const guard=async()=>{if(this.stopped||document.hidden||this.revision!==revision||!manual&&!this.allowed()){const e=Error('Обмен отложен: заметка меняется или приложение скрыто.');e.deferred=true;throw e;}};
  const settings={...this.settings};this.phase='Отправляю задачи';this.log('Начало обмена',manual?'вручную':'автоматически');
  try{
   let tasks=await this.snapshot();await guard();tasks=await this.assignIds(tasks,guard);await guard();
   this.errors=tasks.filter(t=>t.selected&&t.error).map(t=>({path:t.path,line:t.line,title:t.title,message:t.error}));
   const account=JSON.stringify([settings.server,settings.user]);if(this.settings.account!==account){this.settings.state={};this.settings.account=account;}
   const transport=new Transport(async p=>{await guard();requests++;this.log('Запрос',p.method+' → '+new URL(p.url).hostname);try{const r=await this.native(p);this.log('Ответ',p.method+' HTTP '+r.status);return r;}catch{throw Error('Нет ответа CalDAV. Проверь доступ к fruux из Obsidian; повторим при следующем обмене.');}},{davServer:settings.server,davUser:settings.user,davPassword:settings.password,timezone:settings.timezone,davHomeHint:this.settings.homeAccount===account?this.settings.home:''});
   transport.resourceCache=this.remoteResources||(this.remoteResources=new Map());
   this.result=await publish({tasks,transport,settings,vault:this.app.vault.getName(),state:this.settings.state,guard,save:()=>this.save(),log:(op,kind,id,reason)=>this.log(op==='put'?'Запись отправлена':op==='confirmed'?'Версия подтверждена без повторной отправки':'Запись удалена',[kind,reason].filter(Boolean).join(' · '))});
   this.settings.home=transport.homeUrl;this.settings.homeAccount=account;this.errors=[...new Map([...this.errors,...this.result.issues].map(x=>[x.path+':'+x.line+':'+x.message,x])).values()];this.phase=(this.errors.length?'Частично: ':'Готово: ')+'изменено задач '+this.result.changed+(this.errors.length?'; пропущено '+this.errors.length:'');this.lastSuccess=new Date().toLocaleString();this.errorNotified=false;await this.save();if(manual)new Notice(this.phase,6000);
  }catch(e){if(e.deferred){this.phase=e.message;this.log('Тихий повтор');this.schedule();}else{this.phase=e.message;this.log('Ошибка',/^CalDAV: HTTP \d+ при [A-Z]+\.$/.test(e.message)?e.message:'Обмен не завершён; проверь подключение и состояние');if(manual||!this.errorNotified)new Notice('Abyss Notifications: '+e.message,7000);this.errorNotified=true;}}
  finally{this.running=false;this.log('Завершение','запросов '+requests+', мс '+(Date.now()-start));await this.flushLog();if(this.externalPending){this.externalPending=false;await this.onExternalSettingsChange();}if(this.manualQueued){this.manualQueued=false;await this.sync(true);}else if(this.revision!==revision)this.schedule();}
 }
};
class Settings extends PluginSettingTab{
 constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
 display(){
  const p=this.plugin,s=p.settings,e=this.containerEl;e.empty();e.addClass('an-settings');e.createEl('h2',{text:'Abyss Notifications · 1.0.8'});e.createEl('p',{text:'Obsidian → fruux → телефон. Дата без времени — напоминание без сигнала; одно время — напоминание с сигналом; длительность — событие.'});
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
