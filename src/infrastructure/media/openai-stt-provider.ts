import type {ApprovedAudio} from '../../modules/media/application/media-service.js';
import {isApprovedAudio,readApprovedAudio} from '../../modules/media/application/media-service.js';
import {validateTranscript,type SpeechToTextProvider,type TranscriptResult,type SttUsage} from '../../modules/media/application/stt-port.js';
import type {HttpTransport} from '../ai/openai-decision-provider.js';
export const OPENAI_STT_MODEL='gpt-4o-mini-transcribe-2025-12-15';
export class OpenAiSttProvider implements SpeechToTextProvider {
 constructor(private readonly config:{readonly apiKey:string},private readonly http:HttpTransport=fetch){}
 async transcribe(audio:ApprovedAudio,deadline:Date,signal:AbortSignal):Promise<TranscriptResult>{
  const started=performance.now(),duration=()=>performance.now()-started;let usage:SttUsage|null=null;
  const failure=(outcome:'denied'|'timeout'|'uncertain'|'http_error'|'invalid',reason?:string):TranscriptResult=>({outcome,durationMs:duration(),usage,...(reason?{reason}:{})});
  if(!isApprovedAudio(audio))return failure('denied');const remaining=deadline.getTime()-Date.now();if(remaining<=0||signal.aborted)return failure('timeout');
  const cancellation=AbortSignal.any([signal,AbortSignal.timeout(Math.min(Math.ceil(remaining),90000))]);
  const bytes=readApprovedAudio(audio),form=new FormData();form.set('model',OPENAI_STT_MODEL);form.set('response_format','json');form.set('file',new Blob([Uint8Array.from(bytes).buffer],{type:audio.contentType}),'recording.flac');bytes.fill(0);
  let raw='',received:Uint8Array|undefined;
  try{
   const response=await this.http('https://api.openai.com/v1/audio/transcriptions',{method:'POST',redirect:'error',signal:cancellation,headers:{Authorization:`Bearer ${this.config.apiKey}`},body:form});
   if(!response.ok){await response.body?.cancel();return failure('http_error','http_status');}
   const reader=response.body?.getReader();if(!reader)return failure('invalid','missing_body');const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>262144){await reader.cancel();return failure('invalid','response_size');}chunks.push(part.value);}const all=new Uint8Array(size);let offset=0;for(const part of chunks){all.set(part,offset);offset+=part.length;}received=all;}finally{reader.releaseLock();}
  }catch{return failure(cancellation.aborted?'timeout':'uncertain');}
  try{raw=new TextDecoder('utf-8',{fatal:true}).decode(received);}catch{return failure('invalid','response_encoding');}
  let body:unknown;try{body=JSON.parse(raw);}catch{return failure('invalid','response_json');}
  if(!body||typeof body!=='object'||Array.isArray(body))return failure('invalid','response_shape');const b=body as Record<string,unknown>,u=b.usage as Record<string,unknown>|undefined;
  if(u&&Number.isSafeInteger(u.input_tokens)&&Number.isSafeInteger(u.output_tokens)&&Number(u.input_tokens)>=0&&Number(u.output_tokens)>=0)usage={inputTokens:Number(u.input_tokens),outputTokens:Number(u.output_tokens)};
  try{
   const transcript=validateTranscript({version:1,text:b.text,language:typeof b.language==='string'?b.language:null,confidence:null,segments:[],criticalUncertainty:null,audioChecksum:audio.checksum,provider:'openai',model:OPENAI_STT_MODEL,profileVersion:1},audio.durationMs);
   return {outcome:'ok',transcript,durationMs:duration(),usage};
  }catch{return failure('invalid','transcript_shape');}
 }
}
