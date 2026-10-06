import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { encrypt, decrypt, verifyManifest } from '../../../ops/backup/crypto.mjs';
const dirs=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test('authenticated encrypted backup round trips and rejects altered ciphertext or key',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'echo-backup-'));dirs.push(dir);
 const key=join(dir,'key'),plain=join(dir,'plain'),encrypted=join(dir,'backup.enc'),restored=join(dir,'restored');
 await writeFile(key,randomBytes(32),{mode:0o600});await writeFile(plain,'private database bytes');
 await encrypt(plain,encrypted,key);expect((await readFile(encrypted)).includes(Buffer.from('private database bytes'))).toBe(false);
 await decrypt(encrypted,restored,key);expect(await readFile(restored,'utf8')).toBe('private database bytes');
 const data=await readFile(encrypted);data[20]^=1;await writeFile(encrypted,data);
 await expect(decrypt(encrypted,restored,key)).rejects.toThrow();
 await expect(readFile(restored)).rejects.toThrow();
});
test('manifest binds ciphertext, snapshot and PostgreSQL WAL range; malformed/tampered backups fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'echo-backup-'));dirs.push(dir);
 const key=join(dir,'key'),plain=join(dir,'plain'),enc=join(dir,'base.enc');
 await writeFile(key,randomBytes(32),{mode:0o600});await writeFile(plain,'bytes');await encrypt(plain,enc,key);
 const { manifest }=await import('../../../ops/backup/crypto.mjs');
 const m=await manifest(enc,'2026-10-06T00:00:00.000Z',{'WAL-Ranges':[{'Timeline':1,'Start-LSN':'0/1000000','End-LSN':'0/2000000'}]});
 expect(await verifyManifest(enc,m)).toBe(true);
 await expect(verifyManifest(enc,{...m,snapshot_at:'bad'})).rejects.toThrow();
 await writeFile(enc,'altered');await expect(verifyManifest(enc,m)).rejects.toThrow();
});
test('backup script publishes only encrypted verified artifacts and cleans up failed plaintext',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const {mkdir,readdir,chmod}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'echo-backup-'));dirs.push(dir);const bin=join(dir,'bin'),root=join(dir,'backups'),key=join(dir,'key');
 await mkdir(bin);await mkdir(root);await writeFile(key,randomBytes(32),{mode:0o600});
 await writeFile(join(bin,'pg_basebackup'),`#!/bin/sh
for arg; do case "$arg" in --pgdata=*) dest=\${arg#--pgdata=};; esac; done
mkdir "$dest"
printf '%s' '{"WAL-Ranges":[{"Timeline":1,"Start-LSN":"0/1000000","End-LSN":"0/2000000"}]}' > "$dest/backup_manifest"
printf 'private data' > "$dest/data"
: > "$dest/postgresql.auto.conf"
`);await chmod(join(bin,'pg_basebackup'),0o700);
 await writeFile(join(bin,'pg_verifybackup'),'#!/bin/sh\nexit "${VERIFY_EXIT:-0}"\n');await chmod(join(bin,'pg_verifybackup'),0o700);
 const env={...process.env,PATH:bin+':'+process.env.PATH,BACKUP_ROOT:root,BACKUP_KEY_FILE:key};
 const result=await exec('sh',['ops/backup/backup.sh'],{env});const published=result.stdout.trim();
 expect((await readdir(published)).sort()).toEqual(['base.enc','manifest.json']);
 expect(await verifyManifest(join(published,'base.enc'),JSON.parse(await readFile(join(published,'manifest.json'),'utf8')))).toBe(true);
 await expect(exec('sh',['ops/backup/backup.sh'],{env:{...env,VERIFY_EXIT:'1'}})).rejects.toThrow();
 expect(await readdir(root)).toHaveLength(1);
});
test('WAL archive accepts segments and timeline/backup history, rejects traversal, and verifies retry identity',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const {mkdir}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'echo-wal-'));dirs.push(dir);
 const root=join(dir,'wal'),key=join(dir,'key'),input=join(dir,'input');await mkdir(root);await writeFile(key,randomBytes(32),{mode:0o600});await writeFile(input,'WAL bytes');
 const env={...process.env,WAL_ARCHIVE_ROOT:root,BACKUP_KEY_FILE:key};
 for(const name of ['000000010000000000000001','00000002.history','0000000100001234000055CD.007C9330.backup']){
 await exec('sh',['ops/backup/archive-wal.sh',input,name],{env});await exec('sh',['ops/backup/archive-wal.sh',input,name],{env});
 expect((await readFile(join(root,name+'.enc'))).length).toBeGreaterThan(36);
 }
 await expect(exec('sh',['ops/backup/archive-wal.sh',input,'../00000002.history'],{env})).rejects.toThrow();
 await writeFile(input,'different WAL');await expect(exec('sh',['ops/backup/archive-wal.sh',input,'00000002.history'],{env})).rejects.toThrow();
});
test('backup CLI actually executes through a symlinked checkout path',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const {symlink}=await import('node:fs/promises');const {resolve}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'echo-symlink-'));dirs.push(dir);const link=join(dir,'checkout'),key=join(dir,'key'),input=join(dir,'plain'),out=join(dir,'encrypted');
 await symlink(resolve('.'),link,'dir');await writeFile(key,randomBytes(32),{mode:0o600});await writeFile(input,'database bytes');
 await exec('node',[join(link,'ops/backup/crypto.mjs'),'encrypt',input,out,key]);
 expect((await readFile(out)).length).toBeGreaterThan(36);
});
