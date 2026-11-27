"use strict";
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
}
function recurrence(text) {
  if (!text) return [];
  let s = text.toLowerCase().trim();
  if (s.includes('when done')) throw new Error('Повтор «when done» зависит от выполнения. Его нельзя точно перенести в календарь.');
  const until = s.match(/ until (\d{4}-\d{2}-\d{2})$/);
  if (until) { if (!validDate(until[1])) throw new Error('Некорректная дата окончания повтора'); s = s.slice(0,until.index); }
  const days = {monday:'MO',tuesday:'TU',wednesday:'WE',thursday:'TH',friday:'FR',saturday:'SA',sunday:'SU'};
  const months = 'january february march april may june july august september october november december'.split(' ');
  // Abyss uses a month name in place of "year" for yearly rules with interval one.
  s = s.replace(/^every ([a-z]+) on the (.+)$/, (original, month, day) =>
    months.includes(month) ? 'every year on '+month+' '+day : original);
  const m = s.match(/^every(?: (\d+))? (day|days|week|weeks|month|months|year|years|weekday|weekdays)(?: on (.+))?$/);
  if (!m || Number(m[1] || 1)<1) throw new Error('Неподдерживаемый повтор: '+text);
  const freq = {day:'DAILY',week:'WEEKLY',month:'MONTHLY',year:'YEARLY',weekday:'WEEKLY'}[m[2].replace(/s$/, '')];
  let rule = 'RRULE:FREQ='+freq+';INTERVAL='+(m[1]||1);
  if (m[2].startsWith('weekday')) rule+=';BYDAY=MO,TU,WE,TH,FR';
  if (m[3]) {
    const value = m[3].replace(/^the /,'');
    if (freq==='WEEKLY') {
      const parts = value.split(/,\s*(?:and\s+)?|\s+and\s+/).map(x=>days[x.trim()]);
      if (parts.some(x=>!x)) throw Error('Некорректные дни недели');
      rule+=';BYDAY='+parts.join(',');
    } else if (freq==='MONTHLY') {
      const match = /^(first|last|2nd last|\d+(?:st|nd|rd|th))(?: ([a-z]+))?$/.exec(value);
      if (!match) throw Error('Неизвестный месячный повтор');
      const ordinal = ({first:1,last:-1,'2nd last':-2})[match[1]] ?? parseInt(match[1],10);
      if (!ordinal || ordinal>(match[2]?5:31) || (match[2]&&!days[match[2]])) throw Error('Некорректный день месяца');
      rule+=match[2]?';BYDAY='+ordinal+days[match[2]]:';BYMONTHDAY='+ordinal;
    } else if (freq==='YEARLY') {
      const match = /^([a-z]+) (\d+)(?:st|nd|rd|th)$/.exec(value);
      const month = match ? months.indexOf(match[1])+1 : 0;
      if (!month || !validDate('2000-'+String(month).padStart(2,'0')+'-'+match[2].padStart(2,'0'))) throw Error('Некорректная дата ежегодного повтора');
      rule+=';BYMONTH='+month+';BYMONTHDAY='+Number(match[2]);
    } else throw Error('Неизвестный повтор');
  }
  if (until) rule+=';UNTIL='+until[1].replace(/-/g,'')+'T235959Z';
  return [rule];
}

module.exports={validDate,recurrence};
