import {beforeAll,afterAll,expect,test} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {taskFixture} from '../../support/task-fixture.js';
import {sealSourceMap,openSourceMap} from '../../../src/infrastructure/postgres/privacy/token-map.js';
let f:Awaited<ReturnType<typeof taskFixture>>;
beforeAll(async()=>{f=await taskFixture();},120000);afterAll(async()=>{await f?.close();});
test('mapping is encrypted, authenticated and expires independently of tenant SQL',()=>{
 const key=randomBytes(32),now=Date.now(),map={TOKEN_A:'private'};const sealed=sealSourceMap(map,key,now+1000);
 expect(JSON.stringify(sealed)).not.toContain('private');expect(openSourceMap(sealed,key,now)).toEqual(map);
 expect(()=>openSourceMap(sealed,randomBytes(32),now)).toThrow();expect(()=>openSourceMap(sealed,key,now+1000)).toThrow();
});
test('forced RLS, same-tenant scope, erasure counts/cascade and bounded retention',async()=>{
 const run=randomUUID();await f.database.tenantTransaction('worker',f.a,tx=>tx.query(`INSERT INTO public.run_token_maps(user_id,run_id,ciphertext,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 minute')`,[f.a,run,'encrypted']));
 expect(await f.database.tenantTransaction('worker',f.b,tx=>tx.query('SELECT run_id FROM public.run_token_maps'))).toEqual([]);
 expect((await f.worker.query('SELECT run_id FROM public.run_token_maps')).rows).toEqual([]);
 await expect(f.scheduler.query('SELECT * FROM public.run_token_maps')).rejects.toThrow();
 await expect(f.database.tenantTransaction('worker',f.b,tx=>tx.query(`INSERT INTO public.run_token_maps(user_id,run_id,ciphertext,expires_at) VALUES($1,$2,'x',clock_timestamp()+interval '1 minute')`,[f.a,randomUUID()]))).rejects.toThrow();
 const op=randomUUID();const erase=(mode:string)=>f.scheduler.query("SELECT public.erase_account($1,$2,'self_service','privacy_request',$3) result",[f.a,op,mode]);
 expect((await erase('preview')).rows[0].result.counts.privacyMaps).toBe(1);await erase('begin');await erase('finish');
 expect((await f.migrator.query('SELECT count(*)::int n FROM public.run_token_maps')).rows[0].n).toBe(0);
 await f.database.tenantTransaction('worker',f.b,tx=>tx.query(`INSERT INTO public.run_token_maps(user_id,run_id,ciphertext,created_at,expires_at) VALUES($1,$2,'expired',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,[f.b,randomUUID()]));
 expect((await f.scheduler.query('SELECT public.retain_privacy_maps(10) n')).rows[0].n).toBe(1);
});
