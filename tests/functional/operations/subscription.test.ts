import { createServer } from 'node:http';
import { afterAll,beforeAll,expect,test } from 'vitest';
import { createScheduler } from '../../../src/runtime/scheduler.js';
import { createWorker } from '../../../src/runtime/worker.js';
import { deliveryFixture } from '../../support/delivery-fixture.js';
let f:Awaited<ReturnType<typeof deliveryFixture>>;
let environment:Record<string,unknown>;
let baseUrl:string;
let subscriptions:{url:string;update_types:string[]}[]=[];
let writes=0; let fail=false;
const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='test-token') { res.statusCode=401;res.end();return; }
  if(fail){res.statusCode=500;res.end();return;}
  if(req.method==='GET') res.end(JSON.stringify({subscriptions}));
  else if(req.method==='POST') {
    let body='';for await(const chunk of req)body+=chunk;
    const value=JSON.parse(body);
    if(value.secret!=='test-secret') {res.statusCode=400;res.end();return;}
    writes++;subscriptions=[{url:value.url,update_types:value.update_types}];res.end('{"success":true}');
  } else { subscriptions=subscriptions.filter(s=>s.url!==new URL(req.url!,baseUrl).searchParams.get('url'));res.end('{"success":true}'); }
});
beforeAll(async()=>{
  f=await deliveryFixture();
  environment={...Object.fromEntries(Object.entries(f.pools).map(([r,p])=>
    [`DATABASE_URL_${r==='migrator'?'MIGRATIONS':r.toUpperCase()}`,p.options.connectionString])),
    MAX_BOT_TOKEN:'test-token',MAX_WEBHOOK_SECRET:'test-secret',MAX_WEBHOOK_URL:'https://example.org/hook',
    MAX_WEBHOOK_SECRET_VERSION:'v1',RESTORE_FENCE:'off'};
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
},120_000);
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f?.close();});
test('leader repairs missing, changed and rotated subscription; three failures produce one operator alert',async()=>{
  const a=createScheduler(environment,{baseUrl,automatic:false});
  const b=createScheduler(environment,{baseUrl,automatic:false});
  try {
    await Promise.all([a.checkSubscription(),b.checkSubscription()]);
    expect(writes).toBe(1);
    await a.checkSubscription();expect(writes).toBe(1);
    subscriptions[0]!.update_types=['bot_started'];await a.checkSubscription();expect(writes).toBe(2);
    subscriptions=[{url:'https://example.org/old',update_types:[]}];await a.checkSubscription();expect(writes).toBe(3);
    const rotated=createScheduler({...environment,MAX_WEBHOOK_SECRET_VERSION:'v2'},{baseUrl,automatic:false});
    try {await rotated.checkSubscription();expect(writes).toBe(4);}finally{await rotated.stop();}
    fail=true;await a.checkSubscription();await a.checkSubscription();await a.checkSubscription();
    expect((await f.postgres.pool.query('SELECT status,failures FROM public.integration_health')).rows)
      .toEqual([{status:'critical',failures:3}]);
    expect((await f.postgres.pool.query('SELECT code FROM public.operations_alerts')).rows).toEqual([{code:'max_subscription_critical'}]);
    const metadata=JSON.stringify((await f.postgres.pool.query('SELECT * FROM public.integration_health')).rows);
    expect(metadata).not.toMatch(/test-secret|test-token/);
    fail=false;await a.checkSubscription();
    expect((await f.postgres.pool.query('SELECT status,failures FROM public.integration_health')).rows).toEqual([{status:'healthy',failures:0}]);
  }finally{fail=false;await a.stop();await b.stop();}
});
test('scheduler scan and runtime process durable work when original NOTIFY has no listener',async()=>{
  const seed=await f.seed();
  await f.postgres.pool.query('DELETE FROM public.outbound_messages WHERE id=$1',[seed.id]);
  const scheduler=createScheduler(environment,{baseUrl,automatic:false});
  let worker:ReturnType<typeof createWorker>|undefined;
  try {
    expect(await scheduler.scan()).toMatchObject({conversation:1,delivery:0});
    worker=createWorker(environment);
    const deadline=Date.now()+5000;
    while(!(await f.postgres.pool.query('SELECT 1 FROM public.processing_receipts WHERE user_id=$1',[seed.user_id])).rowCount){
      if(Date.now()>deadline)throw new Error('lost_notify_processing_failed');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect((await f.postgres.pool.query('SELECT count(*)::int AS count FROM public.processing_receipts WHERE user_id=$1',[seed.user_id])).rows[0]).toEqual({count:1});
    await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=true');
    await expect(scheduler.scan()).rejects.toThrow();
  }finally{await worker?.stop();await scheduler.stop();await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=false');}
});
