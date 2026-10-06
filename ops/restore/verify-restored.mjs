import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [data,manifest]=process.argv.slice(2);
try{
 const m=JSON.parse(await readFile(manifest,'utf8')),pg=JSON.parse(await readFile(data+'/backup_manifest','utf8'));
 const snapshot=await readFile(data+'/echo_snapshot_at','utf8');
 if(snapshot!==m.snapshot_at||JSON.stringify(pg['WAL-Ranges'])!==JSON.stringify(m.wal_ranges)||createHash('sha256').update(JSON.stringify(pg)).digest('hex')!==m.pg_manifest_sha256)throw Error();
}catch{console.error('Authenticated inner manifest/snapshot mismatch');process.exitCode=1;}
