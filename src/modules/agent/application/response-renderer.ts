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
   if(query.kind==='tasks'){listed=true;line(query.day?'Задачи на '+query.day+':':'Задачи:');for(const t of query.items)taskLine(t.title,t.id,t.version);if(!query.items.length)line('Задач нет.');if(query.nextCursor)line('В списке есть ещё задачи.');}
  }
 }
 if(omitted)line('Ещё '+omitted+' записей не показаны.');
 if(!lines.length)line('Задачи не изменены.');
 // Reserve room for an explicit omission notice; anchors follow only rendered rows.
 const displayed:TaskBinding[]=[],rendered:string[]=[];let size=0,budgetOmitted=0;
 const numbered=listed||tasks.length>1;
 for(const entry of lines){
  const binding=entry.id?tasks.find(t=>t.id===entry.id):undefined;
  const ordinal=binding?(displayed.findIndex(t=>t.id===binding.id)>=0?displayed.findIndex(t=>t.id===binding.id)+1:displayed.length+1):0;
  const value=binding&&numbered?`${ordinal}. ${entry.text}`:entry.text;
  if(size+[...value].length+1>3900){budgetOmitted++;continue;}
  rendered.push(value);size+=[...value].length+1;if(binding&&!displayed.some(t=>t.id===binding.id))displayed.push(binding);
 }
 if(budgetOmitted)rendered.push('Часть записей не показана из-за ограничения длины ответа.');
 const text=rendered.join('\n');
 return {message:{version:1,kind:'text',text},tasks:displayed,anchorKind:numbered?'list':'reply'};
}
