/** Evidence ledger projection only: booleans must refer to retained, scoped actual evidence, never fake substitutes. */
export function stage3Acceptance(e:Partial<Record<'automatic'|'review'|'load'|'callback'|'codec'|'semantic'|'audio'|'maxConversation'|'localPreparation',boolean>>){
 const automatic=['automatic','review','load','localPreparation'] as const,external=['callback','codec','semantic','audio','maxConversation'] as const;
 const codeReady=automatic.every(k=>e[k]===true),open=external.filter(k=>e[k]!==true);return {openLocal:e.localPreparation===true?[]:['localPreparation'],codeReady,stageComplete:codeReady&&open.length===0,open};
}
