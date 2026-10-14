import {expect,test} from 'vitest';
import {planGroup} from '../../../src/modules/tasks/application/group-planner.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
import {taskRequest} from '../../support/task-command-fixtures.js';
import {normalizeCommand} from '../../../src/modules/tasks/domain/validation.js';
const user='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',receipt='33333333-3333-4333-8333-333333333333';
test('planner stages changes without mutating inputs and refuses a last invalid reference',()=>{
 const r=taskRequest(user,[{kind:'create',localId:'a',title:'Дело'},{kind:'update',target:{created:'missing'},expectedVersion:1,patch:{title:'X'}}]);
 const group={...r.group,commands:r.group.commands.map(normalizeCommand)};const original=JSON.stringify(group);
 expect(planGroup(r.context,group,[],new Map([['a',id]]),receipt,'2026-10-14T09:00:00.000Z',new IanaTimeResolver())).toEqual({code:'invalid_local_reference',index:1});
 expect(JSON.stringify(group)).toBe(original);
});
