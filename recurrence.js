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
  const m = s.match(/^every(?: (\d+))? (day|days|week|weeks|month|months|year|years|weekday|weekdays)(?: on (.+))?$/);
  if (!m || Number(m[1] || 1)<1) throw new Error('Неподдерживаемый повтор: '+text);
  const freq = {day:'DAILY',week:'WEEKLY',month:'MONTHLY',year:'YEARLY',weekday:'WEEKLY'}[m[2].replace(/s$/, '')];
  let rule = 'RRULE:FREQ='+freq+';INTERVAL='+(m[1]||1);
  if (m[2].startsWith('weekday')) rule+=';BYDAY=MO,TU,WE,TH,FR';
  if (m[3]) {
    const days = {monday:'MO',tuesday:'TU',wednesday:'WE',thursday:'TH',friday:'FR',saturday:'SA',sunday:'SU'};
    const parts = m[3].split(/\s*,\s*|\s+and\s+/).map(x=>days[x.trim()]);
    if (freq!=='WEEKLY' || parts.some(x=>!x)) throw new Error('Поддерживается «every week on Monday, Friday»; сложный повтор не отправлен.');
    rule+=';BYDAY='+parts.join(',');
  }
  if (until) rule+=';UNTIL='+until[1].replace(/-/g,'')+'T235959Z';
  return [rule];
}

module.exports={validDate,recurrence};
