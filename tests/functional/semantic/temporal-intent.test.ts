import {expect,test} from 'vitest';
import {TemporalNormalizer} from '../../../src/modules/semantic/application/temporal-normalizer.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
import {frame} from '../../support/semantic-frame.js';
const normalizer=new TemporalNormalizer(new IanaTimeResolver());
function normalize(text:string,field:string,expression:string,at='2026-09-11T12:48:33.000Z',timezone='Europe/Moscow'){
 const f=frame(text,'update',{field,expression});return normalizer.normalize(f.grounded,f.grounded.decision.actions[0]!,{sourceAt:at,timezone});
}
test('source clock, weekdays and date-only moves keep targetDate distinct from schedule/deadline',()=>{
 expect(normalize('Перенеси звонок на завтра','targetDate','на завтра')).toEqual({status:'resolved',values:[{field:'targetDate',date:'2026-09-12'}]});
 expect(normalize('Перенеси звонок на пятницу','targetDate','на пятницу')).toMatchObject({values:[{date:'2026-09-11'}]});
 expect(normalize('Перенеси звонок на прошлую пятницу','targetDate','на прошлую пятницу')).toMatchObject({values:[{date:'2026-09-04'}]});
 expect(normalize('Перенеси звонок на завтра','deadline','на завтра').status).toBe('invalid');
});
test('к девяти is a deadline on source local day, в девять is an appointment, no past-time rollover',()=>{
 expect(normalize('Измени срок к девяти','deadline','к девяти')).toEqual({status:'resolved',values:[{field:'deadline',at:'2026-09-11T06:00:00.000Z'}]});
 expect(normalize('Назначь звонок завтра в девять','scheduledAt','завтра в девять')).toEqual({status:'resolved',values:[{field:'scheduledAt',at:'2026-09-12T06:00:00.000Z'}]});
});
test('strict appointments reject gaps and expose finite fold choices; calendar days remain separate',()=>{
 expect(normalize('Назначь звонок 2026-03-08 в 02:30','scheduledAt','2026-03-08 в 02:30',undefined,'America/New_York')).toMatchObject({status:'invalid',reason:'nonexistent_local_time'});
 const fold=normalize('Назначь звонок 2026-11-01 в 01:30','scheduledAt','2026-11-01 в 01:30',undefined,'America/New_York');expect(fold).toMatchObject({status:'choice'});if(fold.status==='choice')expect(fold.options).toHaveLength(2);
 expect(normalize('Перенеси звонок на 2011-12-30','targetDate','на 2011-12-30',undefined,'Pacific/Apia')).toMatchObject({status:'resolved',values:[{date:'2011-12-30'}]});
});
test('model cannot invent a relative date or degrade invalid clock to a date-only deadline',()=>{
 expect(normalize('Перенеси звонок на пятницу','targetDate','на завтра').status).toBe('invalid');
 expect(normalize('Измени срок завтра к 29:00','deadline','завтра к 29:00').status).toBe('invalid');
});
test('C061/C063/C067/C070 weekdays, explicit Russian dates and leap validity use source year',()=>{
 expect(normalize('Назначь интервью во вторник в10','scheduledAt','во вторник в10')).toMatchObject({status:'resolved',values:[{at:'2026-09-15T07:00:00.000Z'}]});
 expect(normalize('Измени срок до16 сентября','deadline','до16 сентября')).toEqual({status:'resolved',values:[{field:'deadline',date:'2026-09-16'}]});
 expect(normalize('Перенеси звонок на 29 февраля2028','targetDate','на 29 февраля2028')).toMatchObject({status:'resolved',values:[{date:'2028-02-29'}]});
 expect(normalize('Перенеси звонок на 31 февраля2028','targetDate','на 31 февраля2028').status).toBe('invalid');
 expect(normalize('Измени срок до пятницы','deadline','до пятницы')).toEqual({status:'resolved',values:[{field:'deadline',date:'2026-09-11'}]});
});
test('review: quoted deadline task title does not change date-move intent',()=>{
 expect(normalize('Перенеси задачу «Дедлайн отчёта» на завтра','deadline','на завтра').status).toBe('invalid');
 expect(normalize('Перенеси задачу «Дедлайн отчёта» на завтра','targetDate','на завтра')).toMatchObject({status:'resolved',values:[{field:'targetDate',date:'2026-09-12'}]});
});
test('review: full Russian hour words and malformed minutes never degrade to another clock',()=>{
 expect(normalize('Назначь звонок завтра в двадцать','scheduledAt','завтра в двадцать')).toMatchObject({values:[{at:'2026-09-12T17:00:00.000Z'}]});
 expect(normalize('Назначь звонок завтра в тринадцать','scheduledAt','завтра в тринадцать')).toMatchObject({values:[{at:'2026-09-12T10:00:00.000Z'}]});
 for(const clock of ['9:999','9:7','29:00'])expect(normalize('Назначь звонок завтра в '+clock,'scheduledAt','завтра в '+clock).status).toBe('invalid');
});
