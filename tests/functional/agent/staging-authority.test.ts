import {beforeAll,afterAll,test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {agentFixture} from '../../support/agent-fixture.js';
let f:Awaited<ReturnType<typeof agentFixture>>;
beforeAll(async()=>{f=await agentFixture();},120000);afterAll(async()=>{await f?.close();});
test('slow FakeAI holds no DB locks, renewal proceeds, accepted decision is reused without another invocation',async()=>{
 const input=await f.admit();let release!:()=>void,entered!:()=>void;const running=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);let calls=0;
 const provider={decide:async(...args:Parameters<typeof f.fake.decide>)=>{calls++;entered();await wait;return f.fake.decide(...args);}};
 const work=f.coordinator(provider).run(input.lease);await running;
 const client=await f.worker.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='200ms'");await client.query('SELECT 1 FROM public.conversations WHERE id=$1 FOR UPDATE NOWAIT',[input.lease.conversationId]);await client.query('ROLLBACK');}finally{client.release();}
 expect(await f.queue.renew(input.lease)).not.toBeNull();release();expect((await work).status).toBe('accepted');
 expect((await f.coordinator(provider).run(input.lease)).status).toBe('accepted');expect(calls).toBe(1);
});
test('started response uncertainty is terminal locally; restart never redispatches',async()=>{
 const input=await f.admit();const ticket=await f.authority.claim(input.lease,'b'.repeat(64));if(!ticket)throw Error('claim');
 await f.authority.start(ticket,{test:'synthetic'},{});let calls=0;
 const result=await f.coordinator({decide:async()=>{calls++;throw Error('must not call');}}).run(input.lease);
 expect(result.status).toBe('failed');expect(calls).toBe(0);
});
test('stale generation, source changes, stopped account and restore fence cannot accept returned AI',async()=>{
 for(const mode of ['generation','source','user','fence']){
  const input=await f.admit();let entered!:()=>void,release!:()=>void;const wait=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  const work=f.coordinator({decide:async(...args)=>{entered();await wait;return f.fake.decide(...args);}}).run(input.lease);await ready;
  if(mode==='generation')await f.migrator.query('UPDATE conversation_work SET lease_generation=lease_generation+1 WHERE conversation_id=$1',[input.lease.conversationId]);
  if(mode==='source')await f.migrator.query("UPDATE inbound_events SET raw_sha256=repeat('c',64) WHERE id=$1",[input.event.id]);
  if(mode==='user')await f.migrator.query("UPDATE users SET status='deleting' WHERE id=$1",[input.lease.userId]);
  if(mode==='fence')await f.migrator.query('UPDATE system_state SET restore_fence=true');
  release();await expect(work).rejects.toThrow();
  expect((await f.migrator.query('SELECT * FROM accepted_decisions WHERE turn_id IN(SELECT turn_id FROM agent_runs WHERE source_event_id=$1)',[input.event.id])).rows).toEqual([]);
  await f.migrator.query('UPDATE system_state SET restore_fence=false');await f.migrator.query("UPDATE users SET status='active' WHERE id=$1",[input.lease.userId]);
 }
});

test('accepted decision recovers its frozen profile after configuration changes without reinterpretation',async()=>{
 const input=await f.admit(),staged=await f.coordinator().run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 const recovered=await f.authority.claim(input.lease,'c'.repeat(64));expect(recovered?.phase).toBe('accepted');expect(recovered?.profileDigest).toBe('b'.repeat(64));expect(recovered?.plan).toEqual(staged.ticket.plan);
});
