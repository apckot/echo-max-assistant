import {parseMeaningDraft,meaningDraftJsonSchema} from '../../modules/semantic/domain/meaning-decision.js';
import type {AiDecisionProvider,ProviderContext,ProviderResult,ProviderUsage,InvalidReason,ToolRegistryV1} from '../../modules/semantic/application/provider-port.js';
import {isApprovedContext} from '../../modules/privacy/application/privacy-gateway.js';
import {OPENAI_RESPONSES_URL,type OpenAiConfig} from './provider-config.js';
export type HttpTransport=(url:string,init:RequestInit)=>Promise<Response>;
export class OpenAiDecisionProvider implements AiDecisionProvider{
 constructor(private readonly config:OpenAiConfig,private readonly http:HttpTransport=fetch){}
 async decide(context:ProviderContext,registry:ToolRegistryV1,schemaVersion:2,deadline:Date,signal:AbortSignal):Promise<ProviderResult>{
  const started=performance.now(),duration=()=>performance.now()-started;
  const failure=(outcome:'denied'|'timeout'|'uncertain'|'http_error'|'refusal',status?:number):ProviderResult=>({outcome,durationMs:duration(),...(status===undefined?{}:{status})});
  if(!isApprovedContext(context)||schemaVersion!==2)return failure('denied');
  const remaining=deadline.getTime()-Date.now();if(remaining<=0||signal.aborted)return failure('timeout');
  const cancellation=AbortSignal.any([signal,AbortSignal.timeout(Math.min(Math.ceil(remaining),300000))]);
  const requestBody=JSON.stringify({model:this.config.model,store:false,service_tier:'default',temperature:0,max_output_tokens:this.config.maxOutputTokens??2000,instructions:this.config.prompt,input:JSON.stringify({context:context.pack,registry}),text:{format:{type:'json_schema',name:'meaning_draft_v2',strict:true,schema:meaningDraftJsonSchema}}});
  if(Buffer.byteLength(requestBody,'utf8')>24000)return failure('denied');
  let raw:string;
  // Only transport/stream failures are uncertain; a fully received invalid answer is not a transport error.
  try{
   const response=await this.http(OPENAI_RESPONSES_URL,{method:'POST',redirect:'error',signal:cancellation,headers:{Authorization:`Bearer ${this.config.apiKey}`,'Content-Type':'application/json'},body:requestBody});
   if(!response.ok){await response.body?.cancel();return failure('http_error',response.status);}
   raw=await response.text();
  }catch{return failure(cancellation.aborted?'timeout':'uncertain');}
  let usage:ProviderUsage|null=null,model:string|undefined;
  const invalid=(reason:InvalidReason):ProviderResult=>({outcome:'invalid',reason,usage,durationMs:duration(),...(model?{model}:{})});
  if(raw.length>500000)return invalid('response_size');
  let body:unknown;try{body=JSON.parse(raw);}catch{return invalid('response_json');}
  if(!body||typeof body!=='object'||Array.isArray(body))return invalid('response_shape');
  const b=body as Record<string,unknown>,u=b.usage as Record<string,unknown>|undefined;
  if(u&&Number.isSafeInteger(u.input_tokens)&&Number.isSafeInteger(u.output_tokens)&&Number(u.input_tokens)>=0&&Number(u.output_tokens)>=0)usage={inputTokens:Number(u.input_tokens),outputTokens:Number(u.output_tokens)};
  if(typeof b.model==='string')model=b.model;
  if(b.status!=='completed')return invalid('incomplete');
  if(!Array.isArray(b.output))return invalid('response_shape');
  const texts:string[]=[];let refusal=false;
  for(const message of b.output){
   if(!message||typeof message!=='object')return invalid('response_shape');
   if(message.type!=='message')continue;
   if(!Array.isArray(message.content))return invalid('response_shape');
   for(const part of message.content){
    if(!part||typeof part!=='object')return invalid('response_shape');
    if(part.type==='refusal')refusal=true;
    if(part.type==='output_text'){if(typeof part.text!=='string')return invalid('response_shape');texts.push(part.text);}
   }
  }
  if(refusal)return {outcome:'refusal',usage,durationMs:duration()};
  if(texts.length!==1)return invalid('missing_output');
  let decision:unknown;try{decision=JSON.parse(texts[0]!);}catch{return invalid('decision_json');}
  try{return {outcome:'ok',decision:parseMeaningDraft(decision),model:model??this.config.model,durationMs:duration(),usage};}
  catch(error){return invalid(error instanceof Error&&error.message.startsWith('MEANING_')?'meaning_references':'meaning_schema');}
 }
}
