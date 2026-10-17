import {test,expect} from 'vitest';
import {rFixtures,validateRFixtures} from '../../semantic/r-fixtures.js';
test('all78 public R fixtures materialize input/seeds/context/effects/full final state/unchanged/choices with exact inventory',()=>{
 expect(rFixtures).toHaveLength(78);expect(()=>validateRFixtures(rFixtures.slice(1))).toThrow();expect(()=>validateRFixtures([...rFixtures.slice(1),rFixtures[1]])).toThrow();
 for(const c of rFixtures){expect(c.input.text.length).toBeGreaterThan(0);expect(c.provenance.modelQualityEvidence).toBe(false);for(const t of c.initialTasks)expect(c.expected.unchangedFields[t.ref]).toContain('id');}
 const c=rFixtures.find(c=>c.id==='C034')!;expect(c.expected.effects).toHaveLength(1);expect(c.expected.choices[0]!.alternatives).toHaveLength(2);
 const noDate=rFixtures.find(c=>c.id==='C101')!;expect(noDate.expected.choices).toEqual([]);expect(noDate.proposal.groups[1]!.reason).toBe('missing_destination');
});
