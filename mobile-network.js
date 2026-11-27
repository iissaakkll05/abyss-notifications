"use strict";
// Keep desktop requests unchanged. iOS explicitly receives UTF-8 bytes and normalized headers.
function createDavRequest(nativeRequest,{ios=false,timeoutMs=120000}={}){
 const platform = ios ? 'iOS' : 'Obsidian';
 const pending=new Map();let stalledWrites=0,stalledReads=0;
 return async params=>{
  if(stalledWrites || stalledReads>=3){const e=Error('Предыдущий запрос '+platform+' ещё не завершён. Новые запросы приостановлены, чтобы не повторить запись.');e.code='DAV_IN_FLIGHT';throw e;}
  const headers=Object.fromEntries(Object.entries(params.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
  if(params.contentType&&!headers['content-type'])headers['content-type']=params.contentType;
  let body=params.body;
  if(ios && typeof body==='string'){const bytes=new TextEncoder().encode(body);body=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}
  const key=JSON.stringify([params.url,params.method,headers.authorization||'',typeof params.body==='string'?params.body:'']);
  if(pending.has(key)){const e=Error('Этот запрос уже выполняется.');e.code='DAV_IN_FLIGHT';throw e;}
  const readOnly=/^(?:GET|HEAD|OPTIONS|PROPFIND|REPORT)$/i.test(params.method||'GET');
  const record={timedOut:false};pending.set(key,record);let timer;
  const operation=Promise.resolve().then(()=>nativeRequest(ios ? {...params,headers,...(body!==undefined?{body}:{})} : params));
  const settled=operation.finally(()=>{if(pending.get(key)===record)pending.delete(key);if(record.timedOut){if(readOnly)stalledReads--;else stalledWrites--;}});
  try{return await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>{record.timedOut=true;if(readOnly){stalledReads++;pending.delete(key);}else stalledWrites++;const e=Error(platform+' не завершил запрос за '+Math.round(timeoutMs/1000)+' секунд. Ожидание прекращено; нативный запрос не отменён.');e.code='DAV_TIMEOUT';reject(e);},timeoutMs);})]);}
  finally{clearTimeout(timer);}
 };
}
module.exports={createDavRequest};
