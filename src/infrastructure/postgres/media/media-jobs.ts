import {z} from 'zod';
import type {UserId} from '../../../shared/types/identity.js';
import type {PostgresTurnAuthority} from '../agent/turn-claim.js';
import type {TurnTicket} from '../../../modules/agent/application/turn-port.js';
import {audioRoute,type AudioConsent,type AudioProfile} from '../../../modules/media/application/audio-policy.js';
import {isApprovedAudio,type ApprovedAudio} from '../../../modules/media/application/media-service.js';
import {validateTranscript,type Transcript,type SttUsage} from '../../../modules/media/application/stt-port.js';
const consentSchema=z.strictObject({revision:z.number().int().positive(),policyVersion:z.number().int().positive(),processor:z.literal('openai'),granted:z.boolean(),disclosureAccepted:z.boolean(),ownDictation:z.boolean(),noProhibitedData:z.boolean(),noUnconsentedThirdParties:z.boolean(),revoked:z.boolean()});
export interface MediaState {phase:string;checksum:string|null;fact:Transcript|null;bytes_released:boolean;consent_revision:number;policy_version:number}
export class PostgresMediaJobs {
 readonly profile:AudioProfile;
 constructor(private readonly authority:PostgresTurnAuthority,profile:AudioProfile){this.profile=Object.freeze(structuredClone(profile));}
 private async consentIn(tx:import('../database.js').DbTx,user:UserId):Promise<AudioConsent|null>{
  const [row]=await tx.query<AudioConsent>('SELECT revision,policy_version AS "policyVersion",processor,granted,disclosure_accepted AS "disclosureAccepted",own_dictation AS "ownDictation",no_prohibited_data AS "noProhibitedData",no_unconsented_third_parties AS "noUnconsentedThirdParties",revoked FROM public.audio_consents WHERE user_id=$1 FOR SHARE',[user]);return row?consentSchema.parse(row):null;
 }
 async consent(ticket:TurnTicket){return this.authority.guarded(ticket,(tx,event)=>this.consentIn(tx,event.userId));}
 async setConsent(userId:UserId,input:AudioConsent,expectedRevision:number){const c=consentSchema.parse(input);if(c.revision!==expectedRevision+1)throw Error('AUDIO_CONSENT_VERSION');
  await this.authority.database.tenantTransaction('worker',userId,async tx=>{await tx.query('SELECT public.guard_worker_restore_fence()');const [user]=await tx.query<{status:string}>('SELECT status FROM public.users WHERE id=$1 FOR SHARE',[userId]);if(user?.status!=='active')throw Error('AUDIO_ACCOUNT_UNAVAILABLE');
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['audio-consent:'+userId]);const [old]=await tx.query<{revision:number}>('SELECT revision FROM public.audio_consents WHERE user_id=$1 FOR UPDATE',[userId]);if((old?.revision??0)!==expectedRevision)throw Error('AUDIO_CONSENT_VERSION');
   await tx.query(`INSERT INTO public.audio_consents(user_id,revision,policy_version,processor,granted,disclosure_accepted,own_dictation,no_prohibited_data,no_unconsented_third_parties,revoked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,policy_version=EXCLUDED.policy_version,processor=EXCLUDED.processor,granted=EXCLUDED.granted,disclosure_accepted=EXCLUDED.disclosure_accepted,own_dictation=EXCLUDED.own_dictation,no_prohibited_data=EXCLUDED.no_prohibited_data,no_unconsented_third_parties=EXCLUDED.no_unconsented_third_parties,revoked=EXCLUDED.revoked,updated_at=clock_timestamp()`,[userId,c.revision,c.policyVersion,c.processor,c.granted,c.disclosureAccepted,c.ownDictation,c.noProhibitedData,c.noUnconsentedThirdParties,c.revoked]);
  });
 }
 async read(ticket:TurnTicket){return this.authority.guarded(ticket,async(tx,event)=>{const [row]=await tx.query<MediaState>('SELECT m.phase,m.checksum,m.bytes_released,m.consent_revision,m.policy_version,t.fact FROM public.media_preparations m LEFT JOIN public.media_transcripts t USING(user_id,turn_id) WHERE m.user_id=$1 AND m.turn_id=$2',[event.userId,ticket.turnId]);return row??null;});}
 async begin(ticket:TurnTicket,consent:AudioConsent){await this.authority.guarded(ticket,async(tx,event)=>{if(event.payload.kind!=='voice')throw Error('MEDIA_SOURCE_INVALID');const current=await this.consentIn(tx,event.userId);if(!audioRoute(current,this.profile).allowed||current!.revision!==consent.revision)throw Error('AUDIO_DENIED');await tx.query("INSERT INTO public.media_preparations(user_id,turn_id,phase,consent_revision,policy_version) VALUES($1,$2,'loading',$3,$4) ON CONFLICT(user_id,turn_id) DO NOTHING",[event.userId,ticket.turnId,consent.revision,this.profile.version]);});}
 async start(ticket:TurnTicket,audio:ApprovedAudio){if(!isApprovedAudio(audio))throw Error('AUDIO_DENIED');await this.authority.guarded(ticket,async(tx,event)=>{
  const current=await this.consentIn(tx,event.userId);if(!audioRoute(current,this.profile).allowed||current!.revision!==audio.consentRevision||audio.policyVersion!==this.profile.version)throw Error('AUDIO_DENIED');
  const rows=await tx.query("UPDATE public.media_preparations SET phase='stt_started',checksum=$3,duration_ms=$4,byte_count=$5,wire_count=wire_count+1 WHERE user_id=$1 AND turn_id=$2 AND phase IN('loading','prepared') AND wire_count=0 AND consent_revision=$6 AND policy_version=$7 AND expires_at>clock_timestamp() RETURNING turn_id",[event.userId,ticket.turnId,audio.checksum,audio.durationMs,audio.size,current!.revision,this.profile.version]);if(rows.length!==1)throw Error('STT_ALREADY_STARTED_OR_EXPIRED');
 });}
 async commit(ticket:TurnTicket,input:Transcript,durationMs:number,usage:SttUsage|null){const fact=validateTranscript(input);await this.authority.guarded(ticket,async(tx,event)=>{
  const [job]=await tx.query<{checksum:string;duration_ms:string}>("SELECT checksum,duration_ms FROM public.media_preparations WHERE user_id=$1 AND turn_id=$2 AND phase='stt_started' FOR UPDATE",[event.userId,ticket.turnId]);if(!job||fact.audioChecksum!==job.checksum)throw Error('STT_CHECKSUM_MISMATCH');validateTranscript(fact,Number(job.duration_ms));
  await tx.query('INSERT INTO public.media_transcripts(user_id,turn_id,fact) VALUES($1,$2,$3)',[event.userId,ticket.turnId,JSON.stringify(fact)]);
  await tx.query("UPDATE public.media_preparations SET phase='transcribed',stt_duration_ms=$3,usage=$4 WHERE user_id=$1 AND turn_id=$2",[event.userId,ticket.turnId,durationMs,usage?JSON.stringify(usage):null]);
 });}
 async fail(ticket:TurnTicket,reason:string){await this.authority.guarded(ticket,(tx,event)=>tx.query("UPDATE public.media_preparations SET phase='failed',failure_code=$3 WHERE user_id=$1 AND turn_id=$2 AND phase IN('loading','prepared','stt_started')",[event.userId,ticket.turnId,/^[a-z_]{1,80}$/.test(reason)?reason:'media_failed']));}
 async released(ticket:TurnTicket){await this.authority.guarded(ticket,(tx,event)=>tx.query('UPDATE public.media_preparations SET bytes_released=true WHERE user_id=$1 AND turn_id=$2',[event.userId,ticket.turnId]));}
}
