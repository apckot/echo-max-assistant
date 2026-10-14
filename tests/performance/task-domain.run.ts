import {test,expect} from 'vitest';
import {cpus,totalmem,platform,arch} from 'node:os';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {createDatabase} from '../../src/infrastructure/postgres/database.js';
import {taskFixture} from '../support/task-fixture.js';
import {seedTaskLoad,seedId,loadSeed} from '../support/task-load-fixture.js';
import {taskHarness,taskRequest} from '../support/task-command-fixtures.js';
import {TaskQueries} from '../../src/modules/tasks/application/task-queries.js';
import {PostgresTaskReadRunner} from '../../src/infrastructure/postgres/tasks/task-read-model.js';
import {IanaTimeResolver} from '../../src/infrastructure/time/iana-time-resolver.js';
test('fixed-seed Task load: tenant isolation, receipt/history invariants and typed command p95',async()=>{
 const smoke=process.env.ECHO_TASK_LOAD_SMOKE==='1',tenants=smoke?2:1000,tasksPerTenant=smoke?5:100,concurrency=smoke?2:10,warmup=smoke?2:100,measured=smoke?10:1000;
 const f=await taskFixture();const loadDb=createDatabase({worker:f.worker.options.connectionString,poolSize:concurrency,workerTransactionTimeoutMs:5000});try{
 const preparationStarted=performance.now();
 const users=await seedTaskLoad(f,tenants,tasksPerTenant),h=taskHarness({...f,database:loadDb}),q=new TaskQueries(new PostgresTaskReadRunner(loadDb),new IanaTimeResolver());
 const preparationMs=performance.now()-preparationStarted;
 const replay=taskRequest(users[0],[{kind:'create',localId:'a',title:'Load item 1'}],'seed:'+seedId('task:0:0'));replay.context.source={kind:'typed',operationId:seedId('receipt:0:0')};expect(await h.execute(replay.context,replay.group)).toMatchObject({replayed:true,receipt:{outcome:'applied'}});
 // Expand only the isolated harness pool; production pool defaults stay unchanged.
 const durations:number[]=[],commands:number[]=[],versions=new Map<string,number>();let writes=0;
 async function operation(n:number,measure:boolean){
  const tenant=n%tenants,userId=users[tenant],id=seedId('task:'+tenant+':'+(Math.floor(n/tenants)%tasksPerTenant));
  const start=performance.now(),write=n%5===0;
  if(write){const version=versions.get(id)??1;const request=taskRequest(userId,[{kind:'update',target:{taskId:id},expectedVersion:version,patch:{title:'Load revision '+n}}],'load:'+n);
   request.context.source={kind:'typed',operationId:seedId('operation:'+n)};
   const result=await h.execute(request.context,request.group);expect(result).toMatchObject({receipt:{outcome:'applied'}});versions.set(id,version+1);writes++;
  }else{const context={userId,capability:'task_read',timezone:'Europe/Moscow'};const result=await q.list(context,{text:n%2?'Load':'revision',limit:20});expect(result.items.every(t=>t.userId===userId)).toBe(true);}
  const ms=performance.now()-start;if(measure){durations.push(ms);if(write)commands.push(ms);}
 }
 // Each deterministic batch contains distinct (tenant,task) write targets.
 for(let start=0;start<warmup+measured;start+=concurrency)await Promise.all(Array.from({length:Math.min(concurrency,warmup+measured-start)},(_,i)=>operation(start+i,start+i>=warmup)));
 const pct=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]??0;
 const counts=(await f.postgres.pool.query(`SELECT (SELECT count(*)::int FROM public.work_items) tasks,(SELECT count(*)::int FROM public.work_item_events) events,(SELECT count(*)::int FROM public.task_command_receipts) receipts`)).rows[0];
 expect(counts).toEqual({tasks:tenants*tasksPerTenant,events:tenants*tasksPerTenant+writes,receipts:tenants*tasksPerTenant+writes});
 const invalid=(await f.postgres.pool.query(`SELECT count(*)::int n FROM public.work_items w WHERE w.user_id=ANY($1::uuid[]) AND w.version<>(SELECT max(e.after_version) FROM public.work_item_events e WHERE e.task_id=w.id AND e.user_id=w.user_id)`,[users])).rows[0].n;expect(invalid).toBe(0);
 // Runtime worker EXPLAIN preserves the same tenant/RLS authority as measured queries.
 const plans=await f.database.tenantTransaction('worker',users[0],async tx=>{
 await tx.query('SELECT public.guard_worker_restore_fence()');return tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM public.work_items WHERE user_id=$1 AND status='open' AND strpos(lower(title),'load')>0 ORDER BY created_at DESC,id DESC LIMIT 21`,[users[0]]);});
 const indexes=(await f.postgres.pool.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('work_items','work_item_events','task_command_receipts') ORDER BY indexname")).rows;
 const report={kind:smoke?'task_load_smoke':'task_domain_A24',codeBase:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),seed:loadSeed,preparationMs,preparationClients:Math.min(10,tenants),tenants,tasksPerTenant,concurrency,warmup,measured,readWrite:'80/20',measuredWrites:commands.length,
 p95OperationMs:pct(durations),p95TypedCommandMs:pct(commands),thresholdMs:1000,invariantsPassed:true,postgres:(await f.postgres.pool.query('SHOW server_version')).rows[0].server_version,
 environment:{node:process.version,cpu:cpus()[0]?.model,logicalCPUs:cpus().length,ramBytes:totalmem(),platform:platform(),arch:arch(),database:'local isolated PostgreSQL17 Docker',poolSize:concurrency},counts,indexes,plans,productionCapacityClaim:false};
 expect(commands).toHaveLength(measured/5);expect(report.p95TypedCommandMs).toBeLessThan(1000);
 if(process.env.ECHO_TASK_PERFORMANCE_REPORT)await writeFile(process.env.ECHO_TASK_PERFORMANCE_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log('TASK_LOAD '+JSON.stringify({...report,indexes:undefined,plans:undefined}));
 }finally{await loadDb.close();await f.close();}
},1200000);
