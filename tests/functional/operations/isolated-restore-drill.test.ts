import {seedStage3Restore,verifyStage3Restore} from '../../support/stage3-restore.js';
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
import {createDatabase} from '../../../src/infrastructure/postgres/database.js';
import {TaskCommands} from '../../../src/modules/tasks/application/task-commands.js';
import {PostgresTaskSessionRunner} from '../../../src/infrastructure/postgres/tasks/task-session.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
import {taskRequest} from '../../support/task-command-fixtures.js';
const exec=promisify(execFile);
test('isolated physical encrypted restore: verified WAL/data, fenced replay, measured RPO/RTO',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-restore-'));let source,restored;let pool:Pool|undefined,restoredPool:Pool|undefined;
 const started=Date.now();
 try{
 await chmod(root,0o711);
 const raw=join(root,'raw-wal'),archive=join(root,'encrypted-wal');await mkdir(raw);await mkdir(archive);
 const backups=join(root,'backups'),target=join(root,'isolated'),bin=join(root,'bin'),key=join(root,'key');
 await Promise.all([mkdir(backups),mkdir(target),mkdir(bin)]);await writeFile(key,randomBytes(32),{mode:0o600});
 source=await new PostgreSqlContainer('postgres:17').withBindMounts([{source:root,target:root}]).withCommand(['postgres','-c','archive_mode=on','-c',`archive_command=test -f ${raw}/%f || cp %p ${raw}/%f`]).start();
 await exec('docker',['exec',source.getId(),'chown','postgres:postgres',raw]);
 pool=new Pool({connectionString:source.getConnectionUri()});
 await pool.query('CREATE TABLE public.restore_drill_marker(id boolean PRIMARY KEY,acknowledged_at timestamptz NOT NULL)');
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
 await pool.query("ALTER ROLE echo_worker PASSWORD 'isolated-test-password'");
 const workerUrl=new URL(source.getConnectionUri());workerUrl.username='echo_worker';workerUrl.password='isolated-test-password';
 const userId=(await pool.query('SELECT user_id FROM public.inbound_events LIMIT 1')).rows[0].user_id;
 const request=taskRequest(userId,[{kind:'create',localId:'a',title:'Physical fixture'}]);
 const sourceDb=createDatabase({worker:workerUrl.toString()});
 const command=new TaskCommands(new PostgresTaskSessionRunner(sourceDb),new IanaTimeResolver());
 let created;
 try{created=await command.execute(request.context,request.group);}catch(error){await sourceDb.close();throw error;}
 expect(created).toMatchObject({receipt:{outcome:'applied'}});
 const stage3Ids=await seedStage3Restore(pool,workerUrl.toString());
 const backup=(await exec('sh',['ops/backup/backup.sh'],{env})).stdout.trim();
 const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));
 // Acknowledge NEW work after the base backup; only archive recovery can reproduce it.
 const acknowledged=(await pool.query('INSERT INTO public.restore_drill_marker VALUES(true,clock_timestamp()) RETURNING acknowledged_at')).rows[0].acknowledged_at;
 const mutation=taskRequest(userId,[{kind:'update',target:{taskId:created.receipt.snapshots[0].id},expectedVersion:1,patch:{targetDate:'2026-10-20'}}]);
 const updated=await command.execute(mutation.context,mutation.group);expect(updated).toMatchObject({receipt:{outcome:'applied'}});
 await sourceDb.close();
 const point='echo_drill_'+randomUUID().replaceAll('-','');
 await pool.query('SELECT pg_create_restore_point($1)',[point]);
 const snapshot=(await pool.query('SELECT clock_timestamp() AS t')).rows[0].t;
 // Deliberately outside the named recovery target: never synthesize replay for lost work.
 const beyondDb=createDatabase({worker:workerUrl.toString()});let beyond;
 try{const r=taskRequest(userId,[{kind:'create',localId:'a',title:'Outside recovery target'}]);beyond=await new TaskCommands(new PostgresTaskSessionRunner(beyondDb),new IanaTimeResolver()).execute(r.context,r.group);}finally{await beyondDb.close();}
 const switched=(await pool.query('SELECT pg_walfile_name(pg_switch_wal()) AS filename')).rows[0].filename;
 const end=Date.now()+10000;const {readdir}=await import('node:fs/promises');
 while(!(await readdir(raw)).includes(switched)){if(Date.now()>end)throw Error('WAL archiver boundary failed');await new Promise(r=>setTimeout(r,50));}
 for(const name of await readdir(raw))await exec('sh',['ops/backup/archive-wal.sh',join(raw,name),name],{env:{...env,WAL_ARCHIVE_ROOT:archive}});
 await exec('sh',['ops/restore/prepare-restore.sh',backup],{env:{...env,RESTORE_WAL_ARCHIVE_ROOT:archive,RESTORE_TARGET_NAME:point}});
 expect(await readFile(join(target,'restore.env'),'utf8')).toBe('RESTORE_FENCE=on\n');
 restored=await new PostgreSqlContainer('postgres:17').withBindMounts([{source:join(target,'pgdata'),target:'/var/lib/postgresql/data'}])
 .withCommand(['postgres','-c','listen_addresses=*']).start();
 restoredPool=new Pool({connectionString:restored.getConnectionUri()});
 // A PostgreSQL socket is reachable during hot standby, before named-target promotion.
 const recoveryDeadline=Date.now()+10000;
 while((await restoredPool.query('SELECT pg_is_in_recovery() AS recovering')).rows[0].recovering){
  if(Date.now()>recoveryDeadline)throw Error('Named recovery target/promotion boundary failed');
  await new Promise(r=>setTimeout(r,25));
 }
 await restoredPool.query('UPDATE public.system_state SET restore_fence=true');
 await expect(restoredPool.query('SELECT public.guard_delivery_restore_fence()')).rejects.toThrow();
 const restoredWorkerUrl=new URL(restored.getConnectionUri());restoredWorkerUrl.username='echo_worker';restoredWorkerUrl.password='isolated-test-password';
 const restoredDb=createDatabase({worker:restoredWorkerUrl.toString()});
 const restoredCommands=new TaskCommands(new PostgresTaskSessionRunner(restoredDb),new IanaTimeResolver());
 try{await expect(restoredCommands.execute(mutation.context,mutation.group)).rejects.toThrow();}catch(error){await restoredDb.close();throw error;}
 const incident=randomUUID();await restoredPool.query('SELECT public.reconcile_restore($1,$2,true)',[incident,snapshot]);
 await restoredPool.query('SELECT public.reopen_restore($1)',[incident]);
 expect((await restoredPool.query("SELECT count(*)::int n FROM public.delivery_work WHERE state IN ('ready','retry','leased')")).rows[0].n).toBe(0);
 expect((await restoredPool.query('SELECT status FROM public.outbound_messages')).rows).toEqual([{status:'uncertain_restore'},{status:'uncertain_restore'}]);
 const recovered=(await restoredPool.query('SELECT acknowledged_at FROM public.restore_drill_marker WHERE id=true')).rows[0]?.acknowledged_at;
 expect(recovered,'acknowledged post-base WAL marker').toEqual(acknowledged);
 const taskCounts=(await restoredPool.query(`SELECT (SELECT count(*)::int FROM public.work_items) tasks,(SELECT count(*)::int FROM public.work_item_events) events,(SELECT count(*)::int FROM public.task_command_receipts) receipts`)).rows[0];
 expect(taskCounts).toEqual({tasks:2,events:3,receipts:3});
 const current=(await restoredPool.query('SELECT public.task_row_snapshot(w) task FROM public.work_items w WHERE id=$1',[created.receipt.snapshots[0].id])).rows[0].task;
 expect(current).toEqual(updated.receipt.snapshots[0]);
 try{expect(await restoredCommands.execute(mutation.context,mutation.group)).toEqual({receipt:updated.receipt,replayed:true});expect(await restoredCommands.execute(request.context,request.group)).toEqual({receipt:created.receipt,replayed:true});}finally{await restoredDb.close();}
 expect((await restoredPool.query('SELECT count(*)::int n FROM public.work_items WHERE id=$1',[beyond.receipt.snapshots[0].id])).rows[0].n).toBe(0);
 const stage3=await verifyStage3Restore(restoredPool,restoredWorkerUrl.toString(),stage3Ids);
 const report={stage3,taskFixtureRestored:true,taskPostBaseWALMutationRecovered:true,taskSurvivingReceiptReplay:true,lostTaskNotReplayed:true,taskCounts,postBaseAcknowledgedMarkerRecovered:true,recoverySource:'authenticated encrypted archived WAL',kind:'isolated_physical_restore',postgres:17,authenticatedEncryption:true,pgVerifybackup:true,replayEligibleOldOutbound:0,
 rpoMs:Math.max(0,acknowledged.getTime()-recovered.getTime()),rtoMs:Date.now()-started,productionStorageVerified:false};
 expect(report.rpoMs).toBeLessThanOrEqual(300_000);expect(report.rtoMs).toBeLessThanOrEqual(14_400_000);
 if(process.env.ECHO_RESTORE_REPORT)await writeFile(process.env.ECHO_RESTORE_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log('RESTORE_DRILL '+JSON.stringify(report));
 }finally{await restoredPool?.end();await pool?.end();await restored?.stop();await source?.stop();await rm(root,{recursive:true,force:true});}
},120_000);
