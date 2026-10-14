import {test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,execute} from '../../support/task-command-fixtures.js';
test('row snapshot restore preserves current/history/receipt, blocks writers and replays only surviving keys',async()=>{
 const source=await taskFixture(),target=await taskFixture();try{
 const request=taskRequest(source.a,[{kind:'create',localId:'a',title:'Restore task'}]),receipt=await execute(taskHarness(source),request);
 const snapshot=(await source.postgres.pool.query('SELECT clock_timestamp() at')).rows[0].at;
 const rows={};for(const table of ['users','work_items','task_command_receipts','work_item_events'])rows[table]=(await source.postgres.pool.query(`SELECT * FROM public.${table}`)).rows;
 const lost=await execute(taskHarness(source),taskRequest(source.a,[{kind:'create',localId:'a',title:'Beyond snapshot'}]));
 const tx=await target.migrator.connect();try{await tx.query('BEGIN');for(const table of ['users','work_items','task_command_receipts','work_item_events'])await tx.query(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_recordset(NULL::public.${table},$1::jsonb)`,[JSON.stringify(rows[table])]);await tx.query('COMMIT');}finally{tx.release();}
 await target.postgres.pool.query('UPDATE system_state SET restore_fence=true');
 await expect(taskHarness(target).execute(request.context,request.group)).rejects.toThrow();
 const incident=randomUUID();await target.postgres.pool.query('SELECT public.reconcile_restore($1,$2,true)',[incident,snapshot]);await target.postgres.pool.query('SELECT public.reopen_restore($1)',[incident]);
 expect(await taskHarness(target).execute(request.context,request.group)).toEqual({receipt,replayed:true});
 expect((await target.postgres.pool.query('SELECT public.task_row_snapshot(w) task FROM work_items w WHERE id=$1',[receipt.snapshots[0].id])).rows[0].task).toEqual(receipt.snapshots[0]);
 expect((await target.postgres.pool.query('SELECT after_state FROM work_item_events WHERE task_id=$1',[receipt.snapshots[0].id])).rows[0].after_state).toEqual(receipt.snapshots[0]);
 expect((await target.postgres.pool.query('SELECT count(*)::int n FROM work_items WHERE id=$1',[lost.snapshots[0].id])).rows[0].n).toBe(0);
 expect((await target.postgres.pool.query('SELECT count(*)::int n FROM task_command_receipts')).rows[0].n).toBe(1);
 }finally{await source.close();await target.close();}
},120000);
