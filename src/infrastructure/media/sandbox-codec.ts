import {spawn} from 'node:child_process';
import type {Readable} from 'node:stream';
import type {AudioCodec,InspectedAudio} from '../../modules/media/application/media-service.js';
export interface CodecOutput {readonly encoded:Uint8Array;readonly pcmBytes:number}
export type CodecRunner=(input:Uint8Array,signal:AbortSignal)=>Promise<CodecOutput>;
export function codecSandboxArgs():string[]{return ['--cpu=5','--as=536870912','--nproc=64','--fsize=52428800','--','/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--setenv','PATH','/usr/bin','--setenv','LANG','C','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind-try','/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/work','--file','0','/work/input','--preserve-fds','1','--chdir','/work','/usr/bin/ffmpeg','-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-i','/work/input','-map','0:a:0','-vn','-map_metadata','-1','-map_chapters','-1','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','s16le','pipe:3','-map','0:a:0','-vn','-map_metadata','-1','-map_chapters','-1','-ac','1','-ar','16000','-c:a','flac','-f','flac','pipe:1'];}
const nativeRunner:CodecRunner=(input,signal)=>new Promise((resolve,reject)=>{
 if(process.platform!=='linux'||signal.aborted){reject(Error('CODEC_SANDBOX_UNAVAILABLE'));return;}
 const child=spawn('/usr/bin/prlimit',codecSandboxArgs(),{stdio:['pipe','pipe','pipe','pipe'],detached:true,env:{PATH:'/usr/bin',LANG:'C'}});
 const chunks:Buffer[]=[];let size=0,pcmBytes=0,failed=false;
 const kill=()=>{failed=true;try{process.kill(-child.pid!,'SIGKILL');}catch{child.kill('SIGKILL');}};
 signal.addEventListener('abort',kill,{once:true});child.stdout!.on('data',(b:Buffer)=>{size+=b.length;if(size>25000000)kill();else chunks.push(Buffer.from(b));});
 (child.stdio[3] as Readable).on('data',(b:Buffer)=>{pcmBytes+=b.length;if(pcmBytes>50*1024*1024)kill();});
 child.stderr!.on('data',()=>{});child.stdin!.on('error',()=>{});child.stdin!.end(input);
 child.once('error',()=>{failed=true;reject(Error('CODEC_SANDBOX_UNAVAILABLE'));});
 child.once('close',code=>{signal.removeEventListener('abort',kill);try{if(code!==0||failed)reject(Error('MEDIA_CODEC'));else resolve({encoded:Buffer.concat(chunks),pcmBytes});}finally{for(const b of chunks)b.fill(0);}});
});
/** Decode only inside a no-network namespace. No shell, URL, credentials, host temp or fallback decoder. */
export class SandboxCodec implements AudioCodec {
 constructor(private readonly runner:CodecRunner=nativeRunner){}
 async inspect(input:Uint8Array,signal:AbortSignal):Promise<InspectedAudio>{
  const b=Buffer.from(input.buffer,input.byteOffset,input.byteLength),magic=b.subarray(0,4).toString('latin1');
  if(!b.length||b.length>25000000||!(magic==='RIFF'&&b.subarray(8,12).toString()==='WAVE'||magic==='OggS'||magic==='fLaC'||b.subarray(0,3).toString()==='ID3'||b[0]===255&&(b[1]!&224)===224||magic==='\x1aE\xdf\xa3'||b.subarray(4,8).toString()==='ftyp'))throw Error('MEDIA_CODEC');
  const output=await this.runner(input,signal),encoded=Buffer.from(output.encoded.buffer,output.encoded.byteOffset,output.encoded.byteLength);
  if(signal.aborted||encoded.length<42||encoded.length>25000000||encoded.subarray(0,4).toString()!=='fLaC'||(encoded[4]!&127)!==0||encoded.readUIntBE(5,3)!==34||output.pcmBytes<=0||output.pcmBytes%2!==0||output.pcmBytes>50*1024*1024)throw Error('MEDIA_CODEC');
  const format=encoded.readBigUInt64BE(18),sampleRate=Number((format>>44n)&0xfffffn),channels=Number((format>>41n)&7n)+1,bits=Number((format>>36n)&31n)+1;
  const durationMs=output.pcmBytes/32;if(sampleRate!==16000||channels!==1||bits!==16||durationMs>1200000)throw Error('MEDIA_CODEC');
  return {bytes:Uint8Array.from(encoded),format:'flac',contentType:'audio/flac',durationMs};
 }
}
