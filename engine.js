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
