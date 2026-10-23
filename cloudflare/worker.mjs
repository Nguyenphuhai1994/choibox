import {DurableObject} from 'cloudflare:workers';
import {createBroker} from './core.mjs';

export class ChoiboxBroker extends DurableObject {
 constructor(ctx,env){
  super(ctx,env);
  const sql=ctx.storage.sql;
  const db={
   exec(statement){sql.exec(statement);},
   prepare(statement){return {
    get(...args){return sql.exec(statement,...args).toArray()[0];},
    all(...args){return sql.exec(statement,...args).toArray();},
    run(...args){const cursor=sql.exec(statement,...args);return {changes:cursor.rowsWritten};}
   };}
  };
  this.broker=createBroker({
   db,transaction:fn=>ctx.storage.transactionSync(fn),
   encryptionKey:env.DATA_ENCRYPTION_KEY,adminToken:env.ADMIN_TOKEN,
   publicUrl:env.PUBLIC_URL,appId:env.META_APP_ID,appSecret:env.META_APP_SECRET,
   verifyToken:env.META_VERIFY_TOKEN,configId:env.META_CONFIG_ID||'',
   graphVersion:env.META_GRAPH_VERSION||'v25.0'
  });
 }
 async fetch(request){
  // Schedule before processing so cleanup survives a disconnected client.
  if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+3600000);
  return this.broker.handle(request);
 }
 async alarm(){
  this.broker.prune();
  await this.ctx.storage.setAlarm(Date.now()+3600000);
 }
}

export default {
 async fetch(request,env){
  try{
   const url=new URL(request.url);
   if(url.protocol!=='https:'&&url.hostname!=='localhost'&&url.hostname!=='127.0.0.1')
    return new Response('HTTPS required',{status:400});
   const response=await env.BROKER.get(env.BROKER.idFromName('choibox-connect-v1')).fetch(request);
   const headers=new Headers(response.headers);headers.set('X-Choibox-Connect','cloudflare');headers.set('X-Choibox-Connect-Build','2026-10-22-oauth-redirect-fix');
   return new Response(response.body,{status:response.status,headers});
  }catch{
   // Do not expose exception details containing provider URLs or credentials.
   return Response.json({error:'Dịch vụ kết nối chưa sẵn sàng.'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
 }
};
