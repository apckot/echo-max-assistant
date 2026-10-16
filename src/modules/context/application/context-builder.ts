import type {TaskQueries} from '../../tasks/application/task-queries.js';
import type {UserId} from '../../../shared/types/identity.js';
import type {ContextReader} from './context-port.js';
import {freeze,type ContextSnapshot,type SourceSnapshot,type TaskBinding} from './context-pack.js';
export class ContextBuilder {
 constructor(private readonly tasks:Pick<TaskQueries,'get'|'list'>,private readonly reader:ContextReader){}
 async build(userId:UserId,conversationId:string,input:SourceSnapshot):Promise<ContextSnapshot>{
  const source=structuredClone(input);
  if([...source.text].length>16000||Buffer.byteLength(source.text,'utf8')>65536||!source.text||!Number.isFinite(Date.parse(source.sourceAt)))throw new Error('CONTEXT_SOURCE_INVALID');
  const anchor=source.replyMessageId?await this.reader.anchor(userId,conversationId,source.replyMessageId):null;
  if(source.replyMessageId&&!anchor)throw new Error('CONTEXT_ANCHOR_MISSING');
  const ctx={userId,capability:'task_read' as const,timezone:source.timezone};
  const page=await this.tasks.list(ctx,{view:'all',limit:50});if('error' in page)throw new Error('CONTEXT_TASKS_UNAVAILABLE');
  const selected=[...page.items];
  let extraQueries=0;
  for(const binding of anchor?.tasks??[]){if(selected.some(t=>t.id===binding.id))continue;if(++extraQueries>2)throw new Error('CONTEXT_ANCHOR_BUDGET');const task=await this.tasks.get(ctx,binding.id);if(!task||'error' in task)throw new Error('CONTEXT_ANCHOR_MISSING');selected.unshift(task);}
  selected.sort((a,b)=>Number(!!anchor?.tasks.some(t=>t.id===b.id))-Number(!!anchor?.tasks.some(t=>t.id===a.id)));
  if(selected.length>50)selected.length=50;
  const bindings:Record<string,TaskBinding>={};
  const candidates=selected.map((t,i)=>{const label='T'+(i+1);bindings[label]={id:t.id,version:t.version};return {label,title:t.title,description:t.description?[...t.description].slice(0,512).join(''):null,descriptionTruncated:t.description!==null&&[...t.description].length>512,status:t.status,targetDate:t.targetDate,scheduledAt:t.scheduledAt,deadline:t.dueAt??t.dueDate};});
  const history=await this.reader.history(userId,conversationId,source.sourceAt);
  const anchors=anchor?[anchor]:[];
  const projected=anchors.map(a=>({label:a.label,kind:a.kind,candidateLabels:a.tasks.map(t=>Object.keys(bindings).find(k=>bindings[k]!.id===t.id)!)}));
  if(projected.some(a=>a.candidateLabels.some(l=>!l)))throw new Error('CONTEXT_ANCHOR_BUDGET');
  const auxiliary={candidates,anchors:projected,history,pendingChoices:[]};
  // UTF-8 bytes bound token count conservatively; no model tokenizer or source truncation.
  if(Buffer.byteLength(JSON.stringify(auxiliary),'utf8')>6000||Buffer.byteLength(JSON.stringify({...auxiliary,...source}),'utf8')>24000)throw new Error('CONTEXT_BUDGET');
  if(Buffer.byteLength(JSON.stringify(selected),'utf8')>200000)throw new Error('CONTEXT_BUDGET');
  return freeze({taskSnapshots:selected,source,provider:{text:source.text,sourceLabel:source.sourceLabel,sourceAt:source.sourceAt,timezone:source.timezone,candidates,anchors:projected,history,pendingChoices:[]},bindings,anchors});
 }
}
