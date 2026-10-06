import {performance} from 'node:perf_hooks';
export async function drain(counts,expected,{timeoutMs=120000,pollMs=25}={}){
 if(!Number.isInteger(expected)||expected<1)throw Error('Expected positive backlog');
 const started=performance.now();
 for(;;){const c=await counts();if(c.receipts===expected&&c.sent===expected)return performance.now()-started;
  if(performance.now()-started>timeoutMs)throw Error(`backlog boundary: receipts=${c.receipts}/${expected}, sent=${c.sent}/${expected}`);
  await new Promise(r=>setTimeout(r,pollMs));
 }
}
