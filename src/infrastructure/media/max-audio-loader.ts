import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request} from 'node:https';
import type {AudioLoader,AudioSource} from '../../modules/media/application/media-service.js';
export type MediaDns=(host:string)=>Promise<readonly {address:string;family:number}[]>;
export type MediaHttp=(url:URL,options:{address:string;family:4|6;headers:Readonly<Record<string,string>>;signal:AbortSignal})=>Promise<{status:number;headers:Readonly<Record<string,string|string[]|undefined>>;body:AsyncIterable<Uint8Array>;cancel?:()=>void}>;
function publicAddress(address:string,family:number):boolean{
 if(isIP(address)!==family)return false;
 if(family===4){const [a,b,c]=address.split('.').map(Number);return !!a&&a<224&&a!==10&&a!==127&&!(a===100&&b!>=64&&b!<=127)&&!(a===169&&b===254)&&!(a===172&&b!>=16&&b!<=31)&&!(a===192&&(b===168||b===0))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);}
 const [first,second]=address.toLowerCase().split(':').map(n=>parseInt(n,16));return first!>=0x2000&&first!<=0x3fff&&first!==0x2002&&!(first===0x2001&&(second!<0x200||second===0xdb8));
}
const nativeHttp:MediaHttp=(url,options)=>new Promise((resolve,reject)=>{
 const req=request(url,{method:'GET',agent:false,headers:options.headers,signal:options.signal,family:options.family,servername:url.hostname,
  lookup:(_host,_options,callback)=>callback(null,options.address,options.family)},res=>resolve({status:res.statusCode??0,headers:res.headers,cancel:()=>{res.destroy();},body:(async function*(){try{for await(const chunk of res)yield new Uint8Array(chunk);}finally{res.destroy();}})()}));
 req.on('error',()=>reject(Error('MEDIA_TRANSPORT')));req.end();
});
export class MaxAudioLoader implements AudioLoader {
 private readonly origins:ReadonlySet<string>;
 constructor(origins:readonly string[],private readonly dns:MediaDns=host=>lookup(host,{all:true,verbatim:true}),private readonly http:MediaHttp=nativeHttp){
  this.origins=new Set(origins.map(origin=>{const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||isIP(url.hostname))throw Error('MEDIA_ORIGIN_INVALID');return url.origin;}));
 }
 async load(source:AudioSource,limitBytes:number,signal:AbortSignal):Promise<Uint8Array>{
  const url=new URL(source.url);if(!Number.isSafeInteger(limitBytes)||limitBytes<1||limitBytes>25000000||url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||!this.origins.has(url.origin))throw Error('MEDIA_ORIGIN_DENIED');
  const addresses=await this.dns(url.hostname);if(signal.aborted||!addresses.length||addresses.some(a=>!publicAddress(a.address,a.family)))throw Error('MEDIA_DNS_DENIED');
  const address=addresses[0]!;const response=await this.http(url,{address:address.address,family:address.family as 4|6,headers:{Accept:'audio/*','Accept-Encoding':'identity'},signal});
  const chunks:Uint8Array[]=[];let size=0;
  try{
   if(response.status!==200||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity')throw Error('MEDIA_RESPONSE_DENIED');
   const length=response.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>limitBytes))throw Error('MEDIA_SIZE');
   for await(const chunk of response.body){if(signal.aborted)throw Error('MEDIA_ABORTED');size+=chunk.length;if(size>limitBytes)throw Error('MEDIA_SIZE');chunks.push(Uint8Array.from(chunk));}
   if(size===0||length!==undefined&&Number(length)!==size)throw Error('MEDIA_SIZE');const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return output;
  }finally{for(const chunk of chunks)chunk.fill(0);await response.body[Symbol.asyncIterator]().return?.();response.cancel?.();}
 }
}
