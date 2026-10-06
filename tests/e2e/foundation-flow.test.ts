import {createServer} from 'node:http';
import {expect,test} from 'vitest';
import pino from 'pino';
import {deliveryFixture} from '../support/delivery-fixture.js';
import {createGateway} from '../../src/runtime/gateway.js';
import {createWorker} from '../../src/runtime/worker.js';
import {createDelivery} from '../../src/runtime/delivery.js';
test('real HTTP foundation voice: durable capability_unavailable, post-commit worker restart, one confirmed reply after replay',async()=>{
 const f=await deliveryFixture();const env={...Object.fromEntries(Object.entries(f.pools).map(([r,p])=>[`DATABASE_URL_${r==='migrator'?'MIGRATIONS':r.toUpperCase()}`,p.options.connectionString])),
 MAX_BOT_TOKEN:'test-token',MAX_WEBHOOK_SECRET:'test-secret',MAX_WEBHOOK_URL:'https://example.org/hook',RESTORE_FENCE:'off'};
 const app=createGateway(env,pino({level:'silent'}));let worker,delivery;let sent=0;
 const max=createServer(async(req,res)=>{for await(const _ of req){}sent++;res.end('{"message":{"body":{"mid":"confirmed"}}}');});
 const until=async(boundary:string,check:()=>Promise<boolean>)=>{const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error(boundary+' boundary failed');await new Promise(r=>setTimeout(r,20));}};
 try{
 await new Promise<void>(r=>max.listen(0,'127.0.0.1',r));await app.listen({host:'127.0.0.1',port:0});
 const body=JSON.stringify({update_type:'message_created',timestamp:String(Date.now()),message:{sender:{user_id:'123',is_bot:false},recipient:{chat_id:'123',chat_type:'dialog'},
 body:{mid:'voice-canary',attachments:[{type:'audio',payload:{url:'https://example.org/private-audio',token:'test-media-token'}}]}}});
 const post=async()=>{const response=await fetch(app.listeningOrigin+'/webhooks/max',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'test-secret'},body});expect(response.status,'authenticated ingress').toBe(200);await response.arrayBuffer();};
 await post();worker=createWorker(env);
 await until('application commit',async()=>((await f.postgres.pool.query('SELECT count(*)::int n FROM public.processing_receipts')).rows[0].n===1));await worker.stop();worker=undefined;
 expect((await f.postgres.pool.query('SELECT failure_code FROM public.inbound_events')).rows[0].failure_code).toBe('capability_unavailable');
 expect((await f.postgres.pool.query('SELECT status FROM public.outbound_messages')).rows).toEqual([{status:'pending'}]);
 worker=createWorker(env);delivery=createDelivery(env,{baseUrl:`http://127.0.0.1:${(max.address() as {port:number}).port}`});
 await until('confirmed delivery',async()=>((await f.postgres.pool.query("SELECT count(*)::int n FROM public.outbound_messages WHERE status='sent'")).rows[0].n===1));
 await post();await delivery.stop();delivery=undefined;await worker.stop();worker=undefined;
 for(const table of ['inbound_events','processing_receipts','outbound_messages'])expect((await f.postgres.pool.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n,table+' idempotency').toBe(1);
 expect(sent).toBe(1);
 }finally{await worker?.stop();await delivery?.stop();await app.close();max.closeAllConnections();await new Promise<void>(r=>max.close(()=>r()));await f.close();}
},120_000);
