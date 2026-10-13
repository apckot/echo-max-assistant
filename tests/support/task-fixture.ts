import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { startPostgres } from './postgres.js';
import { runMigrations } from '../../src/infrastructure/postgres/migrations.js';
import { createDatabase } from '../../src/infrastructure/postgres/database.js';
import type { UserId } from '../../src/shared/types/identity.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function taskFixture(){
 const postgres=await startPostgres();
 await postgres.pool.query(await readFile(root+'bootstrap/roles.sql','utf8'));
 const roleUrl=(role:string)=>{const u=new URL(postgres.pool.options.connectionString!);u.username='echo_'+role;u.password='isolated-test-password';return u.toString();};
 for(const role of ['migrator','worker','gateway','delivery','scheduler'])await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
 const migrator=new Pool({connectionString:roleUrl('migrator')});
 const worker=new Pool({connectionString:roleUrl('worker')});
 const gateway=new Pool({connectionString:roleUrl('gateway')});
 const delivery=new Pool({connectionString:roleUrl('delivery')});
 const scheduler=new Pool({connectionString:roleUrl('scheduler')});
 try{
 await runMigrations(migrator,root+'migrations');
 const user=async(n:string)=>(await gateway.query<{user_id:UserId}>("SELECT * FROM public.resolve_or_create_max_identity($1,$2,'bot_started')",[n,'9'+n])).rows[0]!.user_id;
 const a=await user('301'),b=await user('302');
 const database=createDatabase({worker:roleUrl('worker'),poolSize:4,workerTransactionTimeoutMs:5000});
 return {postgres,migrator,worker,gateway,delivery,scheduler,database,a,b,
  async close(){await database.close();await Promise.all([migrator,worker,gateway,delivery,scheduler].map(p=>p.end()));await postgres.stop();}};
 }catch(error){await Promise.all([migrator,worker,gateway,delivery,scheduler].map(p=>p.end()));await postgres.stop();throw error;}
}
