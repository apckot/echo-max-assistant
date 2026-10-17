import {loadQueueProbe} from './load-probe.js';
import {LoadEvidence} from './load-evidence.js';
import {randomUUID} from 'node:crypto';
import {agentFixture} from './agent-fixture.js';
import {seedTaskLoad} from './task-load-fixture.js';
import {startWorkerLoop} from '../../src/runtime/worker.js';
import {PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {PostgresMediaJobs} from '../../src/infrastructure/postgres/media/media-jobs.js';
import {VoicePreparation} from '../../src/modules/media/application/transcript.js';
import {MediaService} from '../../src/modules/media/application/media-service.js';
import {SandboxCodec} from '../../src/infrastructure/media/sandbox-codec.js';
import {syntheticWav,syntheticFlac} from './synthetic-audio.js';
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const profile={version:1,externalAllowed:true,regionAllowed:true,categoryAllowed:true,retentionAllowed:true,requiresContentAnalysis:false};
const consent={revision:1,policyVersion:1,processor:'openai' as const,granted:true,disclosureAccepted:true,ownDictation:true,noProhibitedData:true,noUnconsentedThirdParties:true,revoked:false};
export async function stage3Load(full=false,fault?:{failSemanticAt:number},evidencePath?:string){
 const evidence=new LoadEvidence(evidencePath);const began=Date.now();let f:Awaited<ReturnType<typeof agentFixture>>|undefined;
 let sample:ReturnType<typeof setInterval>|undefined;let probe:ReturnType<typeof loadQueueProbe>|undefined;
 const loops:ReturnType<typeof startWorkerLoop>[]=[];
 const tenants=full?1000:2,operations=full?160:10,aiMs=full?1000:0,sttMs=full?5000:0;let calls=0,sttCalls=0,failures=0,failedTurns=0,blockedGroups=0,localQueries=0;const stats=Array.from({length:2},()=>({ai:0,stt:0,maxAi:0,maxStt:0}));
 try{
 f=await agentFixture();const fixture=f;
 evidence.update({phase:'seeding',containerReady:true});
 const users=await seedTaskLoad(fixture,tenants,full?5:1,n=>evidence.update({seededTenants:n,seededTasks:n*(full?5:1)}));
 await fixture.migrator.query("INSERT INTO channel_accounts(user_id,external_user_id) SELECT id,(100000+ordinality)::text FROM unnest($1::uuid[]) WITH ORDINALITY x(id,ordinality)",[users]);
 const prepMs=Date.now()-began;if(prepMs>60000)throw Error('LOAD_PREPARATION_LIMIT');
 evidence.update({phase:'workers_start',prepMs,seededTenants:tenants,seededTasks:tenants*(full?5:1)});
 const latencies:number[]=[],admitted=new Map<string,number>();
 const consentJobs=new PostgresMediaJobs(fixture.authority,profile);
 for(const id of users.filter((_,i)=>!full||i<operations&&i%4===0))await consentJobs.setConsent(id,consent,0);
 for(let w=0;w<2;w++){
 const s=stats[w]!,jobs=new PostgresMediaJobs(fixture.authority,profile);
 const voice=new VoicePreparation(jobs,new MediaService({load:async()=>syntheticWav()},new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:640}))),{transcribe:async audio=>{sttCalls++;s.stt++;s.maxStt=Math.max(s.maxStt,s.stt);try{await sleep(sttMs);return {outcome:'ok',durationMs:sttMs,usage:null,transcript:{version:1,text:'Купи молоко',language:null,confidence:null,segments:[],criticalUncertainty:null,audioChecksum:audio.checksum,provider:'fake',model:'fake',profileVersion:1}};}finally{s.stt--;}}});
 const coordinator=fixture.coordinator({decide:async(...args)=>{const callNumber=++calls;s.ai++;s.maxAi=Math.max(s.maxAi,s.ai);try{await sleep(aiMs);if(callNumber===fault?.failSemanticAt)return {outcome:'http_error' as const,durationMs:aiMs};return await fixture.fake.decide(...args);}finally{s.ai--;}}},voice);
 loops.push(startWorkerLoop({queue:fixture.queue,concurrency:4,leaseMs:15000,renewMs:1000,close:async()=>{},process:{run:async(lease,signal)=>{try{evidence.update({activity:'processing',calls,sttCalls});const staged=await coordinator.run(lease,signal);if('ticket' in staged){if(staged.status==='failed')failedTurns++;if(staged.status==='accepted'){blockedGroups+=staged.ticket.plan!.groups.filter(g=>g.status!=='ready').length;if(staged.ticket.plan!.queries.length)localQueries++;}if(staged.status==='accepted')for(let i=0;i<staged.ticket.plan!.groups.length;i++)await new PostgresAgentTaskProcessing(fixture.authority).runGroup(staged.ticket,i);await new PostgresTurnFinalizer(fixture.authority).finalize(staged.ticket);const at=admitted.get(staged.ticket.event.providerEventKey);if(at!==undefined)latencies.push(Date.now()-at);}}catch{failures++;throw Error('LOAD_PROCESSING_FAILED');}}}}));
 }
 probe=loadQueueProbe(fixture.migrator.options.connectionString!);let probing=false;sample=setInterval(()=>{evidence.update({calls,sttCalls,failures,failedTurns,blockedGroups,localQueries,completed:latencies.length,stats});if(probing)return;probing=true;void probe!.sample().then(rows=>evidence.update({queue:rows})).catch(()=>evidence.update({queueReadError:true})).finally(()=>{probing=false;});},1000);
 const productionStart=Date.now();evidence.update({phase:'admission'});
 for(let i=0;i<operations;i++){
 const due=full?(i<60?i*1000:60000+(i-60)*100):0;if(due>Date.now()-productionStart)await sleep(due-(Date.now()-productionStart));
 const n=i%tenants,voice=i%4===0;const key='message:load:'+randomUUID();admitted.set(key,Date.now());
 const accepted=await fixture.gateway.query("SELECT * FROM public.accept_max_inbound($1,$2,$3,'2026-09-11T12:48:33Z',$4,$5)",[String(100001+n),String(200000+n),key,JSON.stringify(voice?{kind:'voice',media:{url:'https://synthetic.invalid/audio',token:'synthetic'}}:{kind:'text',text:i%7===0?'/today':'Купи молоко'}),'a'.repeat(64)]);
 // Register by provider key before intake commits, including zero-AI shortcuts.
 evidence.update({admitted:i+1,calls,sttCalls,completed:latencies.length});void accepted;
 }
 evidence.update({phase:'drain'});
 const deadline=began+(full?240000:30000);
 while(latencies.length<operations&&Date.now()<deadline&&failures===0)await sleep(20);
 clearInterval(sample);evidence.update({calls,sttCalls,failures,failedTurns,blockedGroups,localQueries,completed:latencies.length,stats});
 if(latencies.length!==operations||failures)throw Error('LOAD_DRAIN_FAILED');
 await Promise.all(loops.map(l=>l.stop()));loops.length=0;
 const counts=(await fixture.migrator.query(`SELECT (SELECT count(*)::int FROM processing_receipts WHERE receipt_type='assistant_turn_v1') processed,(SELECT count(*)::int FROM media_transcripts) transcripts,(SELECT count(*)::int FROM work_items WHERE title='Молоко') created`)).rows[0];
 const sorted=latencies.sort((a,b)=>a-b);
 evidence.update({phase:'completed',status:'completed',counts});
 return {kind:'fake_stage3_orchestration_load',full,tenants,seedTasks:tenants*(full?5:1),operations,workers:2,aiMs,sttMs,prepMs,durationMs:Date.now()-began,calls,sttCalls,failures,failedTurns,blockedGroups,localQueries,counts,stats,p95Ms:sorted[Math.ceil(sorted.length*.95)-1],externalCalls:0};
 }catch(error){clearInterval(sample);evidence.update({status:'failed',failure:error instanceof Error?error.message:'unknown'});throw error;}finally{evidence.update({phase:'cleanup',cleanup:'started'});try{clearInterval(sample);await probe?.close();await Promise.all(loops.map(l=>l.stop()));await f?.close();evidence.update({cleanup:'complete'});}finally{evidence.close();}}
}

export function acceptStage3Load(r:Awaited<ReturnType<typeof stage3Load>>){const expected=r.full?{semantic:143,voice:40,queries:17}:{semantic:9,voice:3,queries:1};return r.failures===0&&r.failedTurns===0&&r.blockedGroups===0&&r.counts.processed===r.operations&&r.calls===expected.semantic&&r.counts.created===expected.semantic&&r.sttCalls===expected.voice&&r.counts.transcripts===expected.voice&&r.localQueries===expected.queries&&r.stats.every(s=>s.maxAi<=4&&s.maxStt<=2);}
