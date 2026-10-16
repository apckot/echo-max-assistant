import {z} from 'zod';
import type {ApprovedAudio} from './media-service.js';
const text=z.string().min(1).refine(v=>v.trim().length>0).refine(v=>[...v].length<=32000&&!/[\uD800-\uDFFF]/u.test([...v].filter(c=>c.length===1).join('')));
const probability=z.number().min(0).max(1).nullable();
export const transcriptSchema=z.strictObject({version:z.literal(1),text,language:z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)?$/).nullable(),confidence:probability,
 segments:z.array(z.strictObject({startMs:z.number().min(0),endMs:z.number().min(0),text:z.string(),confidence:probability})).max(1000),
 criticalUncertainty:z.array(z.strictObject({start:z.number().int().min(0),end:z.number().int().min(1),reason:z.enum(['negation','date','target','action','unknown'])})).max(100).nullable(),
 audioChecksum:z.string().regex(/^[a-f0-9]{64}$/),provider:z.string().regex(/^[a-z0-9_-]{1,40}$/),model:z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),profileVersion:z.number().int().min(1)});
export type Transcript=Readonly<z.infer<typeof transcriptSchema>>;
export function validateTranscript(input:unknown,durationMs?:number):Transcript{const t=transcriptSchema.parse(input),length=[...t.text].length;if(t.segments.some(s=>s.endMs<=s.startMs||durationMs!==undefined&&s.endMs>durationMs)||t.criticalUncertainty?.some(s=>s.end<=s.start||s.end>length))throw Error('TRANSCRIPT_RANGE');return t;}
export interface SttUsage {readonly inputTokens:number;readonly outputTokens:number}
export type TranscriptResult={readonly outcome:'ok';readonly transcript:Transcript;readonly durationMs:number;readonly usage:SttUsage|null}|{readonly outcome:'denied'|'timeout'|'uncertain'|'http_error'|'invalid';readonly durationMs:number;readonly usage:SttUsage|null;readonly reason?:string};
export interface SpeechToTextProvider {transcribe(audio:ApprovedAudio,deadline:Date,signal:AbortSignal):Promise<TranscriptResult>}
