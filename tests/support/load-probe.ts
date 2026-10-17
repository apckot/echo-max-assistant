import {Pool} from 'pg';
/** Dedicated read-only diagnostics: server-side cancellation bounds execution, client bounds connection. */
export function loadQueueProbe(connectionString:string){
 const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:500,options:'-c statement_timeout=500 -c lock_timeout=250 -c default_transaction_read_only=on'});
 let pending:Promise<unknown>|undefined;
 return {
  sample(sql="SELECT state,count(*)::int n FROM conversation_work GROUP BY state"){
   if(pending)return pending;
   pending=(async()=>{const client=await pool.connect();let destroy=false;try{return (await client.query({text:sql,query_timeout:750})).rows;}catch(error){destroy=true;throw error;}finally{client.release(destroy);}})().finally(()=>{pending=undefined;});return pending;
  },
  async close(){await pending?.catch(()=>{});await pool.end();}
 };
}
