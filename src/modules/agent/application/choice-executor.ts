import type {ResolvedGroup,ResolvedAction} from '../../semantic/application/decision-validator.js';
import type {ContextSnapshot} from '../../context/application/context-pack.js';
import type {TaskCommand} from '../../tasks/domain/commands.js';
import type {TemporalPort} from '../../tasks/application/temporal-port.js';
import type {UserId} from '../../../shared/types/identity.js';
import {TemporalNormalizer} from '../../semantic/application/temporal-normalizer.js';
import {compileGroups} from './group-runner.js';
export interface ChoiceOption {readonly label:string;readonly commands:readonly TaskCommand[]}
/** Finite typed alternatives only. No ambient task, free-form instruction or date invention. */
export function choiceOptions(group:ResolvedGroup,context:ContextSnapshot,user:UserId,time:TemporalPort):readonly ChoiceOption[]{
 if(group.status!=='choice')return [];
 let variants:{actions:ResolvedAction[];labels:string[]}[]=[{actions:[],labels:[]}];
 for(const action of group.actions){
  if(action.time.status==='invalid')return [];
  const targets=action.target?.status==='choice'?action.target.options.map(t=>({status:'resolved' as const,targets:[t]})):[action.target];
  let times:ResolvedAction['time'][]=[action.time];
  if(action.time.status==='choice'){
   const field=action.time.field??action.draft.times.filter(t=>t.field!=='targetDate')[0]?.field;if(!field||field==='targetDate')return [];
   const other=(action.time.values??[]).filter(v=>v.field!==field),dates=new TemporalNormalizer(time);
   for(const slot of action.draft.times){if(slot.field===field||other.some(v=>v.field===slot.field))continue;if(slot.field!=='targetDate')return [];const date=dates.dateExpression(slot.expression,context.source);if(!date)return [];other.push({field:'targetDate',date});}
   times=action.time.options.map(o=>({status:'resolved',values:[...other,{field,at:o.at}]}));
  }
  if(!targets.length||targets.length*times.length*variants.length>5)return [];
  const next:typeof variants=[];
  for(const previous of variants)for(const target of targets)for(const resolvedTime of times){
   const binding=target?.status==='resolved'?target.targets[0]:undefined;
   const task=binding?(binding.snapshot??context.taskSnapshots?.find(t=>t.id===binding.id)):undefined;
   const title=action.target?.status==='choice'&&task?(task.targetDate??(task.scheduledAt?time.localDate(task.scheduledAt,task.timezone):'без даты'))+' · '+({open:'Открыта',completed:'Выполнена',cancelled:'Отменена'}[task.status])+' · '+[...task.title].slice(0,48).join(''):undefined;
   const clock=action.time.status==='choice'&&resolvedTime.status==='resolved'?resolvedTime.values.find(v=>'at' in v):undefined;
   next.push({actions:[...previous.actions,{...action,target,time:resolvedTime}],labels:[...previous.labels,...(title?[title]:[]),...(clock&&'at' in clock?[new Intl.DateTimeFormat('ru-RU',{timeZone:context.source.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(clock.at))+' UTC'+(action.time.status==='choice'?action.time.options.find(o=>o.at===clock.at)?.offset??'':'')]:[])]});
  }
  variants=next;
 }
 if(variants.length<2)return [];
 const options=variants.map((v,i)=>{const [compiled]=compileGroups([{...group,status:'ready',actions:v.actions}],context,user,time);return {label:[...(String(i+1)+'. '+v.labels.join(' / '))].slice(0,128).join('')||'Вариант',commands:compiled?.status==='ready'?compiled.commands:[]};});
 return options.some(o=>!o.commands.length)?[]:options;
}

export interface ChoiceReference {readonly choiceId:string;readonly revision:number;readonly option:number;readonly keyVersion:number}
export interface SavedChoice {readonly id:string;readonly revision:number;readonly options:readonly {label:string;ref:ChoiceReference}[]}
