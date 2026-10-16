import {test,expect} from 'vitest';
import {choiceFixture} from '../../support/choice-fixture.js';
import {PostgresChoiceProcessor} from '../../../src/infrastructure/postgres/agent/choice-processing.js';
import {PostgresOrderedHead} from '../../../src/infrastructure/postgres/postgres-ordered-head.js';
import {PostgresFencedConversation} from '../../../src/infrastructure/postgres/postgres-fenced-conversation.js';
const counts=async(f:Awaited<ReturnType<typeof choiceFixture>>)=>(await f.migrator.query(`SELECT (SELECT count(*) FROM work_item_events) events,(SELECT count(*) FROM task_command_receipts) receipts,(SELECT count(*) FROM outbound_messages) outbox,(SELECT state FROM pending_choices LIMIT 1) state`)).rows;
test('callback response insert failure rolls consumption, Task events, receipt and outbox back together',async()=>{
 const f=await choiceFixture();try{await f.confirm();const input=await f.callback(),before=await counts(f);
 await f.migrator.query(`CREATE FUNCTION public.test_choice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.choice_id IS NOT NULL THEN RAISE EXCEPTION 'injected';END IF;RETURN NEW;END $$;CREATE TRIGGER test_choice_failure BEFORE INSERT ON outbound_messages FOR EACH ROW EXECUTE FUNCTION public.test_choice_failure()`);
 await expect(f.processor.run(input.lease)).rejects.toThrow();expect(await counts(f)).toEqual(before);await f.migrator.query('DROP TRIGGER test_choice_failure ON outbound_messages');await f.processor.run(input.lease);expect((await counts(f))[0].state).toBe('consumed');
 }finally{await f.close();}
},120000);
test('actual callback COMMIT then lost acknowledgement reuses original consumption across restart/new callback ID',async()=>{
 const f=await choiceFixture();try{await f.confirm();const input=await f.callback();
 const lost={...f.database,tenantTransaction:async(...args:Parameters<typeof f.database.tenantTransaction>)=>{await f.database.tenantTransaction(...args);throw Error('ACK_LOST_AFTER_COMMIT');}};
 const processor=new PostgresChoiceProcessor(new PostgresOrderedHead(new PostgresFencedConversation(lost)),f.choices);
 await expect(processor.run(input.lease)).rejects.toThrow('ACK_LOST');const after=await counts(f);await expect(f.processor.run(input.lease)).rejects.toThrow();await f.processor.run((await f.callback()).lease);expect(await counts(f)).toEqual(after);
 }finally{await f.close();}
},120000);
test('real backend termination before callback COMMIT rolls all effects back, then fresh session retries once',async()=>{
 const f=await choiceFixture();try{await f.confirm();const input=await f.callback(),before=await counts(f);let termination:Promise<boolean>|undefined;
 const broken={...f.database,tenantTransaction:(role,user,fn)=>f.database.tenantTransaction(role,user,tx=>fn({...tx,query:async(sql,params)=>{const rows=await tx.query(sql,params);if(sql.startsWith('INSERT INTO public.delivery_work')){const [pid]=await tx.query('SELECT pg_backend_pid() pid');termination=f.postgres.pool.query('SELECT pg_terminate_backend($1) killed',[pid.pid]).then(r=>r.rows[0].killed);await termination;await tx.query('SELECT 1');}return rows;}}))};
 await expect(new PostgresChoiceProcessor(new PostgresOrderedHead(new PostgresFencedConversation(broken)),f.choices).run(input.lease)).rejects.toThrow();expect(termination).toBeDefined();expect(await termination).toBe(true);expect(await counts(f)).toEqual(before);await f.processor.run(input.lease);expect((await counts(f))[0].state).toBe('consumed');
 }finally{await f.close();}
},120000);
test.each(['fence','stop','generation','deleting'])('callback loses %s authority without late Task/choice effect',async mode=>{
 const f=await choiceFixture();try{await f.confirm();const input=await f.callback(),before=await counts(f);
 if(mode==='fence')await f.migrator.query('UPDATE system_state SET restore_fence=true');
 if(mode==='stop')await f.migrator.query("UPDATE conversations SET state='stopped' WHERE id=$1",[input.lease.conversationId]);
 if(mode==='generation')await f.migrator.query('UPDATE conversation_work SET lease_generation=lease_generation+1 WHERE conversation_id=$1',[input.lease.conversationId]);
 if(mode==='deleting')await f.migrator.query("UPDATE users SET status='deleting' WHERE id=$1",[f.a]);
 await f.processor.run(input.lease).catch(()=>undefined);expect(await counts(f)).toEqual(before);
 }finally{await f.close();}
},120000);
test('stop cutoff survives reactivation and invalidates buttons from an old delivered response',async()=>{
 const f=await choiceFixture();try{await f.confirm();const input=await f.callback(),before=(await counts(f))[0];await f.migrator.query("UPDATE conversations SET state='stopped' WHERE id=$1",[input.lease.conversationId]);await f.migrator.query("UPDATE conversations SET state='active' WHERE id=$1",[input.lease.conversationId]);await f.processor.run(input.lease);const after=(await counts(f))[0];expect(after.events).toBe(before.events);expect(after.receipts).toBe(before.receipts);expect(after.state).toBe('pending');
 }finally{await f.close();}
},120000);
