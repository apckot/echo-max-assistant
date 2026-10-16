import {test,expect} from 'vitest';
import {MaxAudioLoader} from '../../../src/infrastructure/media/max-audio-loader.js';
import {SandboxCodec,codecSandboxArgs} from '../../../src/infrastructure/media/sandbox-codec.js';
import {MediaService,readApprovedAudio,isApprovedAudio,releaseAudio} from '../../../src/modules/media/application/media-service.js';
import {audioRoute,audioDisclosure} from '../../../src/modules/media/application/audio-policy.js';
import {syntheticWav,syntheticFlac} from '../../support/synthetic-audio.js';
const consent={revision:1,policyVersion:1,processor:'openai' as const,granted:true,disclosureAccepted:true,ownDictation:true,noProhibitedData:true,noUnconsentedThirdParties:true,revoked:false};
const policy={version:1,externalAllowed:true,regionAllowed:true,categoryAllowed:true,retentionAllowed:true,requiresContentAnalysis:false};
const source={url:'https://media.example.org/file',token:'attachment-private-token'};
const codec=()=>new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:640}));
test('audio is denied before download for missing/revoked consent, declarations, profile or content-analysis requirements',async()=>{
 let downloads=0;const service=new MediaService({load:async()=>{downloads++;return syntheticWav();}},codec());
 for(const [c,p] of [[null,policy],[{...consent,revoked:true},policy],[{...consent,ownDictation:false},policy],[consent,{...policy,requiresContentAnalysis:true}],[consent,{...policy,regionAllowed:false}]] as const)await expect(service.prepare(source,c,p,async()=>c,new AbortController().signal)).rejects.toThrow('AUDIO_DENIED');
 expect(downloads).toBe(0);expect(audioDisclosure).toContain('саму аудиозапись');expect(audioRoute(consent,policy).allowed).toBe(true);
});
test('technical verification issues an opaque expiring capability, not PII confidence; revocation/account/fence checks run again',async()=>{
 const service=new MediaService({load:async()=>syntheticWav()},codec());
 const audio=await service.prepare(source,consent,policy,async()=>consent,new AbortController().signal);
 expect(isApprovedAudio(audio)).toBe(true);expect(isApprovedAudio({...audio})).toBe(false);expect(JSON.stringify(audio)).not.toContain(source.token);expect(Buffer.from(readApprovedAudio(audio))).toEqual(syntheticFlac());releaseAudio(audio);expect(isApprovedAudio(audio)).toBe(false);
 await expect(service.prepare(source,consent,policy,async()=>({...consent,revoked:true}),new AbortController().signal)).rejects.toThrow('AUDIO_DENIED');
 await expect(service.prepare(source,consent,policy,async()=>{throw Error('authority lost');},new AbortController().signal)).rejects.toThrow();
});
test('DNS pinning/private ranges/redirects/oversize fail closed and attachment token never becomes a forwarded credential',async()=>{
 let calls=0;const http=async(_url:URL,options:any)=>{calls++;expect(JSON.stringify(options.headers)).not.toContain(source.token);return {status:200,headers:{},body:(async function*(){yield syntheticWav();})()};};
 const publicDns=async()=>[{address:'8.8.8.8',family:4}];
 const loader=new MaxAudioLoader(['https://media.example.org'],publicDns,http);
 expect(Buffer.from(await loader.load(source,1000,new AbortController().signal))).toEqual(syntheticWav());expect(calls).toBe(1);
 for(const url of ['http://media.example.org/file','https://evil.example.org/file','https://127.0.0.1/file','https://u:p@media.example.org/file'])await expect(loader.load({...source,url},1000,new AbortController().signal)).rejects.toThrow();
 const privateLoader=new MaxAudioLoader(['https://media.example.org'],async()=>[{address:'127.0.0.1',family:4}],http);await expect(privateLoader.load(source,1000,new AbortController().signal)).rejects.toThrow();expect(calls).toBe(1);
 const redirect=new MaxAudioLoader(['https://media.example.org'],publicDns,async()=>({status:302,headers:{location:'https://evil.example.org'},body:(async function*(){})()}));await expect(redirect.load(source,1000,new AbortController().signal)).rejects.toThrow();
 await expect(loader.load(source,10,new AbortController().signal)).rejects.toThrow('MEDIA_SIZE');
});
test('codec sandbox has no network/environment/URL input; bounds decoded PCM, format and duration',async()=>{
 const args=codecSandboxArgs();expect(args).toContain('--unshare-all');expect(args).toContain('--clearenv');expect(args).toContain('--cap-drop');expect(args.join(' ')).not.toContain('https://');
 expect(await codec().inspect(syntheticWav(),new AbortController().signal)).toMatchObject({format:'flac',durationMs:20});
 await expect(codec().inspect(Buffer.from('<html>'),new AbortController().signal)).rejects.toThrow('MEDIA_CODEC');
 await expect(new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:50*1024*1024+2})).inspect(syntheticWav(),new AbortController().signal)).rejects.toThrow();
 await expect(new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:40*1024*1024})).inspect(syntheticWav(),new AbortController().signal)).rejects.toThrow();
});
test('new audio content has tenant RLS, erasure counts/cascade and no raw audio column',async()=>{
 const {taskFixture}=await import('../../support/task-fixture.js');const {randomUUID}=await import('node:crypto');const f=await taskFixture();try{
 await f.database.tenantTransaction('worker',f.a,tx=>tx.query(`INSERT INTO public.audio_consents(user_id,revision,policy_version,processor,granted,disclosure_accepted,own_dictation,no_prohibited_data,no_unconsented_third_parties,revoked) VALUES($1,1,1,'openai',true,true,true,true,true,false)`,[f.a]));
 expect(await f.database.tenantTransaction('worker',f.b,tx=>tx.query('SELECT * FROM public.audio_consents'))).toEqual([]);await expect(f.scheduler.query('SELECT * FROM public.audio_consents')).rejects.toThrow();
 const op=randomUUID();const erase=(mode:string)=>f.scheduler.query("SELECT public.erase_account($1,$2,'self_service','privacy_request',$3) result",[f.a,op,mode]);expect((await erase('preview')).rows[0].result.counts.audioConsents).toBe(1);await erase('begin');await erase('finish');expect((await f.migrator.query('SELECT count(*)::int n FROM audio_consents')).rows[0].n).toBe(0);
 const columns=(await f.migrator.query("SELECT column_name FROM information_schema.columns WHERE table_name='media_preparations'")).rows.map(r=>r.column_name);expect(columns).not.toContain('bytes');expect(columns).not.toContain('token');
 }finally{await f.close();}
},120000);
