import {pathToFileURL} from 'node:url';
export function preflight(env){
 const missing=['MAX_BOT_TOKEN','MAX_WEBHOOK_SECRET','MAX_WEBHOOK_SECRET_VERSION'].filter(k=>!env[k]?.trim());
 if(env.MAX_CANARY_TEST_CONFIRMED!=='true')missing.push('MAX_CANARY_TEST_CONFIRMED');
 if(!/^[1-9][0-9]{0,18}$/.test(env.MAX_CANARY_TEST_USER_ID??''))missing.push('MAX_CANARY_TEST_USER_ID');
 try{const url=new URL(env.MAX_WEBHOOK_URL);if(url.protocol!=='https:'||url.username||url.password)throw Error();}catch{missing.push('MAX_WEBHOOK_URL');}
 return {ready:missing.length===0,missing};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=preflight(process.env);console.log(JSON.stringify({canary:'prepared',...result}));if(!result.ready)process.exitCode=2;
}
