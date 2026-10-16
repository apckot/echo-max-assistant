import {test,expect} from 'vitest';
import {taskFixture} from '../../support/task-fixture.js';
import {seedStage3Restore,verifyStage3Restore} from '../../support/stage3-restore.js';
import {randomUUID} from 'node:crypto';
test('restore reconciliation disarms leases; accepted group and transcript survive without redispatch or new effects',async()=>{
 const f=await taskFixture();try{const url=f.worker.options.connectionString!;const ids=await seedStage3Restore(f.postgres.pool,url);
 const before=(await f.migrator.query('SELECT count(*)::int n FROM work_item_events')).rows[0].n;expect(before).toBe(1);
 await f.postgres.pool.query('UPDATE system_state SET restore_fence=true');const incident=randomUUID();await f.postgres.pool.query('SELECT public.reconcile_restore($1,clock_timestamp(),true)',[incident]);await f.postgres.pool.query('SELECT public.reopen_restore($1)',[incident]);
 expect(await verifyStage3Restore(f.postgres.pool,url,ids)).toMatchObject({acceptedDecisionReused:true,transcriptReused:true,semanticCalls:0,sttCalls:0,secondEffects:0,expiredChoicePreserved:true});
 }finally{await f.close();}
},120000);
