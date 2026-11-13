"use strict";
// Keep desktop requests unchanged. iOS explicitly receives UTF-8 bytes and normalized headers.
function createDavRequest(nativeRequest,{ios=false,timeoutMs=120000}={}){
 if(!ios)return nativeRequest;
 const pending=new Map();let stalled=0;
 return async params=>{
  if(stalled){const e=Error('Предыдущий запрос iOS ещё не завершён. Новые запросы приостановлены, чтобы не повторить запись.');e.code='DAV_IN_FLIGHT';throw e;}
  const headers=Object.fromEntries(Object.entries(params.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
  if(params.contentType&&!headers['content-type'])headers['content-type']=params.contentType;
  let body=params.body;
  if(typeof body==='string'){const bytes=new TextEncoder().encode(body);body=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}
  const key=JSON.stringify([params.url,params.method,headers.authorization||'',typeof params.body==='string'?params.body:'']);
  if(pending.has(key)){const e=Error('Этот запрос уже выполняется на iOS.');e.code='DAV_IN_FLIGHT';throw e;}
  const record={timedOut:false};pending.set(key,record);let timer;
  const operation=Promise.resolve().then(()=>nativeRequest({...params,headers,...(body!==undefined?{body}:{})}));
  const settled=operation.finally(()=>{pending.delete(key);if(record.timedOut)stalled--;});
  try{return await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>{record.timedOut=true;stalled++;const e=Error('iOS не завершил запрос за '+Math.round(timeoutMs/1000)+' секунд. Ожидание прекращено; нативный запрос не отменён.');e.code='DAV_TIMEOUT';reject(e);},timeoutMs);})]);}
  finally{clearTimeout(timer);}
 };
}
module.exports={createDavRequest};
