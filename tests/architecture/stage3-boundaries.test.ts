import {test,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(d=>d.isDirectory()?files(join(root,d.name)):[join(root,d.name)]);}
test('Task rules remain independent of providers/surfaces; network belongs to adapters, not guarded preparation',()=>{
 for(const p of files('src/modules/tasks'))expect(readFileSync(p,'utf8'),p).not.toMatch(/openai|max-client|meaning-decision|fetch\(|infrastructure\//iu);
 for(const p of files('src/modules/agent'))expect(readFileSync(p,'utf8'),p).not.toMatch(/fetch\(|from ['"].*infrastructure|SELECT |UPDATE public\./u);
 const root=readFileSync('src/runtime/worker.ts','utf8');expect(root).toContain('config.ASSISTANT_STAGE3_ENABLED?createAssistantRuntime');expect(root).toContain("kind==='button'");
 const coordinator=readFileSync('src/modules/agent/application/turn-coordinator.ts','utf8');expect(coordinator.indexOf('await this.authority.start')).toBeLessThan(coordinator.indexOf('this.provider.decide'));expect(coordinator.indexOf('this.provider.decide')).toBeLessThan(coordinator.indexOf('await this.authority.accept'));
});
