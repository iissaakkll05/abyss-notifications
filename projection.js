"use strict";
const {localEpoch}=require('./time');
const unescape=s=>(s||'').replace(/\\[nN]/g,'\n').replace(/\\([,;\\])/g,'$1');
function fields(lines){return lines.map(l=>{const i=l.indexOf(':');if(i<0)return null;const [name,...rest]=l.slice(0,i).split(';'),params={};for(const r of rest){const e=r.indexOf('=');if(e>=0)params[r.slice(0,e).toUpperCase()]=r.slice(e+1).replace(/^"|"$/g,'');}return{name:name.toUpperCase(),params,value:l.slice(i+1)};}).filter(Boolean);}
function timestamp(p,zone){
 if(!p)return null;const m=p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);if(!m)throw Error('Unsupported date');
 if(!m[4])return m[1]+'-'+m[2]+'-'+m[3];
 return m[7]?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]):localEpoch(m[1]+'-'+m[2]+'-'+m[3],m[4]+':'+m[5],p.params.TZID||zone)+(+m[6])*1000;
}
function comparable(ics,zone){
 const lines=ics.replace(/\r?\n[ \t]/g,'').split(/\r?\n/),starts=lines.filter(l=>/^BEGIN:V(?:TODO|EVENT)$/.test(l));if(starts.length!==1)throw Error('Complex resource');
 const component=starts[0].slice(6),from=lines.indexOf(starts[0]),top=[],alarms=[];let depth=0,block=[];
 for(const l of lines.slice(from+1)){if(l==='END:'+component&&depth===0)break;if(l.startsWith('BEGIN:')){if(!depth)block=[];depth++;block.push(l);continue;}if(l.startsWith('END:')){block.push(l);depth--;if(!depth&&block[0]==='BEGIN:VALARM')alarms.push(block);continue;}if(depth)block.push(l);else top.push(l);}
 const props=fields(top),get=n=>props.find(p=>p.name===n),start=timestamp(get('DTSTART'),zone),end=timestamp(get(component==='VEVENT'?'DTEND':'DUE'),zone),date=component==='VEVENT'?[start,end]:[end??start];
 // Obsidian exposes minute precision; tolerate the compatibility second added to VTODO DUE.
 const dates=date.map(t=>typeof t==='number'?Math.floor(t/60000):t);
 const rule=(get('RRULE')?.value||'').toUpperCase().split(';').filter(Boolean).filter(x=>x!=='INTERVAL=1'&&x!=='WKST=MO').map(x=>/^BY[A-Z]+=/.test(x)?x.split('=')[0]+'='+x.split('=')[1].split(',').sort().join(','):x).sort().join(';');
 const alarmValues=[];
 for(const block of alarms){if(block.some(l=>/^(?:(?:X-APPLE-)?PROXIMITY|(?:X-APPLE-)?STRUCTURED-LOCATION|GEO)[;:]/i.test(l)))continue;const a=fields(block),trigger=a.find(p=>p.name==='TRIGGER'),action=a.find(p=>p.name==='ACTION')?.value||'DISPLAY';if(!trigger)throw Error('Missing trigger');let time;
  const d=trigger.value.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if(d){const anchor=trigger.params.RELATED==='END'?end:start;if(typeof anchor!=='number')throw Error('Missing alarm anchor');time=anchor+(d[1]?-1:1)*((+d[2]||0)*604800+(+d[3]||0)*86400+(+d[4]||0)*3600+(+d[5]||0)*60+(+d[6]||0))*1000;}
  else time=timestamp(trigger,zone);
  alarmValues.push([action,typeof time==='number'?Math.floor(time/60000):time,a.find(p=>p.name==='REPEAT')?.value||'',a.find(p=>p.name==='DURATION')?.value||'']);
 }
 const done=component==='VTODO'?['COMPLETED','CANCELLED'].includes(get('STATUS')?.value)||get('PERCENT-COMPLETE')?.value==='100':get('X-OBSIDIAN-COMPLETED')?.value==='TRUE'||/^✅\s/.test(unescape(get('SUMMARY')?.value));
 const exceptional=props.filter(p=>['RDATE','EXDATE','RECURRENCE-ID'].includes(p.name)).map(p=>[p.name,p.params,p.value]);
 return JSON.stringify([component,get('UID')?.value||'',unescape(get('SUMMARY')?.value),unescape(get('DESCRIPTION')?.value),get('URL')?.value||'',dates,done,rule,alarmValues.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),exceptional]);
}
function equivalent(actual,expected,zone){try{return comparable(actual,zone)===comparable(expected,zone);}catch{return false;}}
module.exports={equivalent};
