import { createServer } from 'node:http';
import { afterAll,beforeAll,expect,test } from 'vitest';
import { deliveryFixture } from '../../support/delivery-fixture.js';
import { createDatabase } from '../../../src/infrastructure/postgres/database.js';
import { PostgresSubscriptionStore } from '../../../src/infrastructure/postgres/postgres-subscription-store.js';
import { SubscriptionMonitor } from '../../../src/modules/operations/application/subscription-monitor.js';
import { createMaxSubscriptionClient } from '../../../src/infrastructure/max/max-subscription-client.js';
let f:Awaited<ReturnType<typeof deliveryFixture>>;let db:ReturnType<typeof createDatabase>;let baseUrl:string;
const installs:string[]=[];
const server=createServer(async(req,res)=>{
  if(req.method==='GET')res.end(JSON.stringify({subscriptions:[{url:'https://example.org/a',update_types:[]},{url:'https://example.org/b',update_types:[]}]}));
  else if(req.method==='DELETE')setTimeout(()=>res.end('{"success":true}'),250);
  else{let body='';for await(const c of req)body+=c;installs.push(JSON.parse(body).secret);res.end('{"success":true}');}
});
beforeAll(async()=>{
  f=await deliveryFixture();db=createDatabase({scheduler:f.pools.scheduler.options.connectionString!,schedulerTransactionTimeoutMs:1500});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
},120_000);
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await db?.close();await f?.close();});
test('shared HTTP budget ends reconciliation under leadership and never installs an old secret after timeout',async()=>{
  const monitor=new SubscriptionMonitor(new PostgresSubscriptionStore(db),createMaxSubscriptionClient({token:'token',baseUrl,timeoutMs:1000,operationBudgetMs:400}),
    {url:'https://example.org/hook',secret:'old-secret',version:'old'});
  await monitor.check();
  expect((await f.postgres.pool.query('SELECT status,failures,secret_version FROM public.integration_health')).rows)
    .toEqual([{status:'degraded',failures:1,secret_version:null}]);
  expect(installs).toEqual([]);
  const lock=await f.pools.scheduler.query('SELECT pg_try_advisory_lock(1698727768,1937072755) AS locked');
  expect(lock.rows[0].locked).toBe(true);
  await f.pools.scheduler.query('SELECT pg_advisory_unlock(1698727768,1937072755)');
  await new Promise(resolve=>setTimeout(resolve,300));expect(installs).toEqual([]);
});
test('database authority cancellation settles old reconciliation before takeover and new secret installation',async()=>{
  installs.length=0;
  const short=createDatabase({scheduler:f.pools.scheduler.options.connectionString!,schedulerTransactionTimeoutMs:300});
  const old=new SubscriptionMonitor(new PostgresSubscriptionStore(short),createMaxSubscriptionClient({token:'token',baseUrl,timeoutMs:1000,operationBudgetMs:1500}),
    {url:'https://example.org/hook',secret:'old-secret',version:'old'});
  const fresh=new SubscriptionMonitor(new PostgresSubscriptionStore(db),createMaxSubscriptionClient({token:'token',baseUrl,timeoutMs:1000,operationBudgetMs:1500}),
    {url:'https://example.org/hook',secret:'new-secret',version:'new'});
  try{
    await expect(old.check()).rejects.toThrow();
    await fresh.check();
    await new Promise(resolve=>setTimeout(resolve,300));
    expect(installs).toEqual(['new-secret']);
    expect((await f.postgres.pool.query('SELECT status,secret_version FROM public.integration_health')).rows)
      .toEqual([{status:'healthy',secret_version:'new'}]);
  }finally{await short.close();}
});
