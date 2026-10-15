import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {meaningDraftJsonSchema} from '../../src/modules/semantic/domain/meaning-decision.js';
import {taskRegistry} from '../../src/modules/semantic/application/provider-port.js';
import {preparePrivacy} from '../../src/modules/privacy/application/privacy-gateway.js';
import {groundMeaningDraft} from '../../src/modules/semantic/application/quote-grounding.js';
import {OpenAiDecisionProvider} from '../../src/infrastructure/ai/openai-decision-provider.js';
import {probeIds,probeCases,ProbeBudget,loadProjectCredential,auditGroundedProbe} from './stage3-probe.js';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const dir='/tmp/echo-stage3-55/probe-attempt-3';
const model='gpt-4.1-2025-04-14';
const manifestPath='tests/fixtures/stage3/probe-attempt-3-manifest.json';
const promptPath='tests/fixtures/stage3/meaning-prompt.txt';
const dependencies=[
 'tests/semantic/probe-attempt-3.ts','tests/semantic/stage3-probe.ts','tests/semantic/temporal-oracle.ts',
 'src/modules/semantic/domain/meaning-decision.ts','src/modules/semantic/application/provider-port.ts',
 'src/modules/semantic/application/quote-grounding.ts','src/modules/semantic/application/temporal-intent.ts',
 'src/modules/privacy/application/privacy-gateway.ts','src/modules/privacy/application/source-map.ts',
 'src/infrastructure/ai/openai-decision-provider.ts','src/infrastructure/ai/provider-config.ts',
];
const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const read=(path:string)=>readFileSync(resolve(root,path),'utf8');
function inputs(){
 const prompt=read(promptPath);
 return probeCases().map(c=>{const privacy=preparePrivacy(c.pack,{externalAllowed:true});if(privacy.route==='denied')throw Error('ATTEMPT3_PRIVACY_DENIED');
 const body={model,store:false,service_tier:'default',temperature:0,max_output_tokens:2000,instructions:prompt,input:JSON.stringify({context:privacy.context.pack,registry:taskRegistry}),text:{format:{type:'json_schema',name:'meaning_draft_v2',strict:true,schema:meaningDraftJsonSchema}}};
 return {...c,privacy,inputBound:Buffer.byteLength(JSON.stringify(body),'utf8')+256};});
}
export function prepareAttempt3(){
 const manifest=JSON.parse(read(manifestPath));
 if(manifest.attempt!==3||manifest.model!==model||manifest.maxCalls!==12||manifest.maxUsd!==2||manifest.maxInputTokens!==12000||manifest.maxOutputTokens!==2000||JSON.stringify(manifest.caseIds)!==JSON.stringify(probeIds))throw Error('ATTEMPT3_MANIFEST_INVALID');
 const prepared=inputs(),budget=new ProbeBudget();prepared.forEach(c=>budget.reserve(c.id,c.inputBound,2000));
 return {attempt:3,model,caseIds:probeIds,maxCalls:12,maxUsd:2,maxInputTokens:12000,maxOutputTokens:2000,deadlineMs:45000,
 gate:{safety:12,exactMinimum:11},promptHash:hash(read(promptPath)),schemaHash:hash(meaningDraftJsonSchema),runnerHash:hash(read(dependencies[0]!)),oracleHash:hash(read('tests/semantic/temporal-oracle.ts')),sourceHashes:Object.fromEntries(dependencies.map(p=>[p,hash(read(p))])),
 manifestHash:hash(read(manifestPath)),casesHash:hash(probeCases()),registryHash:hash(taskRegistry),
 inputBounds:prepared.map(c=>({id:c.id,tokensUpper:c.inputBound})),worstCaseUsd:budget.reservedUsd,
 prices:{inputPerMillionUsd:2,outputPerMillionUsd:8,checkedAt:'2026-10-15',source:'https://developers.openai.com/api/docs/pricing'},
 note:'Quote-only wire grounded exactly through SourceMap before unchanged semantic/field/scope/target/independence checks; no repairs; no production latency claim'};
}
export function verifyAttempt3(saved:unknown,current:unknown){if(hash(saved)!==hash(current))throw Error('ATTEMPT3_FREEZE_MISMATCH');}
export function claimAttempt3(marker:string,frozenHash:string){const fd=openSync(marker,'wx',0o600);try{writeFileSync(fd,JSON.stringify({attempt:3,frozenHash,startedAt:new Date().toISOString()})+'\n');}finally{closeSync(fd);}}
async function main(dispatch:boolean){
 const frozen=prepareAttempt3();
 if(!dispatch){
  if(existsSync(dir))throw Error('ATTEMPT3_DIRECTORY_EXISTS_NO_OVERWRITE');
  mkdirSync(dir,{mode:0o700});
  for(const [name,value] of [['frozen.json',frozen],['manifest.json',JSON.parse(read(manifestPath))],['schema.json',meaningDraftJsonSchema],['cases.json',probeCases()]] as const)writeFileSync(resolve(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  writeFileSync(resolve(dir,'prompt.txt'),read(promptPath),{flag:'wx',mode:0o600});
  writeFileSync(resolve(dir,'runner.ts'),read(dependencies[0]!),{flag:'wx',mode:0o600});
  writeFileSync(resolve(dir,'oracle-sources.json'),JSON.stringify(Object.fromEntries(dependencies.slice(1).map(p=>[p,read(p)])),null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({phase:'frozen',...frozen}));return;
 }
 const saved=JSON.parse(readFileSync(resolve(dir,'frozen.json'),'utf8'));verifyAttempt3(saved,frozen);
 const apiKey=loadProjectCredential(resolve(root,'secrets.txt'));
 claimAttempt3(resolve(dir,'started'),hash(frozen));
 let currentId='',calls=0,cost=0;const rows:unknown[]=[];
 const provider=new OpenAiDecisionProvider({model,apiKey,prompt:read(promptPath),maxOutputTokens:2000},async(url,init)=>{
  if(calls>=12||!probeIds.includes(currentId))throw Error('ATTEMPT3_WIRE_LIMIT');
  writeFileSync(resolve(dir,currentId+'-dispatch.json'),JSON.stringify({attempt:3,id:currentId,ordinal:calls+1})+'\n',{flag:'wx',mode:0o600});calls++;
  const response=await fetch(url,init);
  const evidence=response.ok?(await response.clone().text()).replaceAll(apiKey,'[REDACTED]'):JSON.stringify({status:response.status,body:'omitted to avoid auth credential echo'});
  writeFileSync(resolve(dir,currentId+'-response.json'),evidence,{flag:'wx',mode:0o600});return response;
 });
 for(const c of inputs()){
  currentId=c.id;
  if(cost+(c.inputBound*2+2000*8)/1e6>2)throw Error('ATTEMPT3_COST_LIMIT');
  const result=await provider.decide(c.privacy.context,taskRegistry,2,new Date(Date.now()+45000),new AbortController().signal);
  let groundedDecision:unknown=null,groundingError:string|null=null,audit={safety:false,exact:false,failures:[result.outcome as string]};
  if(result.outcome==='ok')try{const g=groundMeaningDraft(result.decision,c.privacy.sourceMap);groundedDecision=g.decision;audit=auditGroundedProbe(c.id,g);}catch(e){groundingError=e instanceof Error&&/^(EVIDENCE_[A-Z_]+|UNKNOWN_PRIVACY_TOKEN)$/.test(e.message)?e.message:'GROUNDING_INVALID';audit={safety:false,exact:false,failures:[groundingError]};}
  cost+=result.usage?(result.usage.inputTokens*2+result.usage.outputTokens*8)/1e6:(c.inputBound*2+2000*8)/1e6;
  const row={id:c.id,result,groundedDecision,groundingError,audit};rows.push(row);
  writeFileSync(resolve(dir,c.id+'.json'),JSON.stringify(row,null,2)+'\n',{flag:'wx',mode:0o600});
  writeFileSync(resolve(dir,'results.json'),JSON.stringify({frozen,dispatched:calls,costUsdConservative:cost,results:rows},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({id:c.id,outcome:result.outcome,audit,durationMs:result.durationMs}));
 }
 const audits=rows.map(r=>(r as {audit:{safety:boolean;exact:boolean}}).audit),safety=audits.filter(a=>a.safety).length,exact=audits.filter(a=>a.exact).length;
 const summary={pass:calls===12&&rows.length===12&&safety===12&&exact>=11,attempt:3,dispatched:calls,safety,exact,costUsdConservative:cost,frozen};
 writeFileSync(resolve(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(summary));if(!summary.pass)process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv.includes('--attempt=3')){console.error('ONLY_ATTEMPT3_AUTHORIZED');process.exitCode=2;}
 else main(process.argv.includes('--dispatch')).catch(()=>{console.error('ATTEMPT3_STOPPED_SAFE_ERROR_NO_REPLAY');process.exitCode=2;});
}
