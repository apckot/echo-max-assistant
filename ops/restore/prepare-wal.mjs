import {readdir,lstat,mkdir,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {decrypt,validWalName,syncPath} from '../backup/crypto.mjs';
const [data]=process.argv.slice(2),archive=process.env.RESTORE_WAL_ARCHIVE_ROOT,target=process.env.RESTORE_TARGET_NAME;
try{
 if(!archive&&!target)process.exit(0); // Explicit base-only restore remains available, without a PITR claim.
 if(!archive||!isAbsolute(archive)||(await lstat(archive)).isSymbolicLink()||!target||!/^[-a-zA-Z0-9_]{1,64}$/.test(target))throw Error();
 const dir=join(data,'echo_wal_archive');await mkdir(dir,{mode:0o700});let count=0;
 for(const name of await readdir(archive)){
  if(!name.endsWith('.enc'))continue;const wal=name.slice(0,-4),file=join(archive,name);
  if(!validWalName(wal)||!(await lstat(file)).isFile())throw Error();
  await decrypt(file,join(dir,wal),process.env.BACKUP_KEY_FILE);count++;
 }
 if(!count)throw Error();
 await writeFile(join(data,'recovery.signal'),'');
 const config=`\nrestore_command = 'cp echo_wal_archive/%f %p'\nrecovery_target_name = '${target}'\nrecovery_target_action = 'promote'\nrecovery_target_timeline = 'latest'\n`;
 await writeFile(join(data,'postgresql.auto.conf'),config,{flag:'a'});await syncPath(join(data,'postgresql.auto.conf'));await syncPath(data);
}catch{console.error('Archived WAL preparation failed; require authenticated archive and explicit valid recovery target');process.exitCode=1;}
