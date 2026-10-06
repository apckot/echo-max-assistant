import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {expect,test} from 'vitest';
const exec=promisify(execFile);
// Image construction happens once in iteration33/final gate, never once per role/test.
const image=process.env.ECHO_SMOKE_IMAGE;
test.each(['gateway','worker','delivery','scheduler'])('%s command starts fenced and drains on SIGTERM',async role=>{
 const args=image?['run','--rm','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--network','none',
 '--env','RESTORE_FENCE=on','--env','FOUNDATION_ECHO_ENABLED=true','--env','MAX_BOT_TOKEN=test-token','--env','MAX_WEBHOOK_SECRET=test-secret','--env','MAX_WEBHOOK_SECRET_VERSION=v1','--env','MAX_WEBHOOK_URL=https://example.org/hook',
 '--env',`DATABASE_URL_${role.toUpperCase()}=postgres://echo_${role}@127.0.0.1/unavailable`,image,role]:['dist/runtime/command.js',role];
 const child=spawn(image?'docker':'node',args,{env:{...process.env,RESTORE_FENCE:'on',MAX_BOT_TOKEN:'test-token',MAX_WEBHOOK_SECRET:'test-secret',MAX_WEBHOOK_SECRET_VERSION:'v1',MAX_WEBHOOK_URL:'https://example.org/hook',
 [`DATABASE_URL_${role.toUpperCase()}`]:`postgres://echo_${role}@127.0.0.1/unavailable`},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));
 const deadline=Date.now()+10000;
 try{
 while(!output.includes('runtime_started')){if(child.exitCode!==null||Date.now()>deadline)throw Error('Startup boundary: '+output);await new Promise(r=>setTimeout(r,20));}
 child.kill('SIGTERM');expect(await exited,output).toBe(0);expect(output).toContain('runtime_stopped');
 }finally{if(child.exitCode===null)child.kill('SIGKILL');}
},20_000);
test.skipIf(!image)('image is non-root and has no writable application directory',async()=>{
 const result=await exec('docker',['run','--rm','--read-only','--entrypoint','sh',image!,'-c','test "$(id -u)" != 0 && test ! -w /app && test ! -w /app/dist']);expect(result.stderr).toBe('');
});
