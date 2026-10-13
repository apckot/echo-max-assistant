import { expect,test } from 'vitest';
import { normalizeCommand, normalizeInstant, validDate, validateSchedule } from '../../../src/modules/tasks/domain/validation.js';
import { IanaTimeResolver } from '../../../src/infrastructure/time/iana-time-resolver.js';
const time=new IanaTimeResolver();
test('strict calendar and instant validation refuses normalization and preserves milliseconds',()=>{
 for(const date of ['0001-01-01','9999-12-31','2028-02-29']) expect(validDate(date)).toBe(true);
 for(const date of ['0000-01-01','10000-01-01','2026-02-29','2026-02-31','2026-13-01','2026-1-01']) expect(validDate(date)).toBe(false);
 expect(normalizeInstant('2026-10-13T15:00:00.123+03:00')).toBe('2026-10-13T12:00:00.123Z');
 for(const value of ['2026-02-31T12:00:00Z','2026-10-13T12:00:00','infinity','2026-10-13T12:00:00.1234Z','2026-10-13T24:00:00Z','0001-01-01T00:00:00+14:00'])
 expect(normalizeInstant(value)).toEqual({code:'invalid_time'});
 const base={kind:'create',localId:'a',title:'Дело'};
 expect(normalizeCommand({...base,targetDate:'2026-02-31'})).toEqual({code:'invalid_time'});
 expect(normalizeCommand({...base,deadline:{kind:'date',date:'2028-02-29'}})).toHaveProperty('deadline.date','2028-02-29');
 expect(normalizeCommand({...base,deadline:{kind:'date',date:'2028-02-29',at:'2026-01-01T00:00:00Z'}})).toEqual({code:'invalid_command'});
});
test('Berlin DST gap fails and fold requires an explicit valid offset',()=>{
 const base={date:'2026-03-29',time:'02:30:00',timezone:'Europe/Berlin'};
 expect(time.resolveLocalTime(base)).toEqual({error:{code:'nonexistent_local_time'}});
 const fold={...base,date:'2026-10-25'};
 expect(time.resolveLocalTime(fold)).toEqual({error:{code:'ambiguous_local_time'}});
 expect(time.resolveLocalTime({...fold,offset:'+02:00'})).toEqual({at:'2026-10-25T00:30:00.000Z',timezone:'Europe/Berlin'});
 expect(time.resolveLocalTime({...fold,offset:'+01:00'})).toEqual({at:'2026-10-25T01:30:00.000Z',timezone:'Europe/Berlin'});
 expect(time.resolveLocalTime({...fold,offset:'+03:00'})).toEqual({error:{code:'invalid_time'}});
 expect(time.resolveLocalTime({...fold,timezone:'Mars/Olympus'})).toEqual({error:{code:'invalid_timezone'}});
 expect(time.resolveLocalTime({...fold,date:'2026-02-31'})).toEqual({error:{code:'invalid_time'}});
});
test('schedule checks deadlines independently of target day and accepts past times',()=>{
 expect(validateSchedule({scheduledAt:'2026-01-01T15:00:00.000Z',dueAt:'2026-01-01T14:00:00.000Z',dueDate:null},null)).toEqual({code:'invalid_schedule'});
 expect(validateSchedule({scheduledAt:'2026-01-01T15:00:00.000Z',dueAt:null,dueDate:'2026-01-01'},'2026-01-02')).toEqual({code:'invalid_schedule'});
 expect(validateSchedule({scheduledAt:null,dueAt:'2020-01-01T00:00:00.000Z',dueDate:null},null)).toBeNull();
 expect(validateSchedule({scheduledAt:null,dueAt:'2020-01-01T00:00:00.000Z',dueDate:'2020-01-01'},null)).toEqual({code:'invalid_schedule'});
 expect(time.localDate('2026-10-13T22:00:00.000Z','Europe/Moscow')).toBe('2026-10-14');
});
test('retry uses saved instant and timezone snapshot rather than a changed profile',()=>{
 const command=normalizeCommand({kind:'create',localId:'a',title:'Встреча',timezone:'Europe/Moscow',scheduledAt:'2026-10-14T15:00:00+03:00'});
 expect(command).toHaveProperty('scheduledAt','2026-10-14T12:00:00.000Z');
 expect(normalizeCommand(command)).toEqual(command);
});
