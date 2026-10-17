import type {agentFixture} from '../support/agent-fixture.js';
import {rFixtures} from './r-fixtures.js';
import {collectApplication,materializedCase,type CollectorMode} from './application-collector.js';
import {runCorpus} from './corpus-runner.js';
import {qualificationReport} from './qualification-report.js';
/** Port-injected application collector, no key/config/provider construction and no external dispatch on import. */
export async function collectRCorpus(fixture:Awaited<ReturnType<typeof agentFixture>>,mode:CollectorMode={kind:'typed_mechanism'}){
 const execution=mode.kind==='provider'?mode.execution??'fake':'fake',cases=rFixtures.map(c=>materializedCase(c,execution));
 const rows=await runCorpus(cases,async c=>{const source=rFixtures.find(s=>s.id===c.id)!;return (await collectApplication(fixture,source,mode)).observation;});
 return {boundary:mode.kind,modelQualityEvidence:execution==='real',rows,qualification:qualificationReport(rows,undefined,{cases,frozen:true})};
}
