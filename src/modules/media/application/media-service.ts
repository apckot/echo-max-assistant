import type {AudioConsent,AudioProfile} from './audio-policy.js';
import {audioRoute} from './audio-policy.js';
import {withDeadline} from '../../../shared/time/deadline.js';
export interface AudioSource {readonly url:string;readonly token:string}
export interface AudioLoader {load(source:AudioSource,limitBytes:number,signal:AbortSignal):Promise<Uint8Array>}
export interface InspectedAudio {readonly bytes:Uint8Array;readonly format:'flac';readonly contentType:'audio/flac';readonly durationMs:number}
export interface AudioCodec {inspect(bytes:Uint8Array,signal:AbortSignal):Promise<InspectedAudio>}
export interface ApprovedAudio {readonly kind:'approved_audio_v1';readonly format:'flac';readonly contentType:'audio/flac';readonly durationMs:number;readonly size:number;readonly checksum:string;readonly consentRevision:number;readonly policyVersion:number;readonly expiresAt:number}
const approved=new WeakMap<object,Uint8Array>();
export function isApprovedAudio(input:unknown):input is ApprovedAudio {return !!input&&typeof input==='object'&&approved.has(input)&&'expiresAt' in input&&typeof input.expiresAt==='number'&&Date.now()<input.expiresAt;}
export function readApprovedAudio(input:ApprovedAudio):Uint8Array {if(!isApprovedAudio(input)){releaseAudio(input);throw Error('AUDIO_NOT_APPROVED');}return Uint8Array.from(approved.get(input)!);}
export function releaseAudio(input:object){approved.get(input)?.fill(0);approved.delete(input);}
/** Only ephemeral buffers. Decoder tmpfs is private to its process; audio never enters PostgreSQL/backups. */
export class MediaService {
 constructor(private readonly loader:AudioLoader,private readonly codec:AudioCodec){}
 async prepare(source:AudioSource,consent:AudioConsent|null,profile:AudioProfile,refresh:()=>Promise<AudioConsent|null>,signal:AbortSignal):Promise<ApprovedAudio>{
  if(!audioRoute(consent,profile).allowed)throw Error('AUDIO_DENIED');
  let raw:Uint8Array|undefined,decoded:InspectedAudio|undefined;
  try{
   raw=await withDeadline(10000,s=>this.loader.load(source,25000000,AbortSignal.any([s,signal])));
   if(!raw.length||raw.length>25000000)throw Error('MEDIA_SIZE');
   decoded=await withDeadline(5000,s=>this.codec.inspect(raw!,AbortSignal.any([s,signal])));
   if(!decoded.bytes.length||decoded.bytes.length>25000000||!Number.isFinite(decoded.durationMs)||decoded.durationMs<=0||decoded.durationMs>1200000||decoded.format!=='flac'||decoded.contentType!=='audio/flac')throw Error('MEDIA_CODEC');
   const current=await refresh();if(signal.aborted||!audioRoute(current,profile).allowed||current!.revision!==consent!.revision)throw Error('AUDIO_DENIED');
   const copy=Uint8Array.from(decoded.bytes),hash=await crypto.subtle.digest('SHA-256',copy.buffer);
   const capability:ApprovedAudio=Object.freeze({kind:'approved_audio_v1',format:'flac',contentType:'audio/flac',durationMs:decoded.durationMs,size:copy.length,checksum:Array.from(new Uint8Array(hash)).map(n=>n.toString(16).padStart(2,'0')).join(''),consentRevision:current!.revision,policyVersion:profile.version,expiresAt:Date.now()+30*60000});
   approved.set(capability,copy);const timer=setTimeout(()=>releaseAudio(capability),30*60000);timer.unref?.();return capability;
  }finally{raw?.fill(0);decoded?.bytes.fill(0);}
 }
}
