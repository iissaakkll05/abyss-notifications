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
