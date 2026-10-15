import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import {preparePrivacy} from '../../src/modules/privacy/application/privacy-gateway.js';
import {groundMeaningDraft} from '../../src/modules/semantic/application/quote-grounding.js';
import type {InternalContextPack} from '../../src/modules/semantic/application/provider-port.js';
export function frame(text:string,kind='create',time?:{field:string;expression:string}){
 const evidence=[{sourceLabel:'S1',quote:text}];
 const pack:InternalContextPack={text,sourceLabel:'S1',sourceAt:'2026-09-11T12:48:33.000Z',timezone:'Europe/Moscow',candidates:[],anchors:[],history:[],pendingChoices:[]};
 const p=preparePrivacy(pack,{externalAllowed:true});if(p.route==='denied')throw Error('privacy');
 const draft=parseMeaningDraft({version:2,units:[{label:'u1',kind:'action',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence,uncertainty:null}],actions:[{label:'a1',unitLabel:'u1',kind,target:kind==='create'?null:{kind:'candidate',label:'T1',evidence},fields:{title:kind==='create'?'Молоко':null,description:null,clearFields:[]},times:time?[{...time,evidence,scopeUnitLabels:['u1']}]:[],evidence}],queries:[],relations:[],groups:[{label:'g1',unitLabels:['u1'],actionLabels:['a1'],queryLabels:[],outcome:'execute',reason:null}]});
 return {grounded:groundMeaningDraft(draft,p.sourceMap),source:pack};
}
