import type {TargetBasis} from '../domain/meaning-decision.js';
import type {DeliveredAnchor,TaskBinding} from '../../context/application/context-pack.js';
export type TargetResolution={readonly status:'resolved';readonly targets:readonly TaskBinding[]}|{readonly status:'choice';readonly options:readonly TaskBinding[]}|{readonly status:'not_found'|'narrow'|'budget'|'created';readonly actionLabel?:string};
export interface TargetSnapshot {readonly replyHasChoices?:boolean;readonly bindings:Readonly<Record<string,TaskBinding>>;readonly anchors:readonly DeliveredAnchor[];readonly source?:{readonly sourceLabel:string;readonly text?:string};readonly provider?:{readonly sourceLabel?:string;readonly text?:string;readonly candidates:readonly {readonly label:string;readonly title:string}[]}}
export type TargetSearch=(title:string,qualifiers:{date:string|null;status:'open'|'completed'|'cancelled'|null},limit:number)=>Promise<readonly TaskBinding[]>;
/** A resolver is scoped to one turn; its search budget cannot be reset between groups. */
export class TargetResolver {
 private count=0;private readonly searched=new Map<string,{fingerprint:string;result:TargetResolution}>();
 constructor(private readonly snapshot:TargetSnapshot,private readonly search:TargetSearch){}
 async resolve(target:TargetBasis,component='default'):Promise<TargetResolution>{
  if(target.kind==='created')return {status:'created',actionLabel:target.label};
  if(target.kind==='candidate'){
   const binding=this.snapshot.bindings[target.label],candidates=this.snapshot.provider?.candidates??[];
   if(!binding||!candidates.some(c=>c.label===target.label))return {status:'not_found'};
   const matching=candidates.filter(c=>target.evidence.some(e=>e.quote.toLocaleLowerCase('ru').includes(c.title.toLocaleLowerCase('ru')))).flatMap(c=>this.snapshot.bindings[c.label]?[this.snapshot.bindings[c.label]!]:[]);
   if(matching.length)return !matching.some(t=>t.id===binding.id)?{status:'not_found'}:matching.length===1?{status:'resolved',targets:matching}:matching.length<=5?{status:'choice',options:matching}:{status:'narrow'};
   // A pronoun grants no candidate-label authority. Only the unique confirmed reply
   // anchor supplied by the tenant/conversation reader may supply the real target/version.
   const source=this.snapshot.source??this.snapshot.provider,sourceLabel=source?.sourceLabel,points=source?.text===undefined?null:[...source.text];
   const word=/[\p{L}\p{M}\p{N}_]/u;
   const pronoun=!!points&&!!sourceLabel&&target.evidence.some(e=>e.sourceLabel===sourceLabel&&/^(?:е[её]|его|их|эту|этот|эта|эти)$/iu.test(e.quote)&&points.slice(e.start,e.end).join('')===e.quote&&!word.test(points[e.start-1]??'')&&!word.test(points[e.end]??''));
   const anchors=this.snapshot.anchors;
   if(this.snapshot.replyHasChoices||!pronoun||anchors.length!==1||anchors[0]!.kind!=='reply'||anchors[0]!.tasks.length!==1)return {status:'not_found'};
   const anchored=anchors[0]!.tasks[0]!;
   return anchored.id===binding.id?{status:'resolved',targets:[anchored]}:{status:'not_found'};
  }
  if(target.kind==='reply'||target.kind==='list_index'){
   const anchor=this.snapshot.anchors.find(a=>a.label===target.anchorLabel);if(!anchor)return {status:'not_found'};
   if(target.kind==='reply')return !this.snapshot.replyHasChoices&&anchor.kind==='reply'&&anchor.tasks.length===1?{status:'resolved',targets:anchor.tasks}:{status:'not_found'};
   if(anchor.kind!=='list')return {status:'not_found'};
   const tasks=target.indices.map(i=>anchor.tasks[i-1]);return tasks.every((t):t is TaskBinding=>!!t)?{status:'resolved',targets:tasks}:{status:'not_found'};
  }
  const fingerprint=JSON.stringify([target.title,target.qualifiers]);const saved=this.searched.get(component);
  if(saved)return saved.fingerprint===fingerprint?saved.result:{status:'budget'};
  if(this.count>=3)return {status:'budget'};this.count++;
  // Count failed requests too; a failing query is not permission for another search.
  this.searched.set(component,{fingerprint,result:{status:'budget'}});
  const matches=await this.search(target.title,target.qualifiers,6);
  const unique=[...new Map(matches.map(m=>[m.id,m])).values()];
  const result:TargetResolution=unique.length===0?{status:'not_found'}:unique.length===1?{status:'resolved',targets:unique}:unique.length<=5?{status:'choice',options:unique}:{status:'narrow'};
  this.searched.set(component,{fingerprint,result});return result;
 }
}

import type {TaskQueries} from '../../tasks/application/task-queries.js';
import type {TaskReadContext} from '../../tasks/application/query-types.js';
/** Composition binds the query capability to the current internal tenant, never model-supplied IDs. */
export function taskTargetSearch(tasks:Pick<TaskQueries,'list'>,context:TaskReadContext):TargetSearch{
 return async(title,qualifiers,limit)=>{
  if(!title.trim()||[...title].length>200)return [];
  const page=await tasks.list(context,{view:qualifiers.date?'day':'all',...(qualifiers.date?{day:qualifiers.date,timezone:context.timezone}:{}),...(qualifiers.status?{statuses:[qualifiers.status]}:{}),text:title,limit:Math.min(limit,6)});
  if('error' in page)throw new Error('TARGET_QUERY_UNAVAILABLE');
  return page.items.map(t=>({id:t.id,version:t.version,snapshot:t}));
 };
}
