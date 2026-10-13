import { expect, test } from 'vitest';
import { normalizeCommand } from '../../../src/modules/tasks/domain/validation.js';
import { validateEvidence } from '../../../src/modules/tasks/application/evidence.js';
const id='11111111-1111-4111-8111-111111111111';
const create={kind:'create',localId:'a',title:'  Позвонить  '};
const context={userId:id,actor:'owner',capability:'task_write',source:{kind:'typed',operationId:id},
 sourceOccurredAt:'2026-10-13T12:00:00.000Z',timezoneSnapshot:'Europe/Moscow',
 intents:[{kind:'create',binding:{created:'a'},affirmative:true,asserted:true,ownerAuthored:true,quoted:false}]};
test('create_without_dates_is_valid',()=>{
 expect(normalizeCommand(create)).toEqual({...create,title:'Позвонить',description:null,targetDate:null,scheduledAt:null,deadline:null});
});
test('counts Unicode code points and enforces text limits',()=>{
 expect(normalizeCommand({...create,title:'😀'.repeat(500)})).not.toHaveProperty('code');
 expect(normalizeCommand({...create,title:'😀'.repeat(501)})).toEqual({code:'invalid_title'});
 for(const title of ['',' \t','a\nb','a\u0000b','a\u0085b']) expect(normalizeCommand({...create,title})).toEqual({code:'invalid_title'});
 expect(normalizeCommand({...create,description:' \n\t '})).toHaveProperty('description',null);
 expect(normalizeCommand({...create,description:'a'.repeat(10001)})).toEqual({code:'invalid_description'});
});
test('rejects unknown fields and distinguishes absent patch fields from explicit null',()=>{
 expect(normalizeCommand({...create,userId:id})).toEqual({code:'invalid_command'});
 expect(normalizeCommand({kind:'update',target:{taskId:id},expectedVersion:1,patch:{targetDate:null}}))
 .toEqual({kind:'update',target:{taskId:id},expectedVersion:1,patch:{targetDate:null}});
 for(const patch of [{},{version:2},{userId:id},{status:'completed'},{title:null}])
 expect(normalizeCommand({kind:'update',target:{taskId:id},expectedVersion:1,patch})).toHaveProperty('code');
});
test('non_owner_or_nonaffirmative_intent_rejected',()=>{
 const command=normalizeCommand(create);
 expect(validateEvidence(context,command)).toBeNull();
 for(const modification of [{affirmative:false},{asserted:false},{ownerAuthored:false},{quoted:true},{binding:{created:'b'}}]){
  expect(validateEvidence({...context,intents:[{...context.intents[0],...modification}]},command)).toEqual({code:'invalid_evidence'});
 }
 expect(validateEvidence({...context,intents:[]},command)).toEqual({code:'invalid_evidence'});
 for(const actor of ['operator','import']) expect(validateEvidence({...context,actor},command)).toEqual({code:'unsupported_actor'});
 const update={kind:'update',target:{taskId:id},expectedVersion:1,patch:{title:'Новое'}};
 expect(validateEvidence(context,normalizeCommand(update))).toEqual({code:'invalid_evidence'});
 expect(normalizeCommand(update)).toHaveProperty('kind','update');
});
