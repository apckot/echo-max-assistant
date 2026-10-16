import type {GroupOutcome} from './group-runner.js';
import type {TaskBinding} from '../../context/application/context-pack.js';
import type {OutboundMessageDraft} from '../../delivery/domain/outbound-message.js';
export interface RenderedResponse {readonly message:OutboundMessageDraft;readonly tasks:readonly TaskBinding[];readonly anchorKind:'reply'|'list'}
export function renderResponse(groups:readonly GroupOutcome[],failureCode:string|null=null):RenderedResponse{
 const lines:{text:string;id?:string}[]=[],tasks:TaskBinding[]=[];let listed=false,shown=0,omitted=0,historyShown=0;
 const line=(text:string)=>lines.push({text});
 const taskLine=(text:string,id:string,version:number)=>{if(shown>=20){omitted++;return;}shown++;if([...text].length>400)text=[...text].slice(0,399).join('')+'…';lines.push({text,id});const previous=tasks.findIndex(t=>t.id===id);if(previous>=0)tasks[previous]={id,version};else tasks.push({id,version});};
 if(failureCode)line(failureCode==='privacy_denied'?'Внешняя обработка текста не разрешена. Задачи не изменены.':'Обработка сообщения не завершилась. Для этого сообщения задачи не изменены.');
 for(const group of groups){
  if(group.receipt){
   if(group.receipt.outcome==='rejected'){line(group.receipt.error?.code==='version_conflict'?'Задача уже изменилась. Эта группа действий не применена.':'Не удалось применить эту группу действий. Задачи группы не изменены.');continue;}
   for(const command of group.receipt.commandResults){const task=group.receipt.snapshots.find(t=>t.id===command.taskId);if(!task)throw Error('RESPONSE_RECEIPT_MISSING_SNAPSHOT');
    const verb=command.outcome==='no_change'?'Без изменений':({create:'Создано',update:'Изменено',complete:'Завершено',cancel:'Отменено',reopen:'Восстановлено'}[command.kind]);
    taskLine(`${verb}: «${task.title}».`,task.id,task.version);
   }
  }else if(group.outcome==='choice')line('Нужен однозначный выбор. Это действие пока не выполнено.');
  else if(group.outcome==='blocked')line('Не удалось надёжно определить команду или цель. Это действие не выполнено.');
  for(const query of group.queryResults??[]){
   if(query.kind==='capabilities')line(query.text);
   if(query.kind==='unavailable')line('Не удалось надёжно выполнить запрос списка или истории.');
   if(query.kind==='history'){line('История задачи:');for(const e of query.items)if(historyShown++<20)line(`Версия ${e.afterVersion}: ${e.kind}.`);if(!query.items.length)line('Изменений нет.');}
   if(query.kind==='tasks'){listed=true;line(query.day?'Задачи на '+query.day+':':'Задачи:');for(const t of query.items)taskLine(t.title,t.id,t.version);if(!query.items.length)line('Задач нет.');if(query.nextCursor)line('Показываю '+query.items.length+' задач. Есть ещё.');}
  }
 }
 if(omitted)line('Показаны первые 20 записей. Ещё '+omitted+' записей не показаны.');
 if(!lines.length)line('Задачи не изменены.');
 const numbered=listed||tasks.length>1,text=lines.map(l=>l.id&&numbered?`${tasks.findIndex(t=>t.id===l.id)+1}. ${l.text}`:l.text).join('\n');
 if([...text].length>12000)throw Error('RESPONSE_BUDGET');return {message:{version:1,kind:'text',text},tasks,anchorKind:numbered?'list':'reply'};
}
