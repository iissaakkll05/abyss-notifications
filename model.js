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
  try{task.rule=recurrence(repeat)[0]?.replace(/^RRULE:/,'')||'';}catch(e){task.error=e.message;}
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
function semantic(task,zone,lead,vault){return JSON.stringify(['plain-description-v4',task.title,task.description,task.date,task.startDate,task.rangeDays,task.time,task.duration,task.done,task.rule,task.completed,task.created,task.path,zone,lead,vault]);}
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
 else if(task.rule&&!task.done)lines.push('RRULE:'+task.rule);
 if(!task.done&&task.time)lines.push('BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:'+escape(task.title),'TRIGGER;RELATED=START:'+(lead?'-PT'+lead+'M':'PT0S'),'END:VALARM');
 lines.push('END:'+kind,'END:VCALENDAR');return lines.map(fold).join('\r\n')+'\r\n';
}
module.exports={parseFile,duration,serialize,semantic};
