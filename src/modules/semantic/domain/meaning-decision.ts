import {z} from 'zod';
const label=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
export const spanSchema=z.strictObject({sourceLabel:label,start:z.number().int().min(0),end:z.number().int().min(0),quote:z.string().max(32000)});
const evidence=z.array(spanSchema).max(40);
const target=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('candidate'),label,evidence}),
 z.strictObject({kind:z.literal('reply'),anchorLabel:label,evidence}),
 z.strictObject({kind:z.literal('list_index'),anchorLabel:label,indices:z.array(z.number().int().min(1).max(100)).min(1).max(20),evidence}),
 z.strictObject({kind:z.literal('search'),title:z.string().max(500),qualifiers:z.strictObject({date:z.string().nullable(),status:z.enum(['open','completed','cancelled']).nullable()}),evidence}),
 z.strictObject({kind:z.literal('created'),label}),
]);
export const unitSchema=z.strictObject({label,kind:z.enum(['action','query','context','unsupported']),speechAct:z.enum(['request','assertion','question','quote','hypothesis','meta']),polarity:z.enum(['positive','negative']),modality:z.enum(['asserted','uncertain']),authoredByOwner:z.boolean(),evidence,uncertainty:z.enum(['target','time','intent']).nullable()});
export const actionSchema=z.strictObject({label,unitLabel:label,kind:z.enum(['create','update','complete','cancel','reopen']),target:target.nullable(),fields:z.strictObject({title:z.string().max(500).nullable(),description:z.string().max(16000).nullable(),clearFields:z.array(z.enum(['description','targetDate','scheduledAt','deadline'])).max(4)}),times:z.array(z.strictObject({field:z.enum(['targetDate','scheduledAt','deadline']),expression:z.string().max(500),evidence,scopeUnitLabels:z.array(label).min(1).max(20)})).max(6),evidence});
export const meaningSchema=z.strictObject({version:z.literal(1),units:z.array(unitSchema).max(20),relations:z.array(z.strictObject({kind:z.enum(['shared_time','same_target','correction','depends_on','quote_scope']),fromLabel:label,toLabels:z.array(label).min(1).max(20),evidence})).max(60),actions:z.array(actionSchema).max(20),queries:z.array(z.strictObject({label,unitLabel:label,kind:z.enum(['open','day','find','history','capabilities']),text:z.string().max(500).nullable(),dayExpression:z.string().max(500).nullable(),statuses:z.array(z.enum(['open','completed','cancelled'])).max(3),target:target.nullable()})).max(20),groups:z.array(z.strictObject({label,unitLabels:z.array(label).min(1).max(20),actionLabels:z.array(label).max(20),queryLabels:z.array(label).max(20),outcome:z.enum(['execute','needs_choice','respond','capability_unavailable']),reason:z.enum(['target','time','intent','unsupported']).nullable()})).max(10)});
export type MeaningDecision=Readonly<z.infer<typeof meaningSchema>>;
export type SpanRef=Readonly<z.infer<typeof spanSchema>>;
export type ActionDraft=Readonly<z.infer<typeof actionSchema>>;
export type TargetBasis=NonNullable<ActionDraft['target']>;
export function parseMeaning(value:unknown):MeaningDecision{
 const frame=meaningSchema.parse(value);
 const units=new Set(frame.units.map(x=>x.label));
 const nodes=[...frame.units,...frame.actions,...frame.queries,...frame.groups];
 if(new Set(nodes.map(x=>x.label)).size!==nodes.length)throw new Error('MEANING_DUPLICATE_LABEL');
 const requireUnit=(id:string)=>{if(!units.has(id))throw new Error('MEANING_UNKNOWN_UNIT');};
 for(const node of [...frame.actions,...frame.queries])requireUnit(node.unitLabel);
 for(const relation of frame.relations){requireUnit(relation.fromLabel);relation.toLabels.forEach(requireUnit);}
 for(const a of frame.actions)for(const time of a.times)time.scopeUnitLabels.forEach(requireUnit);
 const assigned=new Set<string>();
 for(const group of frame.groups){
  group.unitLabels.forEach(requireUnit);
  for(const [ids,objects] of [[group.actionLabels,frame.actions],[group.queryLabels,frame.queries]] as const)for(const id of ids){
   const obj=objects.find(x=>x.label===id);
   if(!obj||!group.unitLabels.includes(obj.unitLabel)||assigned.has(id))throw new Error('MEANING_GROUP_REFERENCE');
   assigned.add(id);
  }
 }
 if(assigned.size!==frame.actions.length+frame.queries.length)throw new Error('MEANING_UNASSIGNED_ACTION');
 const walk=(x:unknown):void=>{if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(walk);return;}const o=x as Record<string,unknown>;
 if(typeof o.start==='number'&&typeof o.end==='number'&&o.end<=o.start)throw new Error('MEANING_SPAN_RANGE');Object.values(o).forEach(walk);};walk(frame);
 return frame;
}
export const meaningJsonSchema=z.toJSONSchema(meaningSchema,{target:'draft-7'});
