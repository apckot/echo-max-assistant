import {beforeAll,afterAll,test,expect} from 'vitest';
import {agentFixture} from '../../support/agent-fixture.js';
import {PostgresAgentTaskProcessing} from '../../../src/infrastructure/postgres/postgres-typed-task-processing.js';
let f:Awaited<ReturnType<typeof agentFixture>>;
beforeAll(async()=>{f=await agentFixture();},120000);afterAll(async()=>{await f?.close();});
test('trusted assistant turn source, immutable command payload and repeated group share one receipt/effect/response intent',async()=>{
 const input=await f.admit(),staged=await f.coordinator().run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 const bridge=new PostgresAgentTaskProcessing(f.authority);const [a,b]=await Promise.all([bridge.runGroup(staged.ticket,0),bridge.runGroup(staged.ticket,0)]);expect(a).toEqual(b);expect(a.outcome).toBe('applied');
 const receipt=(await f.migrator.query('SELECT source_id,source_kind FROM task_command_receipts WHERE id=$1',[a.receipt!.receiptId])).rows[0];expect(receipt).toEqual({source_id:staged.ticket.turnId,source_kind:'turn'});expect(staged.ticket.turnId).not.toBe(input.event.id);
 expect((await f.migrator.query('SELECT count(*)::int n FROM turn_response_intents WHERE turn_id=$1',[staged.ticket.turnId])).rows[0].n).toBe(1);
 await expect(bridge.runGroup({...staged.ticket,turnId:'00000000-0000-4000-8000-000000000001'},0)).rejects.toThrow();
 await expect(f.database.tenantTransaction('worker',f.b,tx=>tx.query('SELECT * FROM accepted_decisions'))).resolves.toEqual([]);
});
test('failure inserting response intent rolls back Tasks, history, receipt and group result together',async()=>{
 const input=await f.admit(),staged=await f.coordinator().run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 await f.migrator.query(`CREATE FUNCTION public.test_intent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected intent failure'; END $$`);
 await f.migrator.query('CREATE TRIGGER test_intent_failure BEFORE INSERT ON public.turn_response_intents FOR EACH ROW EXECUTE FUNCTION public.test_intent_failure()');
 const before=(await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n;
 try{await expect(new PostgresAgentTaskProcessing(f.authority).runGroup(staged.ticket,0)).rejects.toThrow();}finally{await f.migrator.query('DROP TRIGGER test_intent_failure ON public.turn_response_intents');}
 expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(before);
 expect((await f.migrator.query('SELECT count(*)::int n FROM task_command_receipts WHERE source_id=$1',[staged.ticket.turnId])).rows[0].n).toBe(0);
 expect((await f.migrator.query('SELECT count(*)::int n FROM turn_groups WHERE turn_id=$1',[staged.ticket.turnId])).rows[0].n).toBe(0);
 expect((await new PostgresAgentTaskProcessing(f.authority).runGroup(staged.ticket,0)).outcome).toBe('applied');
});
