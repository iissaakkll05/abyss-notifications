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
