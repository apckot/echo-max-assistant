import {test,expect} from 'vitest';
import {agentFixture} from '../support/agent-fixture.js';
import {MediaService,isApprovedAudio} from '../../src/modules/media/application/media-service.js';
import {SandboxCodec} from '../../src/infrastructure/media/sandbox-codec.js';
import {PostgresMediaJobs} from '../../src/infrastructure/postgres/media/media-jobs.js';
import {VoicePreparation} from '../../src/modules/media/application/transcript.js';
import {PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {GroupRunner} from '../../src/modules/agent/application/group-runner.js';
import {AssistantProcess} from '../../src/modules/agent/application/turn-finalizer.js';
import {syntheticWav,syntheticFlac} from '../support/synthetic-audio.js';
const profile={version:1,externalAllowed:true,regionAllowed:true,categoryAllowed:true,retentionAllowed:true,requiresContentAnalysis:false};
const consent={revision:1,policyVersion:1,processor:'openai' as const,granted:true,disclosureAccepted:true,ownDictation:true,noProhibitedData:true,noUnconsentedThirdParties:true,revoked:false};
const media=()=>new MediaService({load:async()=>syntheticWav()},new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:640})));
const fakeTranscript=(checksum:string,text='Купи молоко')=>({version:1 as const,text,language:null,confidence:null,segments:[],criticalUncertainty:null,audioChecksum:checksum,provider:'fake',model:'fake-stt',profileVersion:1});
test('voice transcript commit/restart reuses text once, with nullable confidence and released bytes, then common Tasks/finalizer',async()=>{
 const f=await agentFixture();try{
 const input=await f.admitVoice(),jobs=new PostgresMediaJobs(f.authority,profile);await jobs.setConsent(f.a,consent,0);let sttCalls=0,semanticCalls=0;let oldAudio:object|undefined;
 const voice=new VoicePreparation(jobs,media(),{transcribe:async audio=>{sttCalls++;oldAudio=audio;return {outcome:'ok',transcript:fakeTranscript(audio.checksum),durationMs:1,usage:null};}});
 const ticket=await f.authority.claim(input.lease,'b'.repeat(64));if(!ticket)throw Error('claim');expect((await voice.prepare(ticket)).kind).toBe('text');expect(isApprovedAudio(oldAudio)).toBe(false);
 const restarted=new VoicePreparation(new PostgresMediaJobs(f.authority,profile),media(),{transcribe:async()=>{throw Error('must not retranscribe');}});
 const coordinator=f.coordinator({decide:async(...args)=>{semanticCalls++;return f.fake.decide(...args);}},restarted);
 const result=await new AssistantProcess(coordinator,new GroupRunner(new PostgresAgentTaskProcessing(f.authority)),new PostgresTurnFinalizer(f.authority)).run(input.lease);expect(result.kind).toBe('actionable');expect(sttCalls).toBe(1);expect(semanticCalls).toBe(1);
 expect((await f.migrator.query('SELECT fact,bytes_released FROM media_transcripts JOIN media_preparations USING(user_id,turn_id)')).rows[0]).toMatchObject({fact:{text:'Купи молоко',confidence:null},bytes_released:true});expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(1);
 }finally{await f.close();}
},120000);
test('saved STT-start without transcript is uncertain: restart performs0STT/0semantic/0Task; denied consent also sends nothing',async()=>{
 const f=await agentFixture();try{
 const input=await f.admitVoice(),jobs=new PostgresMediaJobs(f.authority,profile);await jobs.setConsent(f.a,consent,0);const ticket=await f.authority.claim(input.lease,'b'.repeat(64));if(!ticket)throw Error('claim');await jobs.begin(ticket,consent);const approved=await media().prepare(ticket.event.payload.kind==='voice'?ticket.event.payload.media:{url:'',token:''},consent,profile,async()=>consent,new AbortController().signal);await jobs.start(ticket,approved);
 let calls=0;const voice=new VoicePreparation(jobs,media(),{transcribe:async()=>{calls++;throw Error('not allowed');}});
 const result=await f.coordinator({decide:async()=>{calls++;throw Error('not allowed');}},voice).run(input.lease);expect(result.status).toBe('failed');expect(calls).toBe(0);
 const deniedInput=await f.admitVoice();await jobs.setConsent(f.a,{...consent,revision:2,revoked:true},1);const denied=await f.coordinator(f.fake,voice).run(deniedInput.lease);expect(denied.status).toBe('failed');expect(calls).toBe(0);
 }finally{await f.close();}
},120000);
test('explicit critical uncertainty blocks only its grounded component, even outside the action quote; null confidence alone does not',async()=>{
 const f=await agentFixture();try{
 const text='Купи хлеб и позвони маме',input=await f.admitVoice(),jobs=new PostgresMediaJobs(f.authority,profile);await jobs.setConsent(f.a,consent,0);
 const voice=new VoicePreparation(jobs,media(),{transcribe:async audio=>({outcome:'ok',transcript:{...fakeTranscript(audio.checksum,text),criticalUncertainty:[{start:text.indexOf('маме'),end:text.indexOf('маме')+4,reason:'target'}]},durationMs:1,usage:null})});
 const {parseMeaningDraft}=await import('../../src/modules/semantic/domain/meaning-decision.js');const e=(quote:string)=>[{sourceLabel:'S1',quote}];const unit=(label:string,quote:string)=>({label,kind:'action',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence:e(quote),uncertainty:null});
 const action=(label:string,unitLabel:string,title:string,quote:string)=>({label,unitLabel,kind:'create',target:null,fields:{title,description:null,clearFields:[]},times:[],evidence:e(quote)});
 const decision=parseMeaningDraft({version:2,units:[unit('u1','Купи хлеб'),unit('u2','позвони маме')],actions:[action('a1','u1','Хлеб','Купи хлеб'),action('a2','u2','Позвонить маме','позвони')],relations:[],queries:[],groups:[{label:'g1',unitLabels:['u1'],actionLabels:['a1'],queryLabels:[],outcome:'execute',reason:null},{label:'g2',unitLabels:['u2'],actionLabels:['a2'],queryLabels:[],outcome:'execute',reason:null}]});
 const result=await new AssistantProcess(f.coordinator({decide:async()=>({outcome:'ok',decision,model:'fake',durationMs:1,usage:null})},voice),new GroupRunner(new PostgresAgentTaskProcessing(f.authority)),new PostgresTurnFinalizer(f.authority)).run(input.lease);
 expect((await f.migrator.query('SELECT title FROM work_items')).rows).toEqual([{title:'Хлеб'}]);expect(JSON.stringify(result)).not.toContain('Повторите голос');
 }finally{await f.close();}
},120000);
test('transcript passes text Privacy Gateway before semantic AI; STT transmission is not denied retroactively',async()=>{
 const f=await agentFixture();try{
 const input=await f.admitVoice(),jobs=new PostgresMediaJobs(f.authority,profile);await jobs.setConsent(f.a,consent,0);let sttCalls=0,semanticCalls=0;
 const voice=new VoicePreparation(jobs,media(),{transcribe:async audio=>{sttCalls++;return {outcome:'ok',transcript:fakeTranscript(audio.checksum,'api_key=synthetic-forbidden'),durationMs:1,usage:null};}});
 const result=await f.coordinator({decide:async()=>{semanticCalls++;throw Error('must not call');}},voice).run(input.lease);expect(result.status).toBe('failed');expect(sttCalls).toBe(1);expect(semanticCalls).toBe(0);expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(0);
 }finally{await f.close();}
},120000);
test('actual transcript COMMIT followed by lost ACK is reused, not sent to STT again; erasure removes all derived facts',async()=>{
 const f=await agentFixture();try{
 const input=await f.admitVoice(),jobs=new PostgresMediaJobs(f.authority,profile);await jobs.setConsent(f.a,consent,0);let calls=0;
 const commit=jobs.commit.bind(jobs);jobs.commit=async(...args)=>{await commit(...args);throw Error('ACK_LOST_AFTER_COMMIT');};
 const voice=new VoicePreparation(jobs,media(),{transcribe:async audio=>{calls++;return {outcome:'ok',transcript:fakeTranscript(audio.checksum),durationMs:1,usage:null};}});
 const result=await new AssistantProcess(f.coordinator(f.fake,voice),new GroupRunner(new PostgresAgentTaskProcessing(f.authority)),new PostgresTurnFinalizer(f.authority)).run(input.lease);expect(result.kind).toBe('actionable');expect(calls).toBe(1);
 expect(await f.database.tenantTransaction('worker',f.b,tx=>tx.query('SELECT * FROM media_transcripts'))).toEqual([]);await expect(f.scheduler.query('SELECT * FROM media_transcripts')).rejects.toThrow();
 const {randomUUID}=await import('node:crypto');const op=randomUUID(),erase=(mode:string)=>f.scheduler.query("SELECT public.erase_account($1,$2,'self_service','privacy_request',$3) result",[f.a,op,mode]);expect((await erase('preview')).rows[0].result.counts.mediaTranscripts).toBe(1);await erase('begin');await erase('finish');
 for(const table of ['media_transcripts','media_preparations','audio_consents','agent_runs','accepted_decisions','turn_groups','turn_response_intents','agent_turn_keys'])expect((await f.migrator.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n).toBe(0);
 }finally{await f.close();}
},120000);
