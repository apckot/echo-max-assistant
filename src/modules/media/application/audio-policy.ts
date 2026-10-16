export const audioDisclosure='Для распознавания OpenAI получает саму аудиозапись, включая содержание и особенности голоса. Проверка формата не обнаруживает все персональные данные. Нужны отдельное согласие и собственная диктовка без запрещённых данных и неразрешённых третьих лиц.';
export interface AudioConsent {readonly revision:number;readonly policyVersion:number;readonly processor:'openai';readonly granted:boolean;readonly disclosureAccepted:boolean;readonly ownDictation:boolean;readonly noProhibitedData:boolean;readonly noUnconsentedThirdParties:boolean;readonly revoked:boolean}
export interface AudioProfile {readonly version:number;readonly externalAllowed:boolean;readonly regionAllowed:boolean;readonly categoryAllowed:boolean;readonly retentionAllowed:boolean;readonly requiresContentAnalysis:boolean}
export type AudioRoute={readonly allowed:true}|{readonly allowed:false;readonly reason:'profile'|'consent'|'declaration'|'content_analysis_required'};
export function audioRoute(consent:AudioConsent|null,profile:AudioProfile):AudioRoute{
 if(profile.requiresContentAnalysis!==false)return {allowed:false,reason:'content_analysis_required'};
 if(!Number.isInteger(profile.version)||profile.version<1||profile.externalAllowed!==true||profile.regionAllowed!==true||profile.categoryAllowed!==true||profile.retentionAllowed!==true)return {allowed:false,reason:'profile'};
 if(!consent||!Number.isInteger(consent.revision)||consent.revision<1||consent.policyVersion!==profile.version||consent.processor!=='openai'||consent.granted!==true||consent.disclosureAccepted!==true||consent.revoked!==false)return {allowed:false,reason:'consent'};
 if(consent.ownDictation!==true||consent.noProhibitedData!==true||consent.noUnconsentedThirdParties!==true)return {allowed:false,reason:'declaration'};
 return {allowed:true};
}
