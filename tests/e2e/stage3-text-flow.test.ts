import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {agentFixture} from '../support/agent-fixture.js';
import {PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {GroupRunner} from '../../src/modules/agent/application/group-runner.js';
test('restart finalizer after committed group creates one truthful outbox/receipt/pointer; replay has no second effect',async()=>{
 const f=await agentFixture();try{
 const input=await f.admit();let calls=0;const provider={decide:async(...args:Parameters<typeof f.fake.decide>)=>{calls++;return f.fake.decide(...args);}};
 const staged=await f.coordinator(provider).run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 await new GroupRunner(new PostgresAgentTaskProcessing(f.authority)).run(staged.ticket);
 expect((await f.migrator.query('SELECT count(*)::int n FROM outbound_messages')).rows[0].n).toBe(0);
 // Process restart adopts the durable accepted decision and the new finalizer reads committed receipts.
 const resumed=await f.coordinator(provider).run(input.lease);if(resumed.status!=='accepted')throw Error('resume');
 const finalizer=new PostgresTurnFinalizer(f.authority),result=await finalizer.finalize(resumed.ticket);
 expect(result.receiptType).toBe('assistant_turn_v1');expect(result.messages[0]?.text).toContain('Создано');expect(result.messages[0]?.text).toContain('Молоко');
 expect(await new PostgresTurnFinalizer(f.authority).finalize(resumed.ticket)).toEqual(result);expect(calls).toBe(1);
 expect((await f.migrator.query('SELECT dedupe_key FROM outbound_messages')).rows).toEqual([{dedupe_key:'turn:'+resumed.ticket.turnId+':final:v1'}]);
 const c=(await f.migrator.query('SELECT next_apply_sequence::int n FROM conversations WHERE id=$1',[input.lease.conversationId])).rows[0];expect(c.n).toBe(2);
 expect((await f.migrator.query('SELECT state FROM conversation_work WHERE conversation_id=$1',[input.lease.conversationId])).rows[0].state).toBe('ready');
 }finally{await f.close();}
},120000);
test('final outbox failure rolls back only finalization; committed Task remains recoverable and no false success',async()=>{
 const f=await agentFixture();try{
 const input=await f.admit(),staged=await f.coordinator().run(input.lease);if(staged.status!=='accepted')throw Error('stage');await new GroupRunner(new PostgresAgentTaskProcessing(f.authority)).run(staged.ticket);
 await f.migrator.query(`CREATE FUNCTION public.test_final_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox injection'; END $$`);await f.migrator.query('CREATE TRIGGER test_final_failure BEFORE INSERT ON outbound_messages FOR EACH ROW EXECUTE FUNCTION public.test_final_failure()');
 await expect(new PostgresTurnFinalizer(f.authority).finalize(staged.ticket)).rejects.toThrow();await f.migrator.query('DROP TRIGGER test_final_failure ON outbound_messages');
 expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(1);expect((await f.migrator.query('SELECT count(*)::int n FROM processing_receipts')).rows[0].n).toBe(0);
 expect((await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket)).messages[0]?.text).toContain('Создано');
 }finally{await f.close();}
},120000);
test('query-only turn persists source-local day, bounded read result/asOf and a frozen shown-list anchor',async()=>{
 const f=await agentFixture();try{
 const {create,taskHarness}=await import('../support/task-command-fixtures.js');await create(taskHarness(f),f.a,{title:'На завтра',targetDate:'2026-09-12'});
 const {parseMeaningDraft}=await import('../../src/modules/semantic/domain/meaning-decision.js');const input=await f.admit('Что на завтра?'),evidence=[{sourceLabel:'S1',quote:'Что на завтра?'}];
 const decision=parseMeaningDraft({version:2,units:[{label:'u1',kind:'query',speechAct:'question',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence,uncertainty:null}],actions:[],relations:[],queries:[{label:'q1',unitLabel:'u1',kind:'day',text:null,dayExpression:'завтра',statuses:[],target:null}],groups:[{label:'g1',unitLabels:['u1'],actionLabels:[],queryLabels:['q1'],outcome:'respond',reason:null}]});
 const staged=await f.coordinator({decide:async()=>({outcome:'ok',decision,model:'fake',durationMs:1,usage:null})}).run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 const outcomes=await new GroupRunner(new PostgresAgentTaskProcessing(f.authority)).run(staged.ticket);const query=outcomes[0]?.queryResults?.[0];expect(query).toMatchObject({kind:'tasks',day:'2026-09-12',items:[{title:'На завтра'}]});
 const result=await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);expect(result.messages[0]?.text).toContain('2026-09-12');expect(result.messages[0]?.text).toContain('1. На завтра');
 expect((await f.migrator.query('SELECT kind FROM context_anchors')).rows).toEqual([{kind:'list'}]);
 }finally{await f.close();}
},120000);
test('completed tombstone suppresses AI/effects/outbox after technical source/content retention and advances the new replay head',async()=>{
 const f=await agentFixture();try{
 const input=await f.admit(),staged=await f.coordinator().run(input.lease);if(staged.status!=='accepted')throw Error('stage');await new GroupRunner(new PostgresAgentTaskProcessing(f.authority)).run(staged.ticket);await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);
 // Technical retention fixture removes source rows only; domain receipts/tombstone remain.
 await f.migrator.query('DELETE FROM delivery_work');await f.migrator.query('DELETE FROM outbound_messages');await f.migrator.query('DELETE FROM processing_receipts');await f.migrator.query('DELETE FROM inbound_events WHERE id=$1',[input.event.id]);await f.migrator.query('DELETE FROM agent_turn_content');
 const eventKey=input.event.provider_event_key;await f.gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',['301',input.chat,eventKey,'2026-09-11T12:48:33Z',JSON.stringify({kind:'text',text:'Купи молоко'}),'a'.repeat(64)]);
 const lease=(await f.queue.claim({ownerId:randomUUID(),limit:100})).find(l=>l.conversationId===input.lease.conversationId)!;let calls=0;
 const replay=await f.coordinator({decide:async()=>{calls++;throw Error('no dispatch');}}).run(lease);if(replay.status!=='duplicate')throw Error('duplicate');
 expect((await new PostgresTurnFinalizer(f.authority).finalize(replay.ticket)).messages).toEqual([]);expect(calls).toBe(0);expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(1);expect((await f.migrator.query('SELECT count(*)::int n FROM outbound_messages')).rows[0].n).toBe(0);
 expect((await f.migrator.query('SELECT next_apply_sequence::int n FROM conversations WHERE id=$1',[lease.conversationId])).rows[0].n).toBe(3);
 }finally{await f.close();}
},120000);
