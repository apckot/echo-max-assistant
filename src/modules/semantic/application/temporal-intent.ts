import type {GroundedMeaning} from './quote-grounding.js';
export interface TemporalIssue {readonly code:'TIME_INTENT_MISMATCH'|'TIME_INTENT_UNPROVEN'|'TIME_SCOPE_INVALID'|'TIME_SHARED_WITH_LIFECYCLE';readonly actionLabel?:string}
export interface TemporalCheck {readonly ok:boolean;readonly issues:readonly TemporalIssue[]}
const boundary='(?:^|[^\\p{L}\\p{N}])';
const deadlineCue=new RegExp(boundary+'(?:срок[а-яё]*|дедлайн[а-яё]*|не\\s+позднее|(?:до|к)(?=\\s|[0-9]))','iu');
const clockCue=new RegExp(boundary+'(?:в\\s*(?:[0-9]{1,2}(?::[0-9]{2})?|(?:один|дв|тр|четыр|пят|шест|сем|восем|девят|десят)[а-яё]*)|на\\s*[0-9]{1,2}:[0-9]{2})(?![0-9])','iu');
const dateCue=new RegExp(boundary+'(?:(?:после)?завтра|сегодня|понедельник[а-яё]*|вторник[а-яё]*|сред[ауы]|четверг[а-яё]*|пятниц[ауы]|суббот[ауы]|воскресень[ея]|[0-9]{4}-[0-9]{2}-[0-9]{2})(?![\\p{L}\\p{N}])','iu');
/** Bounded source-evidence guard, not a complete natural-language date parser. Unknown intent fails closed. */
export function validateTemporalIntent(grounded:GroundedMeaning):TemporalCheck{
 const d=grounded.decision,issues:TemporalIssue[]=[];
 const terminal=new Set(d.actions.filter(a=>['complete','cancel','reopen'].includes(a.kind)).map(a=>a.unitLabel));
 for(const r of d.relations)if(r.kind==='shared_time'&&[r.fromLabel,...r.toLabels].some(l=>terminal.has(l)))issues.push({code:'TIME_SHARED_WITH_LIFECYCLE'});
 for(const action of d.actions)for(const time of action.times){
  if(time.scopeUnitLabels.length!==1||time.scopeUnitLabels[0]!==action.unitLabel||terminal.has(action.unitLabel))issues.push({code:'TIME_SCOPE_INVALID',actionLabel:action.label});
  // These are internally grounded exact quotes, never the model's computed offsets or field name as authority.
  const quotes=time.evidence.map(e=>e.quote),own=d.units.find(u=>u.label===action.unitLabel)?.evidence.map(e=>e.quote)??[];
  if(!quotes.length){issues.push({code:'TIME_INTENT_UNPROVEN',actionLabel:action.label});continue;}
  const expressionDeadline=deadlineCue.test(time.expression),expressionClock=clockCue.test(time.expression),expressionDate=dateCue.test(time.expression)||/[0-9]{1,2}\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/iu.test(time.expression);
  const namedDeadline=own.some(q=>/срок|дедлайн/iu.test(q));
  const sourceDeadline=namedDeadline||quotes.some(q=>deadlineCue.test(q)),sourceClock=quotes.some(q=>clockCue.test(q)),sourceDate=quotes.some(q=>dateCue.test(q)||/[0-9]{1,2}\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/iu.test(q));
  let expected:'deadline'|'scheduledAt'|'targetDate'|null=null;
  // Expressions select the temporal slot; literal, grounded source quotes must independently justify its category.
  // This is date-language parsing, never fuzzy quote search or rewriting a wrongly declared field.
  if(namedDeadline&&(expressionDate||expressionClock||expressionDeadline))expected='deadline';
  else if(expressionDeadline&&sourceDeadline)expected='deadline';
  else if(expressionClock&&sourceClock)expected='scheduledAt';
  else if(expressionDate&&sourceDate)expected='targetDate';
  if(expected===null)issues.push({code:'TIME_INTENT_UNPROVEN',actionLabel:action.label});
  else if(time.field!==expected)issues.push({code:'TIME_INTENT_MISMATCH',actionLabel:action.label});
 }
 return {ok:issues.length===0,issues};
}
