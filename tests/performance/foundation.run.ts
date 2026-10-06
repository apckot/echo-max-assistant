import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {expect,test} from 'vitest';
import pino from 'pino';
import {deliveryFixture} from '../support/delivery-fixture.js';
import {createGateway} from '../../src/runtime/gateway.js';
import {createWorker} from '../../src/runtime/worker.js';
import {createDelivery} from '../../src/runtime/delivery.js';
import {burst,percentile,assess} from './webhook-burst.mjs';
import {drain} from './backlog-drain.mjs';
test('production-size pools: 5RPS steady, 30RPS/60s burst, paused-worker backlog drains in two minutes',async()=>{
 const f=await deliveryFixture();let worker,delivery;const app=createGateway({...environment(f),RESTORE_FENCE:'off'},pino({level:'silent'}));
 const fake=createServer(async(req,res)=>{for await(const _ of req){}res.end('{"message":{"body":{"mid":"load-confirmed"}}}');});
 let sample:ReturnType<typeof setInterval>|undefined;let sampling:Promise<void>|undefined;let maxDepth=0,maxConnections=0,maxWaitingLocks=0;let expected=0;
 const counts=async()=>{const r=await f.postgres.pool.query(`SELECT (SELECT count(*)::int FROM public.processing_receipts) receipts,
 (SELECT count(*)::int FROM public.outbound_messages WHERE status='sent') sent`);return r.rows[0];};
 try{
 await new Promise<void>(r=>fake.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${(fake.address() as {port:number}).port}`;
 await app.listen({host:'127.0.0.1',port:0});const url=app.listeningOrigin+'/webhooks/max';
 const start=()=>{worker=createWorker(environment(f));delivery=createDelivery(environment(f),{baseUrl});};start();
 const sampleDb=()=>{if(sampling)return;sampling=(async()=>{const r=await f.postgres.pool.query(`SELECT
 (SELECT count(*)::int FROM public.conversation_work WHERE state='leased' OR (state IN ('ready','retry') AND available_at<=clock_timestamp())) depth,
 (SELECT count(*)::int FROM pg_stat_activity) connections,(SELECT count(*)::int FROM pg_locks WHERE NOT granted) waiting`);
 maxDepth=Math.max(maxDepth,r.rows[0].depth);maxConnections=Math.max(maxConnections,r.rows[0].connections);maxWaitingLocks=Math.max(maxWaitingLocks,r.rows[0].waiting);})().finally(()=>{sampling=undefined;});};
 sample=setInterval(sampleDb,100);
 const scenarios=[];
 for(const [rps,seconds] of [[5,30],[30,60]]){
 const phaseStart=(await f.postgres.pool.query('SELECT clock_timestamp() AS t')).rows[0].t;
 const result=await burst({url,secret:'test-secret',rps,seconds,offset:expected});expected+=result.requests;
 const drainMs=await drain(counts,expected);
 const wake=await f.postgres.pool.query(`SELECT extract(epoch FROM(r.created_at-i.created_at))*1000 AS ms FROM public.processing_receipts r
 JOIN public.inbound_events i ON i.id=r.inbound_event_id WHERE i.created_at >= $1`,[phaseStart]);
 const m={...result,queueWakeP95Ms:percentile(wake.rows.map(r=>Number(r.ms)),.95),drainMs};
 expect(assess(m),JSON.stringify(m)).toEqual([]);expect(m.maxSchedulingLagMs).toBeLessThan(100);scenarios.push(m);
 }
 await worker!.stop();await delivery!.stop();worker=undefined;delivery=undefined;
 const backlog=await burst({url,secret:'test-secret',rps:30,seconds:10,offset:expected});expected+=backlog.requests;
 const backlogDepth=(await f.postgres.pool.query("SELECT count(*)::int n FROM public.conversation_work WHERE state='ready' AND available_at<=clock_timestamp()")).rows[0].n;
 expect(backlogDepth).toBe(300);start();const drainMs=await drain(counts,expected);expect(drainMs).toBeLessThanOrEqual(120000);
 clearInterval(sample);await sampling;
 const report={codeBase:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),measuredAt:new Date().toISOString(),postgres:17,
 pools:{gateway:10,worker:10,delivery:5},runtime:'local Node22, PostgreSQL17 container, real HTTP, loopback FakeMAX',
 queueWakeMetric:'receipt commit timestamp minus ingress creation (upper bound on actual claim wake)',scenarios,
 backlog:{requests:backlog.requests,depth:backlogDepth,drainMs},maxDepth,maxConnections,maxWaitingLocks,thresholdsPassed:true};
 await writeFile(process.env.ECHO_PERFORMANCE_REPORT??'.superpowers/checkpoint-35/performance.json',JSON.stringify(report,null,2)+'\n');
 }finally{clearInterval(sample);await sampling;await worker?.stop();await delivery?.stop();await app.close();fake.closeAllConnections();await new Promise<void>(r=>fake.close(()=>r()));await f.close();}
},180_000);
function environment(f:Awaited<ReturnType<typeof deliveryFixture>>){return {...Object.fromEntries(Object.entries(f.pools).map(([r,p])=>
 [`DATABASE_URL_${r==='migrator'?'MIGRATIONS':r.toUpperCase()}`,p.options.connectionString])),MAX_BOT_TOKEN:'test-token',MAX_WEBHOOK_SECRET:'test-secret',MAX_WEBHOOK_URL:'https://example.org/hook',RESTORE_FENCE:'off'};}
