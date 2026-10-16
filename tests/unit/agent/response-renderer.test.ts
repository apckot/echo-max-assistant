import {test,expect} from 'vitest';
import {renderResponse} from '../../../src/modules/agent/application/response-renderer.js';
test('response is bounded across multiple saved queries and anchors only the twenty shown tasks',()=>{
 const items=Array.from({length:50},(_,i)=>({id:'task'+i,version:1,title:'Дело '+i+' '+ 'а'.repeat(490)}));
 const result=renderResponse([{label:'g1',outcome:'respond',receipt:null,reasons:[],queryResults:[{kind:'tasks',day:null,items:items as any,asOf:'2026-09-11T00:00:00Z',nextCursor:'cursor'}]}]);
 expect(result.tasks.length).toBeGreaterThan(0);expect(result.tasks.length).toBeLessThan(20);expect([...result.message.text].length).toBeLessThanOrEqual(4000);expect(result.message.text).toContain('не показан');for(const binding of result.tasks)expect(result.message.text).toContain(items.find(t=>t.id===binding.id)!.title.slice(0,20));expect(result.message.text).not.toContain('Дело '+result.tasks.length+' ');
});
