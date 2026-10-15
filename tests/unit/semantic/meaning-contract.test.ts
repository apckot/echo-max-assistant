import {expect,test} from 'vitest';
import {meaningSchema,parseMeaning} from '../../../src/modules/semantic/domain/meaning-decision.js';
const span={sourceLabel:'S0',start:0,end:12,quote:'Купить хлеба'};
const unit={label:'u1',kind:'action',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence:[span],uncertainty:null};
const action={label:'a1',unitLabel:'u1',kind:'create',target:null,fields:{title:'Купить хлеба',description:null,clearFields:[]},times:[],evidence:[span]};
const frame=()=>({version:1,units:[unit],relations:[],actions:[action],queries:[],groups:[{label:'g1',unitLabels:['u1'],actionLabels:['a1'],queryLabels:[],outcome:'execute',reason:null}]});
test('strict schema rejects arbitrary command fields and 21 actions',()=>{
 expect(meaningSchema.safeParse({...frame(),sql:'UPDATE'}).success).toBe(false);
 expect(meaningSchema.safeParse({...frame(),actions:Array(21).fill(action)}).success).toBe(false);
});
test('unknown references, duplicate labels and unassigned actions are invalid before any execution',()=>{
 expect(()=>parseMeaning({...frame(),actions:[{...action,unitLabel:'missing'}]})).toThrow();
 expect(()=>parseMeaning({...frame(),units:[unit,unit]})).toThrow();
 expect(()=>parseMeaning({...frame(),groups:[]})).toThrow();
 expect(()=>parseMeaning({...frame(),relations:[{kind:'depends_on',fromLabel:'u1',toLabels:['missing'],evidence:[span]}]})).toThrow();
});
test('negative quoted units are represented without manufacturing actions',()=>{
 const f=frame();expect(parseMeaning({...f,units:[{...unit,polarity:'negative',speechAct:'quote',authoredByOwner:false}],actions:[],groups:[{...f.groups[0],actionLabels:[],outcome:'respond'}]}).actions).toEqual([]);
});
test('evidence indices are Unicode code points and invalid ranges fail',()=>{
 expect(()=>parseMeaning({...frame(),units:[{...unit,evidence:[{...span,start:5,end:2}]}]})).toThrow();
 expect(parseMeaning(frame()).version).toBe(1);
});
