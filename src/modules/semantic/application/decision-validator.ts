import {parseMeaning,type MeaningDecision,type ActionDraft,type SpanRef} from '../domain/meaning-decision.js';
import type {GroundedMeaning} from './quote-grounding.js';
import {validateTemporalIntent} from './temporal-intent.js';
import {freeze} from '../../context/application/context-pack.js';
export interface ValidatedGroup {readonly labels:readonly string[];readonly actions:readonly ActionDraft[];readonly queryLabels:readonly string[];readonly status:'ready'|'choice'|'blocked';readonly reasons:readonly string[]}
const issued=new WeakMap<object,GroundedMeaning>();
export interface ValidatedDecision {readonly decision:MeaningDecision;readonly groups:readonly ValidatedGroup[]}
const withoutQuotes=(text:string)=>text.replace(/«[^»]*»|"[^"]*"|“[^”]*”/gu,' ');
const createCue=/(?:создай|создать|добавь|добавить|запиши|записать)\s+(?:новую\s+)?(?:задач|дело|пункт)/iu;
const kindCues={update:/перенес|перенос|перенести|передвин|измени|изменить|поменяй|переимен|назначь/iu,complete:/сделал|сделан|выполни[лт]|готов|заверши|завершать|закрой|закрыть/iu,cancel:/отмени|отменить|отмен[её]н/iu,reopen:/восстанови|восстановить|верни|возобнови|снова\s+открой/iu};
const mutationCue=/перенес[иу]|перенести|передвин|измени|изменить|переимен|заверши|закрой|отмени|восстанови|верни\s+задач|сделал|сделан|выполнил/iu;
function spans(value:unknown,visit:(e:SpanRef)=>void):void{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(v=>spans(v,visit));return;}const o=value as Record<string,unknown>;if(typeof o.sourceLabel==='string'&&typeof o.quote==='string'&&typeof o.start==='number'&&typeof o.end==='number'){visit(o as unknown as SpanRef);return;}Object.values(o).forEach(v=>spans(v,visit));}
/** Structural/evidence failure rejects the frame. Intent/time failure blocks only its connected component. */
export function validateDecision(grounded:GroundedMeaning,currentSourceLabel:string):ValidatedDecision{
 const d=parseMeaning(grounded.decision);const source=grounded.sourceMap.sources[currentSourceLabel];if(!source)throw new Error('DECISION_EVIDENCE');
 spans(d,e=>{const text=grounded.sourceMap.sources[e.sourceLabel];if(!text||[...text].slice(e.start,e.end).join('')!==e.quote)throw new Error('DECISION_EVIDENCE');});
 const parent=d.groups.map((_,i)=>i);const root=(i:number):number=>parent[i]===i?i:parent[i]=root(parent[i]!);
 const unite=(a:number,b:number)=>{parent[root(a)]=root(b);};const groupOf=(unit:string)=>d.groups.findIndex(g=>g.unitLabels.includes(unit));
 const targetKey=(a:ActionDraft)=>a.target?JSON.stringify(Object.fromEntries(Object.entries(a.target).filter(([k])=>k!=='evidence'))):null;
 for(const a of d.actions)for(const b of d.actions)if(a.label!==b.label&&targetKey(a)&&targetKey(a)===targetKey(b))unite(groupOf(a.unitLabel),groupOf(b.unitLabel));
 const adjacency=new Map<string,string[]>();
 const edge=(from:string,to:string)=>{adjacency.set(from,[...(adjacency.get(from)??[]),to]);};
 for(const a of d.actions)if(a.target?.kind==='created'){
  const reference=a.target.label;const created=d.actions.find(n=>n.label===reference);if(!created||created.kind!=='create'||created.label===a.label)throw new Error('DECISION_GRAPH');
  edge(created.unitLabel,a.unitLabel);unite(groupOf(created.unitLabel),groupOf(a.unitLabel));
 }
 for(const r of d.relations){if(r.kind==='same_target'&&r.toLabels.every(l=>l===r.fromLabel))continue; // tautology grants no target authority and joins nothing
  if(!r.evidence.length||r.evidence.every(e=>e.sourceLabel!==currentSourceLabel))throw new Error('DECISION_EVIDENCE');
  if(r.kind==='quote_scope')continue;
  for(const target of r.toLabels){const a=groupOf(r.fromLabel),b=groupOf(target);if(a>=0&&b>=0)unite(a,b);if(r.kind==='depends_on'&&target!==r.fromLabel)edge(r.fromLabel,target);}
 }
 // Groups sharing a unit are one connected component even without an explicit relation.
 d.groups.forEach((g,i)=>d.groups.forEach((h,j)=>{if(i<j&&g.unitLabels.some(l=>h.unitLabels.includes(l)))unite(i,j);}));
 const active=new Set<string>(),done=new Set<string>();const dfs=(node:string)=>{if(active.has(node))throw new Error('DECISION_GRAPH');if(done.has(node))return;active.add(node);(adjacency.get(node)??[]).forEach(dfs);active.delete(node);done.add(node);};d.units.forEach(u=>dfs(u.label));
 const issues=validateTemporalIntent(grounded).issues;
 const components=new Map<number,number[]>();d.groups.forEach((_,i)=>components.set(root(i),[...(components.get(root(i))??[]),i]));
 const groups=[...components.values()].map(indices=>{
  const gs=indices.map(i=>d.groups[i]!),actions=d.actions.filter(a=>gs.some(g=>g.actionLabels.includes(a.label))),reasons:string[]=gs.some(g=>g.outcome==='capability_unavailable')?['CAPABILITY_UNAVAILABLE']:[];
  for(const action of actions){const unit=d.units.find(u=>u.label===action.unitLabel)!;
   const evidence=[...unit.evidence,...action.evidence].filter(e=>e.sourceLabel===currentSourceLabel);
   if(unit.kind!=='action'||!unit.authoredByOwner||unit.polarity!=='positive'||unit.modality!=='asserted'||!['request','assertion'].includes(unit.speechAct)||!unit.evidence.some(e=>e.sourceLabel===currentSourceLabel)||!action.evidence.some(e=>e.sourceLabel===currentSourceLabel))reasons.push('OWNER_INTENT_UNPROVEN');
   const text=withoutQuotes(evidence.map(e=>e.quote).join(' '));
   if(/ничего\s+не\s+(?:сохраня|записыва|создава)|это\s+я\s+цитирую/iu.test(withoutQuotes(source)))reasons.push('SOURCE_RETRACTED');
   for(const e of action.evidence.filter(e=>e.sourceLabel===currentSourceLabel)){const before=[...source].slice(0,e.start).join('');if((before.match(/«/gu)?.length??0)>(before.match(/»/gu)?.length??0)||(before.match(/["“”]/gu)?.length??0)%2===1)reasons.push('QUOTED_ACTION');}
   const prefix=evidence.map(e=>[...source].slice(Math.max(0,e.start-24),e.start).join('').split(/[.!?;\n]/u).at(-1)).join(' ');
   if(/(?:^|\s)не\s+(?:(?:надо|нужно|хочу)\s+)?(?:созда|добав|запис|перенос|перенес|измени|меня|закры|закро|заверш|отмен|восстанов|дела)/iu.test(text)||/(?:^|\s)не\s+(?:(?:надо|нужно|хочу)\s*)?$/iu.test(prefix)||/(?:^|\s)не\s*$/iu.test(prefix)||/(?:он|она|они)\s+(?:сказал|попросил)|цитат|если\s+бы/iu.test(text))reasons.push('SOURCE_INTENT_DENIED');
   if(action.kind==='create'){
    if(action.target!==null||!action.fields.title||mutationCue.test(text)&&!createCue.test(text))reasons.push('CREATE_INTENT_MISMATCH');
   }else{
    if(action.target===null||createCue.test(text)||!kindCues[action.kind].test(text)||Object.entries(kindCues).some(([kind,cue])=>kind!==action.kind&&cue.test(text)))reasons.push('MUTATION_INTENT_MISMATCH');
    if(action.kind==='update'&&action.fields.clearFields.length&&!/(?:убери|удали|очисти|сбрось|сними)/iu.test(text))reasons.push('CLEAR_FIELD_UNPROVEN');
    if(action.kind==='update'&&!action.fields.title&&!action.fields.description&&!action.fields.clearFields.length&&!action.times.length)reasons.push('EMPTY_UPDATE');
    if(['complete','cancel','reopen'].includes(action.kind)&&(action.times.length||action.fields.title!==null||action.fields.description!==null||action.fields.clearFields.length))reasons.push('LIFECYCLE_FIELD_CHANGE');
   }
   issues.filter(i=>!i.actionLabel||i.actionLabel===action.label).forEach(i=>reasons.push(i.code));
  }
  return {labels:gs.map(g=>g.label),actions,queryLabels:gs.flatMap(g=>g.queryLabels),status:reasons.length?'blocked' as const:gs.some(g=>g.outcome==='needs_choice')?'choice' as const:'ready' as const,reasons:[...new Set(reasons)]};
 });
 const result=freeze({decision:d,groups});issued.set(result,freeze(structuredClone({...grounded,decision:d})));return result;
}

import type {TargetResolver,TargetResolution} from './target-resolver.js';
import type {TemporalNormalizer,TimeResolution} from './temporal-normalizer.js';
export interface ResolvedAction {readonly draft:ActionDraft;readonly target:TargetResolution|null;readonly time:TimeResolution}
export interface ResolvedGroup {readonly labels:readonly string[];readonly actions:readonly ResolvedAction[];readonly queryLabels:readonly string[];readonly status:'ready'|'choice'|'blocked';readonly reasons:readonly string[]}
/** Deterministic preparation only. No effects, receipt or provider call are possible here. */
export async function resolveDecision(validated:ValidatedDecision,resolver:TargetResolver,time:TemporalNormalizer,source:{sourceAt:string;timezone:string}):Promise<readonly ResolvedGroup[]>{
 const grounded=issued.get(validated);if(!grounded)throw new Error('VALIDATED_DECISION_REQUIRED');
 const result:ResolvedGroup[]=[];
 for(const group of validated.groups){
  if(group.status==='blocked'){result.push({...group,actions:[]});continue;}
  const actions:ResolvedAction[]=[],reasons=[...group.reasons];let status:ResolvedGroup['status']=group.status;
  for(const draft of group.actions){
   const target=draft.target?await resolver.resolve(draft.target,group.labels.join(':')):null;
   const temporal=time.normalize(grounded,draft,source);
   if(target&&['not_found','narrow','budget'].includes(target.status)){status='blocked';reasons.push('TARGET_'+target.status.toUpperCase());}
   if(target?.status==='choice'||temporal.status==='choice')if(status!=='blocked')status='choice';
   if(temporal.status==='invalid'){status='blocked';reasons.push(temporal.reason);}
   actions.push({draft,target,time:temporal});
  }
  result.push({labels:group.labels,actions,queryLabels:group.queryLabels,status,reasons});
 }
 // Different labels/reply/search bases can resolve to the same real Task. Join before any runner effect.
 const ids=(g:ResolvedGroup)=>new Set(g.actions.flatMap(a=>a.target?.status==='resolved'?a.target.targets.map(t=>t.id):a.target?.status==='choice'?a.target.options.map(t=>t.id):[]));
 let joined=true;while(joined){joined=false;outer:for(let i=0;i<result.length;i++)for(let j=i+1;j<result.length;j++){
  const a=result[i]!,b=result[j]!,keys=ids(a);if(![...ids(b)].some(id=>keys.has(id)))continue;
  result[i]={labels:[...a.labels,...b.labels],actions:[...a.actions,...b.actions],queryLabels:[...a.queryLabels,...b.queryLabels],status:a.status==='blocked'||b.status==='blocked'?'blocked':a.status==='choice'||b.status==='choice'?'choice':'ready',reasons:[...a.reasons,...b.reasons]};result.splice(j,1);joined=true;break outer;
 }}
 return freeze(result);
}
