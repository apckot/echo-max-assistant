import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll,beforeAll,expect,test } from 'vitest';
import { deliveryFixture } from '../../support/delivery-fixture.js';
import { createGateway } from '../../../src/runtime/gateway.js';
import { createScheduler } from '../../../src/runtime/scheduler.js';
import { createDatabase } from '../../../src/infrastructure/postgres/database.js';
import { DeleteAccount } from '../../../src/modules/identity/application/delete-account.js';
import { PostgresAccountDeletion } from '../../../src/infrastructure/postgres/postgres-account-deletion.js';
import type { UserId } from '../../../src/shared/types/identity.js';
let f:Awaited<ReturnType<typeof deliveryFixture>>;
let app:ReturnType<typeof createGateway>;let scheduler:ReturnType<typeof createScheduler>;let database:ReturnType<typeof createDatabase>;
let installed=false;
const server=createServer(async(req,res)=>{
  if(req.method==='GET')res.end(JSON.stringify({subscriptions:installed?[{url:'https://example.org/hook',update_types:['message_created','message_callback','bot_started','bot_stopped']}]:[]}));
  else{for await(const _ of req){}installed=true;res.end('{"success":true}');}
});
beforeAll(async()=>{
  f=await deliveryFixture();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const environment={...Object.fromEntries(Object.entries(f.pools).map(([r,p])=>
    [`DATABASE_URL_${r==='migrator'?'MIGRATIONS':r.toUpperCase()}`,p.options.connectionString])),
    MAX_BOT_TOKEN:'test-token',MAX_WEBHOOK_SECRET:'test-secret',MAX_WEBHOOK_URL:'https://example.org/hook',
    MAX_WEBHOOK_SECRET_VERSION:'v1',RESTORE_FENCE:'off',OPS_HEALTH_TOKEN:'ops-secret'};
  app=createGateway(environment);scheduler=createScheduler(environment,{automatic:false,baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  database=createDatabase({scheduler:f.pools.scheduler.options.connectionString!});
},120_000);
afterAll(async()=>{
  await scheduler?.stop();await app?.close();await database?.close();
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f?.close();
});
const health=async()=>(await app.inject({url:'/ops/health',headers:{authorization:'Bearer ops-secret'}})).json();
test('operations checkpoint: stale monitoring is visible, retention preserves content, deletion resumes after restart',async()=>{
  await scheduler.checkSubscription();expect((await health()).subscription.status).toBe('healthy');
  await f.postgres.pool.query("UPDATE public.integration_health SET checked_at=clock_timestamp()-interval '11 minutes'");
  expect((await health()).subscription.status).toBe('stale');
  await scheduler.checkSubscription();expect((await health()).subscription.status).toBe('healthy');
  const erased=await f.seed();const survivor=await f.seed();
  const deletion=new DeleteAccount(new PostgresAccountDeletion(database));
  await deletion.begin({userId:erased.user_id as UserId,operationId:randomUUID(),actor:'self_service',reason:'privacy_request'});
  expect(await health()).toMatchObject({ready:true,deletion:{pending:1},delivery:{pending:1,cancelled:1}});
  await scheduler.clean();
  expect((await f.postgres.pool.query('SELECT count(*)::int AS count FROM public.inbound_events')).rows[0]).toEqual({count:2});
  // The request-owning service is discarded; scheduler reads only durable pending jobs.
  await scheduler.erase();
  expect(await health()).toMatchObject({ready:true,deletion:{pending:0},delivery:{pending:1,cancelled:0}});
  expect((await f.postgres.pool.query('SELECT id FROM public.users')).rows).toEqual([{id:survivor.user_id}]);
  expect((await f.postgres.pool.query('SELECT user_id,status,actor FROM public.account_deletions')).rows)
    .toEqual([{user_id:null,status:'completed',actor:'self_service'}]);
  expect((await app.inject('/health/ready')).statusCode).toBe(200);
});
