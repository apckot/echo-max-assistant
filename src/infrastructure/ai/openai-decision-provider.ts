import {parseMeaning,meaningJsonSchema} from '../../modules/semantic/domain/meaning-decision.js';
import type {AiDecisionProvider,ProviderContext,ProviderResult,ToolRegistryV1} from '../../modules/semantic/application/provider-port.js';
import {isApprovedContext} from '../../modules/privacy/application/privacy-gateway.js';
import {OPENAI_RESPONSES_URL,type OpenAiConfig} from './provider-config.js';
export type HttpTransport=(url:string,init:RequestInit)=>Promise<Response>;
export class OpenAiDecisionProvider implements AiDecisionProvider{
 constructor(private readonly config:OpenAiConfig,private readonly http:HttpTransport=fetch){}
 async decide(context:ProviderContext,registry:ToolRegistryV1,schemaVersion:1,deadline:Date,signal:AbortSignal):Promise<ProviderResult>{
  const started=performance.now();const failure=(outcome:Exclude<ProviderResult['outcome'],'ok'>,status?:number):ProviderResult=>({outcome,durationMs:performance.now()-started,...(status===undefined?{}:{status})});
  if(!isApprovedContext(context)||schemaVersion!==1)return failure('denied');
  const remaining=deadline.getTime()-Date.now();if(remaining<=0||signal.aborted)return failure('timeout');
  const cancellation=AbortSignal.any([signal,AbortSignal.timeout(Math.min(Math.ceil(remaining),300000))]);
  try{
   const response=await this.http(OPENAI_RESPONSES_URL,{method:'POST',redirect:'error',signal:cancellation,headers:{Authorization:`Bearer ${this.config.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.config.model,store:false,service_tier:'default',temperature:0,max_output_tokens:this.config.maxOutputTokens??2000,instructions:this.config.prompt,input:JSON.stringify({context:context.pack,sourceCodePointLength:Array.from(context.pack.text).length,registry}),text:{format:{type:'json_schema',name:'meaning_v1',strict:true,schema:meaningJsonSchema}}})});
   if(!response.ok){await response.body?.cancel();return failure('http_error',response.status);}
   const raw=await response.text();if(raw.length>500000)return failure('invalid');
   const body=JSON.parse(raw) as {status?:string;model?:string;output?:{type:string;content?:{type:string;text?:string}[]}[];usage?:{input_tokens:number;output_tokens:number}};
   if(body.status!=='completed')return failure('invalid');
   const parts=(body.output??[]).filter(x=>x.type==='message').flatMap(x=>x.content??[]);
   if(parts.some(x=>x.type==='refusal'))return failure('refusal');
   const text=parts.filter(x=>x.type==='output_text').map(x=>x.text??'').join('');
   const decision=parseMeaning(JSON.parse(text));
   return {outcome:'ok',decision,model:body.model??this.config.model,durationMs:performance.now()-started,usage:body.usage&&Number.isSafeInteger(body.usage.input_tokens)&&Number.isSafeInteger(body.usage.output_tokens)&&body.usage.input_tokens>=0&&body.usage.output_tokens>=0?{inputTokens:body.usage.input_tokens,outputTokens:body.usage.output_tokens}:null};
  }catch{return failure(cancellation.aborted?'timeout':'uncertain');}
 }
}
