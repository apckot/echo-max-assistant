import {test,expect} from 'vitest';
import {queryShortcut} from '../../../src/modules/agent/application/query-shortcut.js';
test('prototype property names and ordinary words never enter explicit shortcut parsing',()=>{
 for(const input of ['constructor','toString','__proto__','hasOwnProperty','open','/today extra'])expect(queryShortcut(input,'S1')).toBeNull();
 for(const input of ['/tasks','/today','/help'])expect(queryShortcut(input,'S1')?.queries).toHaveLength(1);
});
