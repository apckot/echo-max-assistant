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
 const numeric=text.match(/(?:^|\s)(?:в|к|до|на)\s*(\d{1,2})(?::(\d{2}))?(?![\d-])/iu);
 if(numeric&&months.some(month=>text.slice(numeric.index!+numeric[0].length).trimStart().toLocaleLowerCase('ru').startsWith(month)))return null;
 if(numeric){const h=Number(numeric[1]),m=Number(numeric[2]??0);return h<24&&m<60?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`:null;}
 const words=[[/один(?:надцат)?/iu,1],[/двенадцат/iu,12],[/два|двух|двум/iu,2],[/три|тр[её]м|тр[её]х/iu,3],[/четыр/iu,4],[/пят/iu,5],[/шест/iu,6],[/сем/iu,7],[/восем/iu,8],[/девят/iu,9],[/десят/iu,10],[/нол|нул|полноч/iu,0]] as const;
 const suffix=text.match(/(?:^|\s)(?:в|к|до)\s+([а-яё]+)/iu)?.[1];if(!suffix||weekdays.some(p=>p.test(suffix)))return null;
 // Explicitly bounded Russian hour vocabulary; unknown expressions remain unresolved.
 if(/одиннадцат/iu.test(suffix))return '11:00';
 const found=words.find(([pattern])=>pattern.test(suffix));return found?String(found[1]).padStart(2,'0')+':00':null;
}
export class TemporalNormalizer {
 constructor(private readonly time:TemporalPort){}
 normalize(grounded:GroundedMeaning,action:ActionDraft,source:{sourceAt:string;timezone:string}):TimeResolution{
  const issues=validateTemporalIntent(grounded).issues.filter(i=>!i.actionLabel||i.actionLabel===action.label);if(issues.length)return {status:'invalid',reason:issues[0]!.code};
  if(!this.time.validTimezone(source.timezone)||!Number.isFinite(Date.parse(source.sourceAt)))return {status:'invalid',reason:'source_time'};
  const today=this.time.localDate(source.sourceAt,source.timezone),values:NormalizedTime[]=[];const used=new Set<string>();
  for(const t of action.times){
   if(used.has(t.field))return {status:'invalid',reason:'duplicate_time_field'};used.add(t.field);
   const own=grounded.decision.units.find(u=>u.label===action.unitLabel)?.evidence??[];
   if(![...t.evidence,...own].some(e=>e.quote.toLocaleLowerCase('ru').includes(t.expression.trim().toLocaleLowerCase('ru'))))return {status:'invalid',reason:'time_expression_unproven'};
   const date=dateExpression(t.expression,today),clock=clockExpression(t.expression);
   if(!date&&(/\d{4}-\d{2}-\d{2}/u.test(t.expression)||months.some(m=>t.expression.toLocaleLowerCase('ru').includes(m))))return {status:'invalid',reason:'date_expression'};
   if(!clock&&/(?:^|\s)(?:в|к|до|на)\s*\d{1,2}:/iu.test(t.expression))return {status:'invalid',reason:'clock_expression'};
   if(t.field==='targetDate'){if(!date||clock)return {status:'invalid',reason:'date_expression'};values.push({field:t.field,date});continue;}
   if(!clock){if(t.field==='deadline'&&date){values.push({field:'deadline',date});continue;}return {status:'invalid',reason:'clock_expression'};}
   const local={date:date??today,time:clock,timezone:source.timezone};const resolved=this.time.resolveLocalTime(local);
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
