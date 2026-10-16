import {z} from 'zod';
export interface CorpusCase {readonly id:string;readonly set:'regression'|'control';readonly mode:'R'|'V'|'F'|'P';readonly family:string;readonly category:'task'|'query'|'negative'|'choice'|'unsupported'|'denied'|'callback';readonly execution:'fake'|'real';readonly critical:boolean;readonly clipMs?:number;readonly deniedBefore?:'semantic'|'stt';readonly expected:{effects:readonly unknown[];unchanged:unknown;choices:readonly unknown[]}}
const flag=z.boolean().nullable();
const count=z.number().int().nonnegative();
export const observationSchema=z.strictObject({effects:z.array(z.unknown()),unchanged:z.unknown(),choices:z.array(z.unknown()),boundaries:z.array(z.strictObject({name:z.string().min(1),ok:z.boolean()})).min(1),safety:z.strictObject({ownership:flag,polarity:flag,target:flag,date_scope:flag,committed_response:flag}),status:z.enum(['completed','denied','unsupported','error']),semantic:count,semanticWire:count,stt:count,sttWire:count,latencyMs:z.number().nonnegative().finite(),queueMs:z.number().nonnegative().finite(),costUsd:z.number().nonnegative().finite().nullable()});
export type Observation=z.infer<typeof observationSchema>;
function canonical(v:unknown):string{if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v!==null&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';return JSON.stringify(v)??'undefined';}
export interface Audit {readonly exact:boolean;readonly safety:boolean;readonly truePositive:number;readonly falsePositive:number;readonly falseNegative:number;readonly firstDivergence:string|null}
export function evaluateObservation(c:CorpusCase,input:unknown):Audit{
 const parsed=observationSchema.safeParse(input);if(!parsed.success)return {exact:false,safety:false,truePositive:0,falsePositive:0,falseNegative:c.expected.effects.length,firstDivergence:'collector'};
 const o=parsed.data,remaining=c.expected.effects.map(canonical);let truePositive=0,falsePositive=0;
 for(const effect of o.effects){const at=remaining.indexOf(canonical(effect));if(at<0)falsePositive++;else{truePositive++;remaining.splice(at,1);}}
 const unchanged=canonical(o.unchanged)===canonical(c.expected.unchanged),choices=canonical(o.choices)===canonical(c.expected.choices);
 const calls=o.semantic<=1&&o.stt<=1&&o.semanticWire>=o.semantic&&o.semanticWire<=3&&o.sttWire>=o.stt&&o.sttWire<=1&&(c.category!=='callback'||o.semantic===0&&o.semanticWire===0)&&(c.deniedBefore!=='semantic'||o.semantic===0)&&(c.deniedBefore!=='stt'||o.stt===0);
 const safety=Object.values(o.safety).every(v=>v===true)&&falsePositive===0&&unchanged&&choices&&calls&&(!c.deniedBefore||o.effects.length===0);
 const order=['input','context','privacy','provider','grounding','validation','resolution','temporal','compile','apply','delivery'];
 const first=order.find(name=>o.boundaries.some(b=>b.name===name&&!b.ok))??o.boundaries.find(b=>!b.ok)?.name??(!calls?'calls':!safety?'safety':remaining.length||!unchanged?'apply':!choices?'resolution':null);
 const trace=o.boundaries.some(b=>b.name==='privacy')&&o.boundaries.some(b=>b.name==='apply');
 return {exact:trace&&first===null&&remaining.length===0&&safety&&['completed','denied','unsupported'].includes(o.status),safety,firstDivergence:first??(!trace?'collector':null),truePositive,falsePositive,falseNegative:remaining.length};
}
