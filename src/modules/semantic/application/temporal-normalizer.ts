import type {TemporalPort} from '../../tasks/application/temporal-port.js';
import {validDate} from '../../tasks/domain/validation.js';
import type {ActionDraft} from '../domain/meaning-decision.js';
import type {GroundedMeaning} from './quote-grounding.js';
import {validateTemporalIntent} from './temporal-intent.js';
export type NormalizedTime={readonly field:'targetDate'|'deadline';readonly date:string}|{readonly field:'scheduledAt'|'deadline';readonly at:string};
export type TimeResolution={readonly status:'resolved';readonly values:readonly NormalizedTime[]}|{readonly status:'invalid';readonly reason:string}|{readonly status:'choice';readonly options:readonly {at:string;offset:string}[]};
const weekdays=[/воскресень/iu,/понедельник/iu,/вторник/iu,/сред[ауы]/iu,/четверг/iu,/пятниц[ауы]/iu,/суббот[ауы]/iu];
function shift(date:string,days:number){const d=new Date(date+'T12:00:00.000Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function dateExpression(text:string,today:string):string|null{
 const iso=text.match(/\b\d{4}-\d{2}-\d{2}\b/);if(iso)return validDate(iso[0])?iso[0]:null;
 const named=text.match(/(?:^|[^0-9])(\d{1,2})\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s*(\d{4})?/iu);
 if(named){const date=`${named[3]??today.slice(0,4)}-${String(months.indexOf(named[2]!.toLocaleLowerCase('ru'))+1).padStart(2,'0')}-${named[1]!.padStart(2,'0')}`;return validDate(date)?date:null;}
 if(/послезавтра/iu.test(text))return shift(today,2);if(/завтра/iu.test(text))return shift(today,1);if(/сегодня/iu.test(text))return today;
 const day=weekdays.findIndex(p=>p.test(text));if(day>=0){const current=new Date(today+'T12:00:00Z').getUTCDay(),delta=(day-current+7)%7;return shift(today,/прошл/iu.test(text)?delta===0?-7:delta-7:delta);}
 return null;
}
function clockExpression(text:string):string|null{
 const numeric=text.match(/(?:^|\s)(?:в|к|до|на)\s*(\d{1,2})(?::([0-9]+))?(?=$|[^\p{L}\p{N}:])/iu);
 if(numeric&&months.some(month=>text.slice(numeric.index!+numeric[0].length).trimStart().toLocaleLowerCase('ru').startsWith(month)))return null;
 if(numeric){const h=Number(numeric[1]),m=Number(numeric[2]??0);return h<24&&m<60&&(numeric[2]===undefined||numeric[2].length===2)?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`:null;}
 const hour=text.match(/(?:^|\s)(?:в|к|до)\s+([а-яё]+(?:\s+(?:один|два|три))?)(?=$|[\s,;.])/iu)?.[1]?.toLocaleLowerCase('ru');
 if(!hour)return null;
 const words:Readonly<Record<string,number>>={ноль:0,нулю:0,полночь:0,один:1,час:1,часу:1,два:2,двух:2,двум:2,три:3,трём:3,трем:3,трёх:3,трех:3,четыре:4,четырём:4,четырем:4,пять:5,пяти:5,шесть:6,шести:6,семь:7,семи:7,восемь:8,восьми:8,девять:9,девяти:9,десять:10,десяти:10,одиннадцать:11,одиннадцати:11,двенадцать:12,двенадцати:12,тринадцать:13,тринадцати:13,четырнадцать:14,четырнадцати:14,пятнадцать:15,пятнадцати:15,шестнадцать:16,шестнадцати:16,семнадцать:17,семнадцати:17,восемнадцать:18,восемнадцати:18,девятнадцать:19,девятнадцати:19,двадцать:20,двадцати:20,'двадцать один':21,'двадцать два':22,'двадцать три':23};
 const value=words[hour];return value===undefined?null:String(value).padStart(2,'0')+':00';
}
export class TemporalNormalizer {
 constructor(private readonly time:TemporalPort){}
 dateExpression(expression:string,source:{sourceAt:string;timezone:string}):string|null{if(!this.time.validTimezone(source.timezone)||!Number.isFinite(Date.parse(source.sourceAt)))return null;return dateExpression(expression,this.time.localDate(source.sourceAt,source.timezone));}
 normalize(grounded:GroundedMeaning,action:ActionDraft,source:{sourceAt:string;timezone:string}):TimeResolution{
  const issues=validateTemporalIntent(grounded).issues.filter(i=>!i.actionLabel||i.actionLabel===action.label);if(issues.length)return {status:'invalid',reason:issues[0]!.code};
  if(!this.time.validTimezone(source.timezone)||!Number.isFinite(Date.parse(source.sourceAt)))return {status:'invalid',reason:'source_time'};
  const today=this.time.localDate(source.sourceAt,source.timezone),values:NormalizedTime[]=[];const used=new Set<string>();
  const own=grounded.decision.units.find(u=>u.label===action.unitLabel)?.evidence??[];
  // Validate all expressions before sharing any date or returning a DST choice.
  if(action.times.some(t=>![...t.evidence,...own].some(e=>e.quote.toLocaleLowerCase('ru').includes(t.expression.trim().toLocaleLowerCase('ru')))))return {status:'invalid',reason:'time_expression_unproven'};
  const calendarSlots=action.times.filter(t=>t.field==='targetDate');
  const actionDate=calendarSlots.length===1?dateExpression(calendarSlots[0]!.expression,today):null;
  for(const t of action.times){
   if(used.has(t.field))return {status:'invalid',reason:'duplicate_time_field'};used.add(t.field);
   const date=dateExpression(t.expression,today),clock=clockExpression(t.expression);
   if(!date&&(/\d{4}-\d{2}-\d{2}/u.test(t.expression)||months.some(m=>t.expression.toLocaleLowerCase('ru').includes(m))))return {status:'invalid',reason:'date_expression'};
   if(!clock&&/(?:^|\s)(?:в|к|до|на)\s*\d{1,2}:/iu.test(t.expression))return {status:'invalid',reason:'clock_expression'};
   if(t.field==='targetDate'){if(!date||clock)return {status:'invalid',reason:'date_expression'};values.push({field:t.field,date});continue;}
   if(!clock){if(t.field==='deadline'&&date){values.push({field:'deadline',date});continue;}return {status:'invalid',reason:'clock_expression'};}
   // Only the same action's explicit calendar slot supplies a missing appointment date.
   // Explicit appointment dates win; deadlines and other actions never inherit it.
   const local={date:date??(t.field==='scheduledAt'?actionDate:null)??today,time:clock,timezone:source.timezone};const resolved=this.time.resolveLocalTime(local);
   if('error' in resolved){
    if(resolved.error.code!=='ambiguous_local_time')return {status:'invalid',reason:resolved.error.code};
    // Fold choices are real neighbouring IANA offsets, not an arbitrary default offset.
    const offsets=new Set<string>();const nominal=Date.parse(local.date+'T'+local.time+':00Z');
    for(const hours of [-36,-12,0,12,36]){
     const sample=nominal+hours*3600000;const parts=new Intl.DateTimeFormat('en-US',{timeZone:source.timezone,timeZoneName:'longOffset'}).formatToParts(sample);
     const offset=parts.find(p=>p.type==='timeZoneName')?.value.replace('GMT','')||'+00:00';if(/^[+-]\d{2}:\d{2}$/.test(offset))offsets.add(offset);
    }
    const options=[...offsets].flatMap(offset=>{const r=this.time.resolveLocalTime({...local,offset});return 'error' in r?[]:[{at:r.at,offset}];}).sort((a,b)=>a.at.localeCompare(b.at));
    return options.length>1?{status:'choice',options}:{status:'invalid',reason:'ambiguous_local_time'};
   }
   values.push({field:t.field,at:resolved.at});
  }
  return {status:'resolved',values};
 }
}
