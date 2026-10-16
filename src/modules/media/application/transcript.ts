import {audioRoute,type AudioConsent,type AudioProfile} from './audio-policy.js';
import {releaseAudio,type ApprovedAudio,type MediaService} from './media-service.js';
import {validateTranscript,type Transcript,type SpeechToTextProvider,type SttUsage} from './stt-port.js';
import type {TurnTicket} from '../../agent/application/turn-port.js';
import {withDeadline} from '../../../shared/time/deadline.js';
export type PreparedSource={readonly kind:'text';readonly text:string;readonly audioChecksum?:string;readonly criticalUncertainty:Transcript['criticalUncertainty']}|{readonly kind:'denied';readonly reason:string};
export interface TurnSourcePreparation {prepare(ticket:TurnTicket,signal?:AbortSignal):Promise<PreparedSource>}
export interface MediaJobsPort {
 readonly profile:AudioProfile;consent(ticket:TurnTicket):Promise<AudioConsent|null>;
 read(ticket:TurnTicket):Promise<{phase:string;checksum:string|null;fact:Transcript|null;consent_revision:number;policy_version:number}|null>;
 begin(ticket:TurnTicket,consent:AudioConsent):Promise<void>;start(ticket:TurnTicket,audio:ApprovedAudio):Promise<void>;
 commit(ticket:TurnTicket,fact:Transcript,durationMs:number,usage:SttUsage|null):Promise<void>;
 fail(ticket:TurnTicket,reason:string):Promise<unknown>;released(ticket:TurnTicket):Promise<unknown>;
}
/** Two active media/STT slots, two bounded waiters; no additional provider invocation for recovery. */
export class VoicePreparation implements TurnSourcePreparation {
 private active=0;private readonly waiting:(()=>void)[]=[];
 constructor(private readonly jobs:MediaJobsPort,private readonly media:MediaService,private readonly stt:SpeechToTextProvider){}
 private asSource(input:Transcript):PreparedSource{const fact=validateTranscript(input);return {kind:'text',text:fact.text,audioChecksum:fact.audioChecksum,criticalUncertainty:fact.criticalUncertainty};}
 async prepare(ticket:TurnTicket,signal:AbortSignal=new AbortController().signal):Promise<PreparedSource>{
  if(signal.aborted)return {kind:'denied',reason:'processing_cancelled'};
  if(this.active>=2){if(this.waiting.length>=2)return {kind:'denied',reason:'media_busy'};await new Promise<void>(resolve=>this.waiting.push(resolve));}else this.active++;
  let audio:ApprovedAudio|undefined;
  try{
   const current=await this.jobs.read(ticket);if(current?.fact){await this.jobs.released(ticket);return this.asSource(current.fact);}
   if(current?.phase==='stt_started'||current?.phase==='failed'){await this.jobs.fail(ticket,'stt_uncertain');return {kind:'denied',reason:'stt_uncertain'};}
   const consent=await this.jobs.consent(ticket);if(!audioRoute(consent,this.jobs.profile).allowed)return {kind:'denied',reason:'audio_denied'};
   await this.jobs.begin(ticket,consent!);if(ticket.event.payload.kind!=='voice')return {kind:'denied',reason:'media_source'};
   audio=await this.media.prepare(ticket.event.payload.media,consent,this.jobs.profile,()=>this.jobs.consent(ticket),signal);
   await this.jobs.start(ticket,audio);const deadlineMs=audio.durationMs<=60000?18000:90000;
   const result=await withDeadline(deadlineMs,signal=>this.stt.transcribe(audio!,new Date(Date.now()+deadlineMs),signal),signal);
   if(result.outcome!=='ok'){await this.jobs.fail(ticket,'stt_'+result.outcome);return {kind:'denied',reason:'stt_'+result.outcome};}
   try{await this.jobs.commit(ticket,result.transcript,result.durationMs,result.usage);}catch(error){const saved=await this.jobs.read(ticket);if(saved?.fact)return this.asSource(saved.fact);throw error;}
   return this.asSource(result.transcript);
  }catch{await this.jobs.fail(ticket,'media_failed');return {kind:'denied',reason:'media_failed'};}
  finally{if(audio)releaseAudio(audio);try{await this.jobs.released(ticket);}finally{const next=this.waiting.shift();if(next)next();else this.active--;}}
 }
}
