import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test} from 'vitest';
function guard(files:Record<string,string>){const root=mkdtempSync(join(tmpdir(),'task-ownership-'));try{
 for(const [name,source] of Object.entries(files)){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,source);}
 return spawnSync(process.execPath,[resolve('scripts/check-architecture.mjs')],{cwd:root,encoding:'utf8'});
 }finally{rmSync(root,{recursive:true,force:true});}}
test.each([
 "import {X} from './tasks/task-session.js';", "export {X} from './tasks/task-store.js';", "const X=import('./tasks/task-receipts.js');",
 "import type {TaskSessionRunner} from '../../modules/tasks/application/ports.js';",
])('foreign adapter cannot access Task repository/session: %s',source=>{
 const result=guard({'src/infrastructure/postgres/foreign.ts':source,'src/infrastructure/postgres/tasks/task-session.ts':'export const X=1;'});
 expect(result.status).toBe(1);expect(result.stderr).toContain('Task ownership');
});
test.each([
 "tx.query('INSERT INTO public.work_items(id) VALUES(1)');",
 'tx.query(`UPDATE "public"."work_item_events" SET after_version=2`);',
 "tx.query('DELETE FROM task_command_receipts');",
 "const table='work_items';tx.query(`UPDATE ${table} SET title=$1`);",
 "const sql='INSERT INTO '+ 'work_items';tx.query(sql);",
 "tx.query('UPDATE ONLY public.work_items SET title=$1');",
 "tx['query']('UPDATE '+table+' SET title=$1');",
 "tx?.query('UPDATE '+table+' SET title=$1');",
 "tx.query(buildSql());", "tx.query('UPDATE ' + 'work_items SET title=$1');",
])('foreign SQL cannot write Task tables or hide a query: %s',source=>{
 const result=guard({'src/infrastructure/postgres/foreign.ts':source});expect(result.status).toBe(1);expect(result.stderr).toContain('Task ownership');
});
test('Task adapter and sole bound bridge allowed; public API import allowed',()=>{
 const result=guard({'src/infrastructure/postgres/tasks/task-store.ts':"tx.query('UPDATE public.work_items SET title=$1');",
 'src/infrastructure/postgres/postgres-typed-task-processing.ts':"import {X} from './tasks/task-session.js';",
 'src/modules/surface/application/use-case.ts':"import {TaskCommands} from '../../tasks/application/task-commands.js';"});expect(result.status,result.stderr).toBe(0);
});
