import type { LocalDateTime, TemporalPort, TemporalResult } from '../../modules/tasks/application/ports.js';
import { normalizeInstant, validDate } from '../../modules/tasks/domain/validation.js';

export class IanaTimeResolver implements TemporalPort {
 validTimezone(timezone:string):boolean {
  if(!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezone))return false;
  try {new Intl.DateTimeFormat('en',{timeZone:timezone});return true;}catch{return false;}
 }
 private localStamp(at:number,timezone:string):string {
  const parts=new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',
   hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at));
  const value=(type:string)=>parts.find(p=>p.type===type)!.value;
  return `${value('year').padStart(4,'0')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
 }
 localDate(at:string,timezone:string):string {
  if(!this.validTimezone(timezone)||typeof normalizeInstant(at)!=='string')throw new RangeError('Invalid temporal input');
  return this.localStamp(Date.parse(at),timezone).slice(0,10);
 }
 resolveLocalTime(input:LocalDateTime):TemporalResult {
  if(!this.validTimezone(input.timezone))return {error:{code:'invalid_timezone'}};
  if(!validDate(input.date)||!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input.time))return {error:{code:'invalid_time'}};
  const wall=input.date+'T'+(input.time.length===5?input.time+':00':input.time);
  const nominal=Date.parse(wall+'Z');
  const offsets=new Set<number>();
  // Obtain all neighbouring IANA offsets; a gap/fold is resolved by matching wall time,
  // never by letting Date normalize it. The window also covers date-line changes.
  for(let hour=-48;hour<=48;hour+=6){
   const sample=nominal+hour*3600000;
   offsets.add(Date.parse(this.localStamp(sample,input.timezone)+'Z')-sample);
  }
  const matches=[...offsets].map(offset=>({at:nominal-offset,offset}))
   .filter(({at})=>at>=Date.parse('0001-01-01T00:00:00Z')&&at<=Date.parse('9999-12-31T23:59:59.999Z')&&this.localStamp(at,input.timezone)===wall);
  if(!matches.length)return {error:{code:'nonexistent_local_time'}};
  if(input.offset!==undefined){
   if(!/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(input.offset))return {error:{code:'invalid_time'}};
   const minutes=(Number(input.offset.slice(1,3))*60+Number(input.offset.slice(4)))*(input.offset[0]==='-'?-1:1);
   const match=matches.find(m=>m.offset===minutes*60000);
   return match?{at:new Date(match.at).toISOString(),timezone:input.timezone}:{error:{code:'invalid_time'}};
  }
  if(matches.length>1)return {error:{code:'ambiguous_local_time'}};
  return {at:new Date(matches[0]!.at).toISOString(),timezone:input.timezone};
 }
}
