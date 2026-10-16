import {test,expect} from 'vitest';
import {MediaService} from '../../../src/modules/media/application/media-service.js';
import {SandboxCodec} from '../../../src/infrastructure/media/sandbox-codec.js';
import {OpenAiSttProvider,OPENAI_STT_MODEL} from '../../../src/infrastructure/media/openai-stt-provider.js';
import {syntheticWav,syntheticFlac} from '../../support/synthetic-audio.js';
const consent={revision:1,policyVersion:1,processor:'openai' as const,granted:true,disclosureAccepted:true,ownDictation:true,noProhibitedData:true,noUnconsentedThirdParties:true,revoked:false};
const profile={version:1,externalAllowed:true,regionAllowed:true,categoryAllowed:true,retentionAllowed:true,requiresContentAnalysis:false};
async function audio(){return new MediaService({load:async()=>syntheticWav()},new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:640}))).prepare({url:'https://media.example.org/private',token:'private-attachment'},consent,profile,async()=>consent,new AbortController().signal);}
test('real multipart contract through FakeHTTP contains only recording/model/format; no invented confidence or context',async()=>{
 const approved=await audio();let calls=0;
 const stt=new OpenAiSttProvider({apiKey:'fake-key'},async(url,init)=>{calls++;expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');expect(init.redirect).toBe('error');const body=init.body as FormData;expect([...body.keys()].sort()).toEqual(['file','model','response_format']);expect(body.get('model')).toBe(OPENAI_STT_MODEL);const file=body.get('file') as File;expect(file.name).toBe('recording.flac');expect(file.type).toBe('audio/flac');expect(Buffer.from(await file.arrayBuffer())).toEqual(syntheticFlac());return new Response(JSON.stringify({text:'Купи молоко',usage:{input_tokens:10,output_tokens:4}}));});
 const result=await stt.transcribe(approved,new Date(Date.now()+1000),new AbortController().signal);expect(result).toMatchObject({outcome:'ok',transcript:{text:'Купи молоко',confidence:null,criticalUncertainty:null,audioChecksum:approved.checksum}});expect(calls).toBe(1);
});
test('forged audio/expired deadline deny locally; transport uncertainty and invalid received transcript are separate and never retry',async()=>{
 const approved=await audio();let calls=0;const stt=new OpenAiSttProvider({apiKey:'fake-key'},async()=>{calls++;throw Error('must stay private');});
 expect((await stt.transcribe({...approved},new Date(Date.now()+1000),new AbortController().signal)).outcome).toBe('denied');expect(calls).toBe(0);
 expect((await stt.transcribe(approved,new Date(0),new AbortController().signal)).outcome).toBe('timeout');expect(calls).toBe(0);
 expect((await stt.transcribe(approved,new Date(Date.now()+1000),new AbortController().signal)).outcome).toBe('uncertain');expect(calls).toBe(1);
 const invalid=new OpenAiSttProvider({apiKey:'fake-key'},async()=>new Response('{"text":42}'));expect((await invalid.transcribe(approved,new Date(Date.now()+1000),new AbortController().signal)).outcome).toBe('invalid');
});
test('received malformed UTF-8 is an invalid local parse, not transport uncertainty',async()=>{
 const approved=await audio();const provider=new OpenAiSttProvider({apiKey:'fake-key'},async()=>new Response(new Uint8Array([255,254,253])));
 expect((await provider.transcribe(approved,new Date(Date.now()+1000),new AbortController().signal)).outcome).toBe('invalid');
});

test('voice preparation supplies standard STT deadline through120s and long deadline only above120s',async()=>{
 const {VoicePreparation}=await import('../../../src/modules/media/application/transcript.js');
 for(const [durationMs,expected] of [[90000,18000],[120000,18000],[120001,90000]]){
 const media=new MediaService({load:async()=>syntheticWav()},new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:durationMs!*32})));
 const jobs={profile,read:async()=>null,consent:async()=>consent,begin:async()=>{},start:async()=>{},commit:async()=>{},fail:async()=>{},released:async()=>{}};
 let supplied=0;const voice=new VoicePreparation(jobs,media,{transcribe:async(_audio,deadline)=>{supplied=deadline.getTime()-Date.now();return {outcome:'invalid',reason:'synthetic',durationMs:1,usage:null};}});
 await voice.prepare({event:{payload:{kind:'voice',media:{url:'https://media.example.org/file',token:'synthetic'}}}} as any);
 expect(supplied).toBeGreaterThanOrEqual(expected!-50);expect(supplied).toBeLessThanOrEqual(expected!);
 }
});
