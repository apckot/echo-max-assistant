import {test,expect} from 'vitest';
import {agentFixture} from '../support/agent-fixture.js';
import {PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import {frame} from '../support/semantic-frame.js';
import {projectLegacyQuotes} from '../support/semantic-replay.js';
test('explicit read shortcuts use the same staged query/finalizer and no semantic dispatch, replay has no effect',async()=>{
 const f=await agentFixture();try{let calls=0;const coordinator=f.coordinator({decide:async()=>{calls++;throw Error('shortcut must be local');}});
 for(const text of ['/tasks','/today','/help']){const input=await f.admit(text);const staged=await coordinator.run(input.lease);expect(staged.status).toBe('accepted');if(staged.status!=='accepted')throw Error('shortcut');
 for(let i=0;i<staged.ticket.plan!.groups.length;i++)await new PostgresAgentTaskProcessing(f.authority).runGroup(staged.ticket,i);
 const finalizer=new PostgresTurnFinalizer(f.authority),result=await finalizer.finalize(staged.ticket);expect(result.messages.length).toBe(1);expect(await finalizer.finalize(staged.ticket)).toEqual(result);}
 expect(calls).toBe(0);expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(0);
 }finally{await f.close();}
},120000);
test('whole self-correction stays one command; quoted completion is blocked and unsupported group creates no Task',async()=>{
 const f=await agentFixture();try{let calls=0;
 for(const text of ['В10 встреча, нет, в11','Он сказал: «Заверши отчёт»','Подключи оплату']){
 const input=await f.admit(text);const draft=parseMeaningDraft(projectLegacyQuotes(frame(text,text.includes('Заверши')?'complete':'create',text.startsWith('В10')?{field:'scheduledAt',expression:'в11'}:undefined).grounded.decision));
 const decision=text==='Подключи оплату'?parseMeaningDraft({...draft,actions:[],units:draft.units.map(u=>({...u,kind:'unsupported',speechAct:'request'})),groups:draft.groups.map(g=>({...g,actionLabels:[],outcome:'capability_unavailable',reason:'unsupported'}))}):draft;
 const staged=await f.coordinator({decide:async()=>{calls++;return {outcome:'ok',decision,model:'fake',durationMs:1,usage:null};}}).run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 for(let i=0;i<staged.ticket.plan!.groups.length;i++)await new PostgresAgentTaskProcessing(f.authority).runGroup(staged.ticket,i);await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);
 }
 expect(calls).toBe(3);expect((await f.migrator.query('SELECT status,scheduled_at FROM work_items')).rows).toEqual([{status:'open',scheduled_at:new Date('2026-09-11T08:00:00Z')}]);
 }finally{await f.close();}
},120000);
