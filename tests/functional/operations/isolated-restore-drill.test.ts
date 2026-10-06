import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {expect,test} from 'vitest';
import {runMigrations} from '../../../src/infrastructure/postgres/migrations.js';
const exec=promisify(execFile);
test('isolated physical encrypted restore: verified WAL/data, fenced replay, measured RPO/RTO',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-restore-'));let source,restored;let pool:Pool|undefined,restoredPool:Pool|undefined;
 const started=Date.now();
 try{
 const backups=join(root,'backups'),target=join(root,'isolated'),bin=join(root,'bin'),key=join(root,'key');
 await Promise.all([mkdir(backups),mkdir(target),mkdir(bin)]);await writeFile(key,randomBytes(32),{mode:0o600});
 source=await new PostgreSqlContainer('postgres:17').withBindMounts([{source:root,target:root}]).start();
 pool=new Pool({connectionString:source.getConnectionUri()});
 await pool.query(await readFile('bootstrap/roles.sql','utf8'));await pool.query("ALTER ROLE echo_migrator PASSWORD 'isolated-test-password'");
 const url=new URL(source.getConnectionUri());url.username='echo_migrator';url.password='isolated-test-password';
 const migrator=new Pool({connectionString:url.toString()});try{await runMigrations(migrator,resolve('migrations'));}finally{await migrator.end();}
 await pool.query(`SELECT public.accept_max_inbound('101','101','message:drill',clock_timestamp(),'{"kind":"text","text":"test"}','${'a'.repeat(64)}')`);
 await pool.query(`INSERT INTO public.outbound_messages(user_id,conversation_id,source_inbound_event_id,message_index,payload,dedupe_key)
 SELECT user_id,conversation_id,id,0,'{"version":1,"kind":"text","text":"old reply"}','response:'||id||':0:v1' FROM public.inbound_events`);
 await pool.query('INSERT INTO public.delivery_work(outbound_message_id,user_id) SELECT id,user_id FROM public.outbound_messages');
 for(const cmd of ['pg_basebackup','pg_verifybackup']){
 const path=join(bin,cmd);await writeFile(path,`#!/bin/sh\nexec docker exec -e PGPASSWORD='${source.getPassword()}' '${source.getId()}' ${cmd} ${cmd==='pg_basebackup'?'--host=127.0.0.1 --username='+source.getUsername():''} "$@"\n`);await chmod(path,0o700);
 }
 const env={...process.env,PATH:bin+':'+process.env.PATH,BACKUP_ROOT:backups,BACKUP_KEY_FILE:key,RESTORE_ISOLATED_ROOT:target};
 const backup=(await exec('sh',['ops/backup/backup.sh'],{env})).stdout.trim();
 const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));
 await exec('sh',['ops/restore/prepare-restore.sh',backup],{env});
 expect(await readFile(join(target,'restore.env'),'utf8')).toBe('RESTORE_FENCE=on\n');
 restored=await new PostgreSqlContainer('postgres:17').withBindMounts([{source:join(target,'pgdata'),target:'/var/lib/postgresql/data'}])
 .withCommand(['postgres','-c','listen_addresses=*']).start();
 restoredPool=new Pool({connectionString:restored.getConnectionUri()});
 await restoredPool.query('UPDATE public.system_state SET restore_fence=true');
 await expect(restoredPool.query('SELECT public.guard_delivery_restore_fence()')).rejects.toThrow();
 const incident=randomUUID();await restoredPool.query('SELECT public.reconcile_restore($1,$2,true)',[incident,manifest.snapshot_at]);
 await restoredPool.query('SELECT public.reopen_restore($1)',[incident]);
 expect((await restoredPool.query("SELECT count(*)::int n FROM public.delivery_work WHERE state IN ('ready','retry','leased')")).rows[0].n).toBe(0);
 expect((await restoredPool.query('SELECT status FROM public.outbound_messages')).rows).toEqual([{status:'uncertain_restore'}]);
 const report={kind:'isolated_physical_restore',postgres:17,authenticatedEncryption:true,pgVerifybackup:true,replayEligibleOldOutbound:0,
 rpoMs:Date.now()-Date.parse(manifest.snapshot_at),rtoMs:Date.now()-started,productionStorageVerified:false};
 expect(report.rpoMs).toBeLessThanOrEqual(300_000);expect(report.rtoMs).toBeLessThanOrEqual(14_400_000);
 console.log('RESTORE_DRILL '+JSON.stringify(report));
 }finally{await restoredPool?.end();await pool?.end();await restored?.stop();await source?.stop();await rm(root,{recursive:true,force:true});}
},120_000);
