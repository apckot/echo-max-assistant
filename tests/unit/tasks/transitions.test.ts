import { expect,test } from 'vitest';
import { transition, createTask } from '../../../src/modules/tasks/domain/transitions.js';
const now='2026-10-13T12:00:00.000Z';
const task={id:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',title:'Отчёт',description:null,status:'open',
 targetDate:'2026-10-14',scheduledAt:'2026-10-14T12:00:00.000Z',dueDate:null,dueAt:'2026-10-15T12:00:00.000Z',timezone:'Europe/Moscow',
 version:1,createdAt:now,updatedAt:now,completedAt:null,cancelledAt:null};
const facts={recordedAt:'2026-10-13T13:00:00.000Z',scheduledLocalDate:'2026-10-14'};
const cases=[
 ['open','update','applied'],['open','complete','applied'],['open','cancel','applied'],['open','reopen','no_change'],
 ['completed','update','invalid_transition'],['completed','complete','no_change'],['completed','cancel','invalid_transition'],['completed','reopen','applied'],
 ['cancelled','update','invalid_transition'],['cancelled','complete','invalid_transition'],['cancelled','cancel','no_change'],['cancelled','reopen','applied'],
];
test.each(cases)('%s + %s returns %s',(status,kind,want)=>{
 const before={...task,status,completedAt:status==='completed'?now:null,cancelledAt:status==='cancelled'?now:null};
 const command={kind,target:{taskId:task.id},expectedVersion:1,...(kind==='update'?{patch:{title:'Новое'}}:{})};
 const result=transition(before,command,facts);
 if(want==='invalid_transition')expect(result).toEqual({code:want});
 else{
 expect(result.outcome).toBe(want);expect(result.task.version).toBe(want==='applied'?2:1);
 expect(result.task.id).toBe(task.id);expect(result.task.scheduledAt).toBe(task.scheduledAt);
 expect(result.task.updatedAt).toBe(want==='applied'?facts.recordedAt:now);
 expect(Boolean(result.change)).toBe(want==='applied');
 if(kind==='complete')expect(result.task.completedAt).toBe(status==='open'?facts.recordedAt:now);
 if(kind==='cancel')expect(result.task.cancelledAt).toBe(status==='open'?facts.recordedAt:now);
 if(kind==='reopen'){expect(result.task.completedAt).toBeNull();expect(result.task.cancelledAt).toBeNull();}
 }
});
test('version conflict precedes no_change and overflow never mutates',()=>{
 expect(transition({...task,status:'completed'},{kind:'complete',target:{taskId:task.id},expectedVersion:2},facts)).toEqual({code:'version_conflict'});
 expect(transition({...task,version:2147483647},{kind:'cancel',target:{taskId:task.id},expectedVersion:2147483647},facts)).toEqual({code:'version_exhausted'});
 expect(task.version).toBe(1);
});
test('patch moves only explicit fields and no_change preserves timestamps and version',()=>{
 const command={kind:'update',target:{taskId:task.id},expectedVersion:1,patch:{targetDate:'2026-10-15',deadline:null}};
 const result=transition(task,command,facts);
 expect(result.task).toMatchObject({targetDate:'2026-10-15',scheduledAt:task.scheduledAt,dueAt:null,dueDate:null});
 expect(transition(task,{...command,patch:{title:task.title}},facts)).toEqual({outcome:'no_change',task});
 const invalid=transition({...task,dueAt:null,dueDate:'2026-10-14'},{...command,patch:{timezone:'Asia/Tokyo'}},{...facts,scheduledLocalDate:'2026-10-15'});
 expect(invalid).toEqual({code:'invalid_schedule'});
});
test('create receives assigned identity and timestamp, dates stay optional',()=>{
 const result=createTask({kind:'create',localId:'a',title:'Дело',description:null,targetDate:null,scheduledAt:null,deadline:null},
 {id:task.id,userId:task.userId,timezone:'Europe/Moscow',...facts});
 expect(result.task).toMatchObject({id:task.id,status:'open',version:1,createdAt:facts.recordedAt,updatedAt:facts.recordedAt,completedAt:null,cancelledAt:null,dueAt:null});
 expect(result.change).toMatchObject({kind:'create',before:null,after:result.task});
});
