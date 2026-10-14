import { randomUUID } from 'node:crypto';
import { TaskCommands } from '../../src/modules/tasks/application/task-commands.js';
import { PostgresTaskSessionRunner } from '../../src/infrastructure/postgres/tasks/task-session.js';
import { IanaTimeResolver } from '../../src/infrastructure/time/iana-time-resolver.js';
import type { TaskCommand,TaskCommandGroup } from '../../src/modules/tasks/domain/commands.js';
import type { TaskExecutionContext } from '../../src/modules/tasks/application/context.js';
import type { UserId } from '../../src/shared/types/identity.js';
import type { taskFixture } from './task-fixture.js';
export function taskRequest(userId:UserId,commands:readonly unknown[],effectKey=randomUUID()){
 const typed=commands as readonly TaskCommand[];
 const context:TaskExecutionContext={userId,actor:'owner',capability:'task_write',source:{kind:'typed',operationId:randomUUID()},
 sourceOccurredAt:'2026-10-14T09:00:00.000Z',timezoneSnapshot:'Europe/Moscow',
 intents:typed.map(c=>({kind:c.kind,binding:c.kind==='create'?{created:c.localId}:c.target,affirmative:true,asserted:true,ownerAuthored:true,quoted:false}))};
 return {context,group:{contractVersion:1 as const,effectKey,commands:typed}};
}
export function taskHarness(f:Awaited<ReturnType<typeof taskFixture>>){return new TaskCommands(new PostgresTaskSessionRunner(f.database),new IanaTimeResolver());}
export async function execute(h:TaskCommands,r:ReturnType<typeof taskRequest>){const result=await h.execute(r.context,r.group);if('error' in result)throw new Error(result.error.code);return result.receipt;}
export async function create(h:TaskCommands,userId:UserId,fields:Record<string,unknown>={}){
 const receipt=await execute(h,taskRequest(userId,[{kind:'create',localId:'a',title:'Дело',...fields}]));
 if(receipt.outcome==='rejected')throw new Error(receipt.error!.code);return receipt.snapshots[0]!;
}
