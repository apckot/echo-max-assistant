import type { LocalDateTime, TemporalPort, TemporalResult } from '../../modules/tasks/application/ports.js';
import { normalizeInstant, validDate } from '../../modules/tasks/domain/validation.js';

export class IanaTimeResolver implements TemporalPort {
 canonicalTimezone(timezone:string):string|null {
  if(!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezone))return null;
  try {return new Intl.DateTimeFormat('en',{timeZone:timezone}).resolvedOptions().timeZone;}catch{return null;}
 }
 validTimezone(timezone:string):boolean {return this.canonicalTimezone(timezone)!==null;}
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
  const timezone=this.canonicalTimezone(input.timezone);if(!timezone)return {error:{code:'invalid_timezone'}};
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
 private wallMillis(stamp:string):number {
  const [date,time]=stamp.split('T');const [year,month,day]=date!.split('-').map(Number);const [hour,minute,second]=time!.split(':').map(Number);
  const d=new Date(0);d.setUTCFullYear(year!,month!-1,day!);d.setUTCHours(hour!,minute!,second!,0);return d.getTime();
 }
 dayBoundary(date:string,timezone:string):string {
  if((!validDate(date)&&date!=='10000-01-01')||!this.validTimezone(timezone))throw new RangeError('Invalid day boundary');
  const nominal=this.wallMillis(date+'T00:00:00');const offset=(at:number)=>this.wallMillis(this.localStamp(at,timezone))-Math.floor(at/1000)*1000;
  const samples=Array.from({length:25},(_,n)=>nominal+(n-12)*6*3600000);
  const offsets=new Set(samples.map(offset).filter(v=>Math.abs(v)<=26*3600000));const candidates:number[]=[];
  for(const o of offsets){const at=nominal-o;if(this.localStamp(at,timezone)===date+'T00:00:00')candidates.push(at);}
  // A missing midnight/day is entered at a timezone transition, not by strict meeting resolution.
  for(let n=1;n<samples.length;n++){
   let low=samples[n-1]!,high=samples[n]!;const before=offset(low);if(before===offset(high))continue;
   while(high-low>1){const mid=Math.floor((low+high)/2);if(offset(mid)===before)low=mid;else high=mid;}
   if(this.localStamp(high,timezone).slice(0,-9)>=date&&this.localStamp(high-1,timezone).slice(0,-9)<date)candidates.push(high);
  }
  if(!candidates.length)throw new RangeError('No calendar boundary');
  return new Date(Math.min(...candidates)).toISOString();
 }

}
