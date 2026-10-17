import {z} from 'zod';
import data from '../fixtures/stage3/r-application.json';
import prose from '../fixtures/stage3/regressions.json';
const ref=z.string().regex(/^[TN][1-9][0-9]*$/);
export const fieldsSchema=z.strictObject({title:z.string().min(1),description:z.string().nullable(),status:z.enum(['open','completed','cancelled']),targetDate:z.string().nullable(),scheduledAt:z.string().nullable(),dueDate:z.string().nullable(),dueAt:z.string().nullable(),timezone:z.string(),version:z.number().int().positive()});
const op=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('create'),ref,fields:fieldsSchema}),z.strictObject({kind:z.literal('update'),ref,patch:fieldsSchema.partial()}),z.strictObject({kind:z.enum(['complete','cancel','reopen']),ref})]);
const query=z.object({kind:z.enum(['open','day','history','capabilities']),refs:z.array(ref),dayExpression:z.string().optional(),day:z.string().optional(),statuses:z.array(z.enum(['open','completed','cancelled'])).optional(),targetRef:ref.optional()});
export const groupSchema=z.object({status:z.enum(['ready','blocked','choice']),reason:z.string().optional(),effects:z.array(op),commands:z.array(op).optional(),options:z.array(z.array(op)).min(2).max(5).optional(),query:query.optional(),receiptOutcome:z.enum(['applied','no_change','rejected']).optional()});
const task=fieldsSchema.extend({ref});
export const fixtureSchema=z.strictObject({id:z.string().regex(/^[CH]\d{3}$/),input:z.strictObject({kind:z.enum(['text','transcript']),text:z.string().min(1),sourceAt:z.iso.datetime(),timezone:z.string()}),initialTasks:z.array(task),context:z.object({anchor:z.object({refs:z.array(ref),kind:z.enum(['reply','list']),sent:z.boolean(),ageDays:z.number().int().nonnegative()}).nullable(),pendingChoices:z.number().int().min(0).max(3),replyChoice:z.boolean().optional(),visibleRefs:z.array(ref).optional(),createdAfterAnchor:z.array(ref).optional(),resolvedRefs:z.array(ref).optional(),unresolvedTargets:z.array(ref).optional()}).passthrough(),proposal:z.strictObject({groups:z.array(groupSchema)}),expected:z.strictObject({effects:z.array(z.strictObject({kind:z.enum(['create','update','complete','cancel','reopen']),ref,changes:fieldsSchema.partial()})),finalTasks:z.array(task),unchangedFields:z.record(ref,z.array(z.string())),choices:z.array(z.strictObject({alternatives:z.array(z.array(op)),cancel:z.literal(true)})),queries:z.array(query),pendingChoicesBefore:z.number().int(),pendingChoicesAfter:z.number().int()}),provenance:z.strictObject({sourceAndMode:z.string(),sourceScenario:z.string(),sourceOracle:z.string(),set:z.literal('regression'),modelQualityEvidence:z.literal(false)}),family:z.string(),category:z.enum(['choice','query','task','unsupported','negative'])});
export type RFixture=z.infer<typeof fixtureSchema>;
export type ROp=z.infer<typeof op>;
export type RGroup=z.infer<typeof groupSchema>;
export function validateRFixtures(input:unknown):readonly RFixture[]{
 const rows=z.array(fixtureSchema).parse(input),ids=prose.cases.filter(c=>c.sourceAndMode.split('/')[1]!.startsWith('R')).map(c=>c.id).sort();
 if(rows.length!==78||new Set(rows.map(c=>c.id)).size!==78||JSON.stringify(rows.map(c=>c.id).sort())!==JSON.stringify(ids))throw Error('R_INVENTORY_INCOMPLETE');
 for(const c of rows){const source=prose.cases.find(s=>s.id===c.id)!;if(c.provenance.sourceScenario!==source.scenario||c.provenance.sourceOracle!==source.oracle)throw Error('R_PROVENANCE_CHANGED');if(new Set(c.initialTasks.map(t=>t.ref)).size!==c.initialTasks.length)throw Error('R_DUPLICATE_REF');for(const g of c.proposal.groups)if(g.status==='choice'&&!g.options||g.status!=='ready'&&g.effects.length)throw Error('R_INVALID_GROUP');}
 return rows;
}
export const rFixtures=validateRFixtures(data.cases);
