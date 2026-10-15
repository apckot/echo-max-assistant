import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
export interface SealedSourceMap {readonly v:1;readonly iv:string;readonly tag:string;readonly body:string;readonly expiresAt:number}
export function sealSourceMap(value:unknown,key:Buffer,expiresAt:number):SealedSourceMap{
 if(key.length!==32||!Number.isSafeInteger(expiresAt))throw Error('MAP_INVALID_KEY_OR_EXPIRY');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(String(expiresAt)));
 const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64'),expiresAt};
}
export function openSourceMap(sealed:SealedSourceMap,key:Buffer,now:number):unknown{
 if(sealed.v!==1||now>=sealed.expiresAt)throw Error('MAP_EXPIRED');
 const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(sealed.iv,'base64'));cipher.setAAD(Buffer.from(String(sealed.expiresAt)));cipher.setAuthTag(Buffer.from(sealed.tag,'base64'));
 return JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.body,'base64')),cipher.final()]).toString('utf8'));
}
