import type {GroundedMeaning} from '../../src/modules/semantic/application/quote-grounding.js';
import {validateTemporalIntent} from '../../src/modules/semantic/application/temporal-intent.js';
/** Independent assertions for the source fixtures; no Task mutation or date-field repair. */
export function temporalCaseFailures(id:string,g:GroundedMeaning):string[]{
 const failures=validateTemporalIntent(g).issues.map(i=>i.code as string);
 if(!['C016','C034'].includes(id))return failures;
 const d=g.decision,move=d.actions.find(a=>a.kind==='update'),other=d.actions.find(a=>a.kind===(id==='C016'?'complete':'create'));
 if(!move||!other||d.actions.length!==2)return [...failures,'case_action_coverage'];
 const untouched=(a:typeof move)=>a.fields.title===null&&a.fields.description===null&&a.fields.clearFields.length===0;
 if(!untouched(move))failures.push('move_unrequested_field_change');
 if(move.times.length!==1||move.times[0]?.field!=='targetDate'||!/^(?:на\s+)?завтра$/iu.test(move.times[0]?.expression.trim()??''))failures.push('move_exact_targetDate_required');
 if(move.times.some(t=>t.scopeUnitLabels.length!==1||t.scopeUnitLabels[0]!==move.unitLabel))failures.push('move_time_scope');
 // Only Task targetDate may change for this date-only fixture. No invented schedule/deadline/rename/clear.
 if(other.times.length!==0)failures.push('other_action_time_changed');
 if(id==='C016'&&!untouched(other))failures.push('completion_unrequested_field_change');
 if(id==='C034'&&(other.fields.description!==null||other.fields.clearFields.length||other.target!==null))failures.push('purchase_unrequested_field_change');
 const mg=d.groups.find(gr=>gr.actionLabels.includes(move.label)),og=d.groups.find(gr=>gr.actionLabels.includes(other.label));
 if(d.groups.length!==2||!mg||!og||mg.label===og.label||mg.actionLabels.length!==1||og.actionLabels.length!==1||mg.unitLabels.length!==1||og.unitLabels.length!==1||mg.unitLabels[0]!==move.unitLabel||og.unitLabels[0]!==other.unitLabel)failures.push('independent_groups_required');
 if(mg?.outcome!==(id==='C034'?'needs_choice':'execute')||og?.outcome!=='execute')failures.push('independent_group_outcome');
 const pair=new Set([move.unitLabel,other.unitLabel]);
 if(d.relations.some(r=>pair.has(r.fromLabel)&&r.toLabels.some(l=>pair.has(l)&&l!==r.fromLabel)))failures.push('spurious_cross_action_relation');
 if(move.target?.kind==='search'&&move.target.qualifiers.date!==null)failures.push('destination_used_as_target_filter');
 return [...new Set(failures)];
}
