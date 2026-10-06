import { createCipheriv,createDecipheriv,randomBytes,createHash } from 'node:crypto';
import { createReadStream,createWriteStream } from 'node:fs';
import { readFile,writeFile,stat,rm,rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
const header=Buffer.from('ECHOBAK1');
async function key(path){const s=await stat(path);if((s.mode&0o077)!==0)throw Error('Key must be private');const k=await readFile(path);if(k.length!==32)throw Error('Key must contain 32 random bytes');return k;}
export async function encrypt(input,output,keyFile){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',await key(keyFile),iv);cipher.setAAD(header);
 const temp=output+'.partial';
 try{await writeFile(temp,Buffer.concat([header,iv]),{mode:0o600,flag:'wx'});
 await pipeline(createReadStream(input),cipher,createWriteStream(temp,{flags:'a'}));
 await writeFile(temp,cipher.getAuthTag(),{flag:'a'});await rename(temp,output);
 }catch(e){await rm(temp,{force:true});throw e;}
}
export async function decrypt(input,output,keyFile){
 // Authenticated plaintext is published only after the GCM tag verifies.
 const s=await stat(input);if(s.size<36)throw Error('Truncated encrypted backup');
 const {open}=await import('node:fs/promises');const file=await open(input,'r');let prefix,tag;
 try{prefix=Buffer.alloc(20);tag=Buffer.alloc(16);await file.read(prefix,0,20,0);await file.read(tag,0,16,s.size-16);}finally{await file.close();}
 if(!prefix.subarray(0,8).equals(header))throw Error('Unknown encryption format');
 const cipher=createDecipheriv('aes-256-gcm',await key(keyFile),prefix.subarray(8));cipher.setAAD(header);cipher.setAuthTag(tag);
 const temp=output+'.partial';await rm(output,{force:true});
 try{await pipeline(createReadStream(input,{start:20,end:s.size-17}),cipher,createWriteStream(temp,{flags:'wx',mode:0o600}));await rename(temp,output);}
 catch(e){await rm(temp,{force:true});throw e;}
}
async function sha(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
export async function manifest(path,snapshot,pg){
 const m={version:1,encryption:'aes-256-gcm',snapshot_at:snapshot,wal_ranges:pg['WAL-Ranges'],ciphertext_sha256:await sha(path),pg_manifest_sha256:createHash('sha256').update(JSON.stringify(pg)).digest('hex')};
 await verifyManifest(path,m);return m;
}
export async function verifyManifest(path,m){
 if(m.version!==1||m.encryption!=='aes-256-gcm'||!/^\d{4}-\d\d-\d\dT.*Z$/.test(m.snapshot_at)||!Number.isFinite(Date.parse(m.snapshot_at))||!Array.isArray(m.wal_ranges)||!m.wal_ranges.length||m.wal_ranges.some(w=>!Number.isInteger(w.Timeline)||w.Timeline<1||![w['Start-LSN'],w['End-LSN']].every(x=>/^[0-9A-F]+\/[0-9A-F]+$/.test(x)))||!/^[a-f0-9]{64}$/.test(m.pg_manifest_sha256)||await sha(path)!==m.ciphertext_sha256)throw Error('Invalid backup manifest/checksum');
 return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [command,...args]=process.argv.slice(2);
 try{if(command==='encrypt')await encrypt(...args);else if(command==='decrypt')await decrypt(...args);else if(command==='manifest'){
 const [archive,pgPath,out,snapshotPath]=args;await writeFile(out,JSON.stringify(await manifest(archive,await readFile(snapshotPath,'utf8'),JSON.parse(await readFile(pgPath,'utf8'))),null,2)+'\n',{mode:0o600,flag:'wx'});
 }else if(command==='verify')await verifyManifest(args[0],JSON.parse(await readFile(args[1],'utf8')));else throw Error('Unknown backup command');
 }catch{console.error('Backup operation failed (details suppressed to protect connection/key data)');process.exitCode=1;}
}
