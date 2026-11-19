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
  for(const record of records){try{const hash=JSON.parse(record.hash);if(Array.isArray(hash)&&typeof hash[1]==='string'&&hash[1].replace(/(?:^|\s)[🔺⏫🔼🔽⏬](?=\s|$)/gu,' ').replace(/\s+/g,' ').trim()===rows[0].title&&/^\d{4}-\d{2}-\d{2}$/.test(hash[3]))dates.add(hash[3]);}catch{/* Earliest generation remains the fallback when no usable checkpoint exists. */}}
  if(dates.size>1)continue;
  const savedDate=[...dates][0],keeper=rows.find(t=>t.date===savedDate)||rows.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.path.localeCompare(b.path)||a.line-b.line)[0];
  for(const t of rows)if(t!==keeper)result.push({task:t,oldId:id});
 }
 return result;
}
module.exports={recurrenceRepairs};
