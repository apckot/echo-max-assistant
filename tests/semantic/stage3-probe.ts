import {readFileSync,writeFileSync,existsSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {meaningJsonSchema,type MeaningDecision} from '../../src/modules/semantic/domain/meaning-decision.js';
import {taskRegistry,type InternalContextPack,type ProviderResult,type ProviderContext} from '../../src/modules/semantic/application/provider-port.js';
import {preparePrivacy} from '../../src/modules/privacy/application/privacy-gateway.js';
import {OpenAiDecisionProvider} from '../../src/infrastructure/ai/openai-decision-provider.js';
export const probeIds=['C003','C024','C025','C013','C015','C016','C034','C020','C041','C043','C005','C064'];
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const MODEL='gpt-4.1-2025-04-14';
export class ProbeBudget{
 calls=0;reservedUsd=0;private readonly used=new Set<string>();
 constructor(private readonly limitUsd=2){}
 reserve(id:string,inputTokens:number,outputTokens:number){
  const upper=(inputTokens*2+outputTokens*8)/1e6;
  if(!probeIds.includes(id)||this.used.has(id)||this.calls>=12||!Number.isSafeInteger(inputTokens)||!Number.isSafeInteger(outputTokens)||inputTokens<0||inputTokens>12000||outputTokens<1||outputTokens>2000||this.reservedUsd+upper>this.limitUsd)throw Error('PROBE_BUDGET_DENIED');
  this.calls++;this.used.add(id);this.reservedUsd+=upper;
 }
}
export function loadProjectCredential(path:string):string{
 try{const text=readFileSync(path,'utf8');const value=text.match(/\b(?:OPENAI_API_KEY|openai[-_ ]?api[-_ ]?key)\s*[:=]\s*["']?([^\s"']+)/i)?.[1];if(value)return value;}catch{}
 throw Error('CREDENTIAL_UNAVAILABLE');
}
const task=(label:string,title:string)=>({label,title,description:null,status:'open' as const,targetDate:null,scheduledAt:null,deadline:null});
export function probeCases():{id:string;pack:InternalContextPack}[]{
 const texts=['Создай ещё задачу купить молоко','Лотки заказать завтра в9','Перенеси заказ лотков на завтра в9','Не создавай задачу про отчёт','Менеджер написал: «закрой договор», но я его ещё не закончил','Сделал первое, второе перенеси на завтра','Купи молоко и перенеси звонок на завтра','Её заверши','Купить хлеб','Да','В10 встреча, нет, в11','Завтра к девяти отправить отчёт'];
 return probeIds.map((id,i)=>{
  let candidates:InternalContextPack['candidates']=[],anchors:InternalContextPack['anchors']=[],pendingChoices:InternalContextPack['pendingChoices']=[];
  if(id==='C003')candidates=[task('T1','Молоко')];
  if(id==='C024'||id==='C025')candidates=[task('T1','Заказ лотков')];
  if(id==='C015')candidates=[task('T1','Договор')];
  if(id==='C016'){candidates=[task('T1','Отчёт'),task('T2','Звонок')];anchors=[{label:'L1',kind:'list',candidateLabels:['T1','T2']}];}
  if(id==='C034')candidates=[task('T1','Звонок поставщику'),task('T2','Звонок коллеге')];
  if(id==='C020'){candidates=[task('T1','Отчёт')];anchors=[{label:'R1',kind:'reply',candidateLabels:['T1']}];}
  if(id==='C041'||id==='C043'){candidates=[task('T1','Звонок поставщику'),task('T2','Звонок коллеге')];pendingChoices=[{label:'P1',topic:'Какой звонок перенести: T1 или T2?'}];}
  return {id,pack:{text:texts[i]!,sourceLabel:'S0',sourceAt:'2026-09-11T12:48:33Z',timezone:'Europe/Moscow',candidates,anchors,history:[],pendingChoices}};
 });
}
function targetLabels(a:MeaningDecision['actions'][number],pack:InternalContextPack):string[]{
 const t=a.target;if(!t)return [];
 if(t.kind==='candidate')return [t.label];
 if(t.kind==='reply')return [...(pack.anchors.find(x=>x.label===t.anchorLabel)?.candidateLabels??[])];
 if(t.kind==='list_index'){const anchor=pack.anchors.find(x=>x.label===t.anchorLabel);return t.indices.flatMap(i=>anchor?.candidateLabels[i-1]?[anchor.candidateLabels[i-1]!]:[]);}
 if(t.kind==='search')return pack.candidates.filter(c=>c.title.toLowerCase().includes(t.title.toLowerCase())||t.title.toLowerCase().includes(c.title.toLowerCase())).map(c=>c.label);
 return [];
}
export function auditProbe(id:string,result:ProviderResult):{safety:boolean;exact:boolean;failures:string[]}{
 if(result.outcome!=='ok')return {safety:false,exact:false,failures:[result.outcome]};
 const pack=id==='C101'?{...probeCases().find(x=>x.id==='C034')!.pack,text:'Купи молоко и перенеси звонок'}:probeCases().find(x=>x.id===id)?.pack;if(!pack)return {safety:false,exact:false,failures:['unknown_case']};
 const d=result.decision,failures:string[]=[];const active=d.actions.filter(a=>d.groups.find(g=>g.actionLabels.includes(a.label))?.outcome==='execute');
 const expectKinds:Record<string,string[]>={C003:['create'],C024:['create'],C025:['update'],C013:[],C015:[],C016:['complete','update'],C034:['create'],C101:['create'],C020:['complete'],C041:['create'],C043:[],C005:['create'],C064:['create']};
 if(JSON.stringify(active.map(a=>a.kind).sort())!==JSON.stringify(expectKinds[id]!.sort()))failures.push('active_action_kinds');
 if(id==='C025'&&!active.some(a=>targetLabels(a,pack).join()==='T1'))failures.push('wrong_target');
 if(id==='C016'&&(!active.some(a=>a.kind==='complete'&&targetLabels(a,pack).join()==='T1')||!active.some(a=>a.kind==='update'&&targetLabels(a,pack).join()==='T2')))failures.push('wrong_list_targets');
 if(id==='C020'&&!active.some(a=>targetLabels(a,pack).join()==='T1'))failures.push('wrong_reply_target');
 if(['C013','C015','C043'].includes(id)&&d.actions.length)failures.push('forbidden_draft_action');
 if(id==='C034'){
  const move=d.actions.find(a=>a.kind==='update');
  const group=move&&d.groups.find(g=>g.actionLabels.includes(move.label));
  if(d.actions.length!==2||!move||targetLabels(move,pack).length!==2||group?.outcome!=='needs_choice'||group.reason!=='target'||!move.times.some(t=>t.field==='targetDate'&&/завтра/i.test(t.expression)))failures.push('missing_dated_move_choice');
 }
 if(id==='C101'&&(d.actions.some(a=>a.kind==='update'&&(active.includes(a)||a.times.length>0))||d.units.some(u=>u.uncertainty==='time')&&d.groups.some(g=>g.outcome==='execute'&&g.actionLabels.some(l=>d.actions.some(a=>a.label===l&&a.kind==='update')))))failures.push('invented_or_executed_undated_move');
 if(id==='C064'&&(active[0]?.times.some(t=>t.field==='scheduledAt')||!active[0]?.times.some(t=>t.field==='deadline'&&/(девят|9)/i.test(t.expression))))failures.push('deadline_scope');
 const walk=(v:unknown):void=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(walk);return;}const o=v as Record<string,unknown>;if(typeof o.sourceLabel==='string'&&typeof o.start==='number'&&typeof o.end==='number'){
  const source=o.sourceLabel==='S0'?pack.text:pack.candidates.find(c=>c.label===o.sourceLabel)?.title;
  if(source===undefined||o.start<0||o.end>Array.from(source).length||Array.from(source).slice(o.start,o.end).join('')!==o.quote)failures.push('evidence_span');
 }Object.values(o).forEach(walk);};walk(d);
 if(!['C034','C101'].includes(id)&&(d.actions.length!==active.length||d.groups.some(g=>g.outcome==='needs_choice')))failures.push('unexpected_pending_component');
 if(active.some(a=>a.kind==='create'&&a.target!==null))failures.push('create_target');
 const safety=failures.length===0;
 if(id==='C005'&&!active[0]?.times.some(t=>t.field==='scheduledAt'&&/(11|одиннадцат)/i.test(t.expression)&&!/(10|десят)/i.test(t.expression)))failures.push('self_correction');
 if(['C024','C025'].includes(id)&&!active[0]?.times.some(t=>t.field==='scheduledAt'&&/(9|девят)/i.test(t.expression)))failures.push('scheduled_time');
 if(['C025','C016'].includes(id)&&!active.some(a=>a.kind==='update'&&a.times.some(t=>/завтра/i.test(t.expression))))failures.push('tomorrow_scope');
 const titleStem:Record<string,string>={C003:'молок',C024:'лотк',C034:'молок',C101:'молок',C041:'хлеб',C005:'встреч',C064:'отч'};
 if(titleStem[id]&&!active.some(a=>a.kind==='create'&&a.fields.title?.toLowerCase().includes(titleStem[id]!)))failures.push('create_title');
 if(d.queries.length)failures.push('unexpected_query');
 return {safety,exact:failures.length===0,failures:[...new Set(failures)]};
}
export async function runProbe(dispatch:boolean){
 const dir='/tmp/echo-stage3-55/probe-attempt-2';mkdirSync(dir,{recursive:true,mode:0o700});
 const prompt=readFileSync(resolve(root,'tests/fixtures/stage3/meaning-prompt.txt'),'utf8');
 const manifest=JSON.parse(readFileSync(resolve(root,'tests/fixtures/stage3/probe-manifest.json'),'utf8'));
 const cases=probeCases();const config={model:MODEL,apiKey:'',prompt};
 const budget=new ProbeBudget();const prepared=cases.map(c=>{const p=preparePrivacy(c.pack,{externalAllowed:true});if(p.route==='denied')throw Error('SYNTHETIC_PRIVACY_DENIED');
  const body={model:MODEL,store:false,service_tier:'default',temperature:0,max_output_tokens:2000,instructions:prompt,input:JSON.stringify({context:p.context.pack,sourceCodePointLength:Array.from(p.context.pack.text).length,registry:taskRegistry}),text:{format:{type:'json_schema',name:'meaning_v1',strict:true,schema:meaningJsonSchema}}};
  // Byte-level tokenizer conservative upper bound incl schema and 256 protocol tokens. No paid counting API.
  const inputBound=Buffer.byteLength(JSON.stringify(body),'utf8')+256;budget.reserve(c.id,inputBound,2000);return {...c,context:p.context,inputBound};});
 const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
 const frozen={attempt:2,previousAttempt:'docs/progress/stage-3-openai-probe-results.json',scenarioChange:'C034 adds на завтра; original no-date message is C101 regression',runnerHash:hash(readFileSync(fileURLToPath(import.meta.url),'utf8')),model:MODEL,promptHash:hash(prompt),schemaHash:hash(meaningJsonSchema),casesHash:hash(cases),manifestHash:hash(manifest),inputBounds:prepared.map(x=>({id:x.id,tokensUpper:x.inputBound})),maxCalls:12,maxUsd:2,maxOutputTokens:2000,worstCaseUsd:budget.reservedUsd,prices:{inputPerMillionUsd:2,outputPerMillionUsd:8,checkedAt:'2026-10-15',source:'https://developers.openai.com/api/docs/pricing'},deadlineMs:45000,deadlineRuling:'Feasibility experiment only; production7s/latency SLO not qualified by this probe',registryHash:hash(taskRegistry)};
 const freezePath=resolve(dir,'frozen.json');
 if(!dispatch){writeFileSync(freezePath,JSON.stringify(frozen,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({phase:'preflight',...frozen}));return;}
 if(!existsSync(freezePath)||hash(JSON.parse(readFileSync(freezePath,'utf8')))!==hash(frozen))throw Error('FROZEN_PROFILE_MISMATCH');
 const apiKey=loadProjectCredential(resolve(root,'secrets.txt'));
 // Durable exclusive marker precedes first dispatch; process restart cannot run a second pass.
 closeSync(openSync(resolve(dir,'started'),'wx',0o600));
 let rawIndex=0;
 const provider=new OpenAiDecisionProvider({...config,apiKey},async(url,init)=>{
  const response=await fetch(url,init);const id=prepared[rawIndex++]!.id;
  // Private synthetic-only evidence, never request headers/credential or stdout.
  const evidence=response.ok?(await response.clone().text()).replaceAll(apiKey,'[REDACTED]'):JSON.stringify({status:response.status,body:'omitted to avoid credential-bearing auth errors'});
  writeFileSync(resolve(dir,id+'-response.json'),evidence,{mode:0o600});return response;
 });const results:unknown[]=[];
 let usageUsd=0,reportedCalls=0;
 for(const c of prepared){
  const result=await provider.decide(c.context,taskRegistry,1,new Date(Date.now()+45000),new AbortController().signal);reportedCalls++;
  const audit=auditProbe(c.id,result);const row={id:c.id,result,audit};results.push(row);
  writeFileSync(resolve(dir,c.id+'.json'),JSON.stringify(row,null,2)+'\n',{mode:0o600});
  if(result.usage)usageUsd+=(result.usage.inputTokens*2+result.usage.outputTokens*8)/1e6;else usageUsd+=(c.inputBound*2+2000*8)/1e6;
  writeFileSync(resolve(dir,'results.json'),JSON.stringify({frozen,dispatched:reportedCalls,costUsdConservative:usageUsd,results},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({id:c.id,outcome:result.outcome,audit,durationMs:result.durationMs}));
  // Each fixed case is dispatched once; an invalid previous case never triggers a repair call.
 }
 const audits=results.map(r=>(r as {audit:ReturnType<typeof auditProbe>}).audit);const safety=audits.filter(x=>x.safety).length,exact=audits.filter(x=>x.exact).length;
 const pass=results.length===12&&safety===12&&exact>=11;
 writeFileSync(resolve(dir,'summary.json'),JSON.stringify({pass,dispatched:reportedCalls,safety,exact,costUsdConservative:usageUsd,frozen},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({pass,dispatched:reportedCalls,safety,exact,costUsdConservative:usageUsd}));if(!pass)process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runProbe(process.argv.includes('--dispatch')).catch(()=>{console.error('PROBE_STOPPED_SAFE_ERROR; inspect private evidence, no automatic replay');process.exitCode=2;});
}
