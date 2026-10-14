import type {ProcessingContinuation} from './postgres-atomic-processing.js';
import type {DbTx} from './database.js';
import type {InboundEvent} from '../../modules/intake/domain/inbound-event.js';
import type {HandleInboundResult} from '../../modules/intake/application/inbound-handler.js';
import type {ExplicitTaskIntent} from '../../modules/tasks/application/context.js';
import {ownerTaskContext} from '../../modules/tasks/application/context.js';
import {TaskCommands} from '../../modules/tasks/application/task-commands.js';
import {PostgresBoundTaskSessionRunner} from './tasks/task-session.js';
import {IanaTimeResolver} from '../time/iana-time-resolver.js';
export interface PreparedTypedTask {readonly group:unknown;readonly intents:readonly ExplicitTaskIntent[]}
// Test injection only. Production runtime keeps FoundationInboundHandler without this continuation.
export class PostgresTypedTaskProcessing implements ProcessingContinuation {
 constructor(private readonly prepared:(event:InboundEvent)=>PreparedTypedTask){}
 async continue(tx:DbTx,event:InboundEvent,_prepared:HandleInboundResult):Promise<HandleInboundResult>{
  const input=this.prepared(event);
  const context=ownerTaskContext(event.userId,{kind:'turn',turnId:event.id},event.occurredAt.toISOString(),event.timezoneSnapshot,input.intents);
  const result=await new TaskCommands(new PostgresBoundTaskSessionRunner(tx,event),new IanaTimeResolver()).execute(context,input.group);
  if('error' in result)throw new Error('Typed task envelope or authority rejected');
  return {receiptType:'task_commands_v1',receiptVersion:1,taskReceiptId:result.receipt.receiptId,
   messages:[{version:1,kind:'text',text:`Задачи: ${result.receipt.outcome}${result.receipt.error?' ('+result.receipt.error.code+')':''}.`}]};
 }
}
