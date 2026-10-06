import { afterAll,beforeAll,expect,test } from 'vitest';
import { deliveryFixture,ownerA } from '../../support/delivery-fixture.js';
import { createDatabase } from '../../../src/infrastructure/postgres/database.js';
import { PostgresConversationQueue } from '../../../src/infrastructure/postgres/postgres-conversation-queue.js';
import { PostgresFencedConversation } from '../../../src/infrastructure/postgres/postgres-fenced-conversation.js';
import { PostgresRetentionStore } from '../../../src/infrastructure/postgres/postgres-retention-store.js';
let f:Awaited<ReturnType<typeof deliveryFixture>>;let db:ReturnType<typeof createDatabase>;
beforeAll(async()=>{f=await deliveryFixture();db=createDatabase({worker:f.pools.worker.options.connectionString!,scheduler:f.pools.scheduler.options.connectionString!});},120_000);
afterAll(async()=>{await db?.close();await f?.close();});
test('same owner cannot revive an old lease token after dead work retention and new inbound',async()=>{
  const row=await f.seed();const queue=new PostgresConversationQueue(db);
  const [oldLease]=await queue.claim({ownerId:ownerA,limit:1});
  await f.postgres.pool.query("UPDATE public.conversation_work SET state='dead',lease_owner=NULL,lease_until=NULL WHERE user_id=$1",[row.user_id]);
  await f.postgres.pool.query("UPDATE public.conversation_work SET incident_closed_at='2026-08-01' WHERE user_id=$1",[row.user_id]);
  expect(await new PostgresRetentionStore(db).clean(new Date('2026-10-01'),1)).toMatchObject({conversationWork:1});
  const account=(await f.postgres.pool.query('SELECT external_user_id FROM public.channel_accounts WHERE user_id=$1',[row.user_id])).rows[0]!;
  await f.pools.gateway.query('SELECT * FROM public.accept_max_inbound($1,$1,$2,$3,$4,$5)',
    [account.external_user_id,'fresh-after-retention','2026-10-01',JSON.stringify({kind:'text',text:'private'}),'a'.repeat(64)]);
  const [fresh]=await queue.claim({ownerId:ownerA,limit:1});
  let staleRan=false;
  await expect(new PostgresFencedConversation(db).run(oldLease!,async()=>{
    staleRan=true;return {value:'stale',disposition:{kind:'keep' as const}};
  })).rejects.toThrow();
  expect(staleRan).toBe(false);expect(fresh!.leaseGeneration>oldLease!.leaseGeneration).toBe(true);
});
