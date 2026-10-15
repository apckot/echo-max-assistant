import type {TargetBasis} from '../domain/meaning-decision.js';
import type {DeliveredAnchor,TaskBinding} from '../../context/application/context-pack.js';
export type TargetResolution={readonly status:'resolved';readonly targets:readonly TaskBinding[]}|{readonly status:'choice';readonly options:readonly TaskBinding[]}|{readonly status:'not_found'|'narrow'|'budget'|'created';readonly actionLabel?:string};
export interface TargetSnapshot {readonly bindings:Readonly<Record<string,TaskBinding>>;readonly anchors:readonly DeliveredAnchor[]}
export type TargetSearch=(title:string,qualifiers:{date:string|null;status:'open'|'completed'|'cancelled'|null},limit:number)=>Promise<readonly TaskBinding[]>;
/** A resolver is scoped to one turn; its search budget cannot be reset between groups. */
export class TargetResolver {
 private count=0;private readonly searched=new Map<string,{fingerprint:string;result:TargetResolution}>();
 constructor(private readonly snapshot:TargetSnapshot,private readonly search:TargetSearch){}
 async resolve(target:TargetBasis,component='default'):Promise<TargetResolution>{
  if(target.kind==='created')return {status:'created',actionLabel:target.label};
  if(target.kind==='candidate'){const t=this.snapshot.bindings[target.label];return t?{status:'resolved',targets:[t]}:{status:'not_found'};}
  if(target.kind==='reply'||target.kind==='list_index'){
   const anchor=this.snapshot.anchors.find(a=>a.label===target.anchorLabel);if(!anchor)return {status:'not_found'};
   if(target.kind==='reply')return anchor.kind==='reply'&&anchor.tasks.length===1?{status:'resolved',targets:anchor.tasks}:{status:'not_found'};
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
  return page.items.map(t=>({id:t.id,version:t.version}));
 };
}
