import {expect,test} from 'vitest';
import {preflight} from '../../../ops/canary/preflight.mjs';
test('canary stops without dedicated test credentials/recipient and never exposes values',()=>{
 const value=preflight({MAX_BOT_TOKEN:'private-token'});expect(value.ready).toBe(false);
 expect(value.missing).toContain('MAX_CANARY_TEST_CONFIRMED');expect(JSON.stringify(value)).not.toContain('private-token');
});
test('safe canary requires explicit TEST confirmation, exact recipient and HTTPS webhook',()=>{
 const env={MAX_BOT_TOKEN:'test-token',MAX_WEBHOOK_SECRET:'test-secret',MAX_WEBHOOK_SECRET_VERSION:'v1',MAX_WEBHOOK_URL:'https://example.org/hook',MAX_CANARY_TEST_CONFIRMED:'true',MAX_CANARY_TEST_USER_ID:'123'};
 expect(preflight(env)).toEqual({ready:true,missing:[]});
 expect(preflight({...env,MAX_WEBHOOK_URL:'http://example.org/hook'}).ready).toBe(false);
 expect(preflight({...env,MAX_CANARY_TEST_USER_ID:''}).ready).toBe(false);
});
test('canary CLI fails closed through a symlinked checkout',async()=>{
 const {mkdtemp,symlink,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const dir=await mkdtemp(join(tmpdir(),'echo-canary-link-'));
 try{const link=join(dir,'checkout');await symlink(resolve('.'),link,'dir');
 const result=await exec('node',[join(link,'ops/canary/preflight.mjs')],{env:{...process.env,MAX_CANARY_TEST_CONFIRMED:'false'}}).catch(e=>e);
 expect(result.code).toBe(2);expect(JSON.parse(result.stdout).ready).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
