import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {createDatabase,type Database} from '../../src/infrastructure/postgres/database.js';
import {TurnStore} from '../../src/infrastructure/postgres/agent/turn-store.js';
import {PostgresTurnAuthority} from '../../src/infrastructure/postgres/agent/turn-claim.js';
import {PostgresConversationQueue} from '../../src/infrastructure/postgres/postgres-conversation-queue.js';
import {agentTaskQueries,PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {ContextBuilder} from '../../src/modules/context/application/context-builder.js';
import {PostgresContextReader} from '../../src/infrastructure/postgres/context/context-reader.js';
import {IanaTimeResolver} from '../../src/infrastructure/time/iana-time-resolver.js';
import {TurnCoordinator} from '../../src/modules/agent/application/turn-coordinator.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {PostgresMediaJobs} from '../../src/infrastructure/postgres/media/media-jobs.js';
import {VoicePreparation} from '../../src/modules/media/application/transcript.js';
import {MediaService,releaseAudio} from '../../src/modules/media/application/media-service.js';
import {SandboxCodec} from '../../src/infrastructure/media/sandbox-codec.js';
import {ChoiceTokens,PostgresPendingChoices} from '../../src/infrastructure/postgres/agent/pending-choice.js';
import {syntheticWav,syntheticFlac} from './synthetic-audio.js';
import {frame} from './semantic-frame.js';
import {projectLegacyQuotes} from './semantic-replay.js';
import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import type {AiDecisionProvider} from '../../src/modules/semantic/application/provider-port.js';
const keys=[{version:1,key:Buffer.alloc(32,9)}],mapKey=Buffer.alloc(32,8),digest='b'.repeat(64);
const profile={version:1,externalAllowed:true,regionAllowed:true,categoryAllowed:true,retentionAllowed:true,requiresContentAnalysis:false};
const consent={revision:1,policyVersion:1,processor:'openai' as const,granted:true,disclosureAccepted:true,ownDictation:true,noProhibitedData:true,noUnconsentedThirdParties:true,revoked:false};
function composition(db:Database){const authority=new PostgresTurnAuthority(db,new TurnStore(db,keys),mapKey),tasks=agentTaskQueries(db),time=new IanaTimeResolver(),queue=new PostgresConversationQueue(db),choices=new PostgresPendingChoices(new ChoiceTokens(keys));
 const voice=new VoicePreparation(new PostgresMediaJobs(authority,profile),{} as MediaService,{transcribe:async()=>{throw Error('RESTORE_MUST_REUSE_TRANSCRIPT');}});
 const coordinator=(provider:AiDecisionProvider)=>new TurnCoordinator(authority,new ContextBuilder(tasks,new PostgresContextReader(db)),tasks,time,provider,{profileDigest:digest,externalAllowed:true,deadlineMs:7000},voice);return {authority,queue,choices,coordinator};}
/** Minimal actual Stage3 states, no external provider/audio; used by row-state and the one physical fixture. */
export async function seedStage3Restore(pool:Pool,workerUrl:string){
 const db=createDatabase({worker:workerUrl});const c=composition(db);let mainTurn='',voiceTurn='',choiceId='';
 try{
 for(const mode of ['main','voice','choice']){
 const text=mode==='choice'?'Создай задачу встреча 2026-11-01 в01:30':'Купи молоко',key='message:restore-'+mode;
 if(mode==='choice')await pool.query("UPDATE users SET timezone='America/New_York' WHERE id=(SELECT user_id FROM channel_accounts WHERE external_user_id='401')");
 const payload=mode==='voice'?{kind:'voice',media:{url:'https://synthetic.invalid/audio',token:'synthetic'}}:{kind:'text',text};
 await pool.query("SELECT * FROM accept_max_inbound('401',$1,$2,'2026-09-11T12:48:33Z',$3,$4)",[String(4400+['main','voice','choice'].indexOf(mode)),key,JSON.stringify(payload),'a'.repeat(64)]);
 const event=(await pool.query('SELECT id,conversation_id FROM inbound_events WHERE provider_event_key=$1',[key])).rows[0];const lease=(await c.queue.claim({ownerId:randomUUID(),limit:100})).find(l=>l.conversationId===event.conversation_id)!;
 if(mode==='voice'){
 const ticket=await c.authority.claim(lease,digest);if(!ticket)throw Error('RESTORE_SEED_CLAIM');voiceTurn=ticket.turnId;const jobs=new PostgresMediaJobs(c.authority,profile);await jobs.setConsent(ticket.event.userId,consent,0);await jobs.begin(ticket,consent);
 const media=new MediaService({load:async()=>syntheticWav()},new SandboxCodec(async()=>({encoded:syntheticFlac(),pcmBytes:640})));const audio=await media.prepare(payload.kind==='voice'?payload.media!:{url:'',token:''},consent,profile,async()=>consent,new AbortController().signal);
 try{await jobs.start(ticket,audio);await jobs.commit(ticket,{version:1,text:'Купи хлеб',language:null,confidence:null,segments:[],criticalUncertainty:null,audioChecksum:audio.checksum,provider:'fake',model:'fake',profileVersion:1},1,null);}finally{releaseAudio(audio);await jobs.released(ticket);}
 }else{
 const decision=parseMeaningDraft(projectLegacyQuotes(frame(text,'create',mode==='choice'?{field:'scheduledAt',expression:'2026-11-01 в01:30'}:undefined).grounded.decision));
 const staged=await c.coordinator({decide:async()=>({outcome:'ok',decision,model:'fake',durationMs:1,usage:null})}).run(lease);if(staged.status!=='accepted')throw Error('RESTORE_SEED_STAGE');
 const result=await new PostgresAgentTaskProcessing(c.authority,c.choices).runGroup(staged.ticket,0);
 if(mode==='main')mainTurn=staged.ticket.turnId;
 else{if(!result.choice)throw Error('RESTORE_SEED_CHOICE');choiceId=result.choice.id;await new PostgresTurnFinalizer(c.authority).finalize(staged.ticket);const expired=randomUUID();await pool.query("INSERT INTO pending_choices(id,user_id,conversation_id,turn_id,group_label,revision,expires_at,created_at,outbound_id) SELECT $2,user_id,conversation_id,turn_id,group_label,revision+1,'2020-01-01','2019-12-31',outbound_id FROM pending_choices WHERE id=$1",[choiceId,expired]);
 const options=(await pool.query('SELECT * FROM pending_choice_options WHERE choice_id=$1',[choiceId])).rows;const tokens=new ChoiceTokens(keys);for(const o of options)await pool.query('INSERT INTO pending_choice_options(user_id,choice_id,ordinal,label,key_version,token_hash,commands) VALUES($1,$2,$3,$4,$5,$6,$7)',[o.user_id,expired,o.ordinal,o.label,o.key_version,tokens.hash(tokens.encode({choiceId:expired,revision:2,option:o.ordinal,keyVersion:o.key_version})),JSON.stringify(o.commands)]);choiceId=expired;}
 }
 }
 return {mainTurn,voiceTurn,choiceId};
 }finally{await db.close();}
}
export async function verifyStage3Restore(pool:Pool,workerUrl:string,ids:Awaited<ReturnType<typeof seedStage3Restore>>){
 const db=createDatabase({worker:workerUrl});const c=composition(db);let semanticCalls=0;
 try{
 // Restored leases are deliberately disarmed; old tickets cannot be trusted.
 const initial=(await pool.query("SELECT count(*)::int n FROM work_item_events")).rows[0].n;
 const targets=(await pool.query('SELECT r.conversation_id,w.state,w.lease_owner FROM agent_runs r JOIN conversation_work w USING(conversation_id) WHERE turn_id IN($1,$2)',[ids.mainTurn,ids.voiceTurn])).rows;
 if(targets.length!==2||targets.some(r=>r.state!=='ready'||r.lease_owner!==null))throw Error('RESTORE_LEASE_NOT_DISARMED');
 const leases=(await c.queue.claim({ownerId:randomUUID(),limit:100})).filter(l=>targets.some(r=>r.conversation_id===l.conversationId));let transcriptReused=false,acceptedReused=false;
 for(const lease of leases){
 const ticket=await c.authority.claim(lease,digest);if(!ticket)continue;
 if(ticket.turnId===ids.mainTurn){const staged=await c.coordinator({decide:async()=>{semanticCalls++;throw Error('RESTORE_MUST_REUSE_DECISION');}}).run(lease);if(staged.status!=='accepted')throw Error('RESTORE_DECISION_LOST');await new PostgresAgentTaskProcessing(c.authority,c.choices).runGroup(staged.ticket,0);await new PostgresTurnFinalizer(c.authority).finalize(staged.ticket);acceptedReused=true;}
 if(ticket.turnId===ids.voiceTurn){const jobs=new PostgresMediaJobs(c.authority,profile);const saved=await jobs.read(ticket);const voice=new VoicePreparation(jobs,{} as MediaService,{transcribe:async()=>{throw Error('RESTORE_SECOND_STT');}});const source=await voice.prepare(ticket);if(source.kind!=='text'||source.text!=='Купи хлеб'||!saved?.fact)throw Error('RESTORE_TRANSCRIPT_LOST');transcriptReused=true;}
 }
 const after=(await pool.query('SELECT count(*)::int n FROM work_item_events')).rows[0].n;if(initial!==after||semanticCalls||!acceptedReused||!transcriptReused)throw Error('RESTORE_SECOND_EFFECT');
 const choice=(await pool.query('SELECT state,expires_at<clock_timestamp() expired FROM pending_choices WHERE id=$1',[ids.choiceId])).rows[0];if(!choice?.expired||choice.state!=='pending')throw Error('RESTORE_CHOICE_LOST');
 await pool.query('SELECT public.expire_pending_choices(100)');
 const expired=(await pool.query('SELECT state FROM pending_choices WHERE id=$1',[ids.choiceId])).rows[0];if(expired.state!=='expired')throw Error('RESTORE_EXPIRY_FAILED');
 return {expiredChoiceRetired:true,acceptedDecisionReused:acceptedReused,committedGroupReused:true,transcriptReused,semanticCalls,sttCalls:0,secondEffects:0,expiredChoicePreserved:true};
 }finally{await db.close();}
}
