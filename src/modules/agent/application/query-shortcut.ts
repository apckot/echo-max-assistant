import {parseMeaningDraft,type MeaningDraft} from '../../semantic/domain/meaning-decision.js';
/** Only exact explicit UI commands; natural language always retains the whole-utterance path. */
export function queryShortcut(text:string,sourceLabel:string):MeaningDraft|null{
 const commands=new Map<string,'open'|'day'|'capabilities'>([['/tasks','open'],['/today','day'],['/help','capabilities']]);
 const kind=commands.get(text.trim());if(!kind)return null;
 return parseMeaningDraft({version:2,units:[{label:'u1',kind:'query',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence:[{sourceLabel,quote:text}],uncertainty:null}],actions:[],relations:[],queries:[{label:'q1',unitLabel:'u1',kind,text:null,dayExpression:kind==='day'?'сегодня':null,statuses:[],target:null}],groups:[{label:'g1',unitLabels:['u1'],actionLabels:[],queryLabels:['q1'],outcome:'respond',reason:null}]});
}
