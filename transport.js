"use strict";
const {CaldavReader}=require('./discovery');
const DAV='DAV:';
const xml=s=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
class Transport extends CaldavReader{
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
  return r.headers?.etag||r.headers?.ETag||'';
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
