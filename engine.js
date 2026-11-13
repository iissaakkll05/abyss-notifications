"use strict";
const {semantic,serialize}=require('./model');
async function publish({tasks,transport,settings,vault,state,save,guard=async()=>{},log=()=>{}}){
 const collections=await transport.ensure(settings.namespace,vault),indexes={};for(const kind of ['reminders','calendar'])indexes[kind]=await transport.index(collections[kind]);
 const desired=new Map(),protectedIds=new Set(),issues=[],counts=new Map();let writes=0,deletes=0;
 for(const t of tasks)if(t.id)counts.set(t.id,(counts.get(t.id)||0)+1);
 for(const task of tasks){if(!task.id)continue;if(counts.get(task.id)>1){protectedIds.add(task.id);issues.push({path:task.path,line:task.line,title:task.title,message:'Скопирована служебная метка. Удали метку у копии задачи; её записи пока сохранены без изменений.'});continue;}if(task.error){protectedIds.add(task.id);issues.push({path:task.path,line:task.line,title:task.title,message:task.error});continue;}if(task.selected)desired.set(task.id,task);}
 const href=(kind,id)=>new URL('an-'+settings.namespace+'-'+id+'.ics',collections[kind]).href;
 const ownId=url=>{const u=new URL(url),m=decodeURIComponent(u.pathname.split('/').pop()).match(new RegExp('^an-'+settings.namespace+'-([a-f0-9]{32})\\.ics$'));return m?.[1];};
 for(const [id,task] of desired)if(task.done&&!['reminders','calendar'].some(k=>indexes[k].has(href(k,id))||state[k+':'+id]))desired.delete(id);
 // Validate every desired payload before deleting or moving any record.
 const payloads=new Map();for(const [id,task] of desired)try{payloads.set(id,serialize(task,{namespace:settings.namespace,zone:settings.timezone,lead:settings.leadMinutes,vault}));}catch(e){protectedIds.add(id);desired.delete(id);issues.push({path:task.path,line:task.line,title:task.title,message:e.message});}
 // Delete the previous representation first: a failed move leaves a retryable gap, never a second reminder.
 for(const kind of ['reminders','calendar'])for(const [url,etag] of indexes[kind]){
  const id=ownId(url);if(!id||protectedIds.has(id))continue;const task=desired.get(id);if(task?.kind===kind)continue;
  await guard();await transport.mutation('DELETE',url,undefined,etag);indexes[kind].delete(url);delete state[kind+':'+id];deletes++;await save();log('delete',kind,id);
 }
 for(const [id,task] of desired){
  const kind=task.kind,url=href(kind,id),etag=indexes[kind].get(url),key=kind+':'+id,hash=semantic(task,settings.timezone,settings.leadMinutes,vault),record=state[key];
  if(etag&&record?.hash===hash&&record.etag===etag)continue;
  await guard();const body=payloads.get(id);
  const nextEtag=await transport.mutation('PUT',url,body,etag);state[key]={hash,etag:nextEtag,path:task.path};writes++;await save();log('put',kind,id);
 }
 for(const key of Object.keys(state)){const [kind,id]=key.split(':');if(!desired.has(id)&&!protectedIds.has(id)&&!indexes[kind]?.has(href(kind,id)))delete state[key];}
 return {writes,deletes,issues,selected:desired.size,collections};
}
module.exports={publish};
