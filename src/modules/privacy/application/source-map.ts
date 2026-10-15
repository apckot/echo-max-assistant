export interface SourceMap {readonly values:Readonly<Record<string,string>>;readonly sources:Readonly<Record<string,string>>;readonly providerSources:Readonly<Record<string,string>>}
export function rehydrate(text:string,map:SourceMap):string{
 return text.replace(/TOKEN_[A-Za-z0-9_]+/g,token=>{const value=map.values[token];if(value===undefined)throw new Error('UNKNOWN_PRIVACY_TOKEN');return value;});
}
