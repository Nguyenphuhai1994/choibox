// Temporary migration bridge for the existing owner's 1.5 desktop only.
// The owner's old desktop still receives on loopback. New customer desktops
// poll Workers directly and do not use this transitional bridge.
import fs from 'node:fs';
import {createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
async function request(url,options={}){const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Unavailable');return r.json();}
export function createLegacyForwarder({activation,appSecret,cloudflareUrl='',transport=request}){
if(!appSecret||!/^[a-f0-9]{48}$/.test(activation?.token||''))throw Error('Missing server configuration');
const headers={Authorization:'Bearer '+activation.token,'Content-Type':'application/json'};
const gateways=['http://127.0.0.1:4320'];
if(cloudflareUrl){
 const url=new URL(cloudflareUrl);
 if(url.origin!=='https://choibox-connect.https-pancake-vn-features-https-pancake.workers.dev'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error('Invalid migration gateway');
 gateways.push(url.origin);
}
let busy=false;
async function poll(){
 if(busy)return;busy=true;
 try{
  // Never consume a shared queue on behalf of a newer desktop: it polls Workers
  // itself and may ignore the old signed-webhook format while returning HTTP 200.
  const health=await transport('http://127.0.0.1:14317/api/health');
  if(health.app!=='Choibox'||health.version!=='1.5.0')return;
  for(const gateway of gateways){try{
  const batch=await transport(gateway+'/v1/events',{headers}),ids=[];
  for(const e of batch.events){
   const body=JSON.stringify({object:'page',entry:[e.entry]}),signature='sha256='+createHmac('sha256',appSecret).update(body).digest('hex');
   try{
    const response=await transport('http://127.0.0.1:14317/webhooks/facebook',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':signature},body});
    const after=await transport('http://127.0.0.1:14317/api/health');
    if(after.app!=='Choibox'||after.version!=='1.5.0')return;
    if(response.ok===true)ids.push(e.id);else break;
   }catch{break;}
  }
  if(ids.length)await transport(gateway+'/v1/events/ack',{method:'POST',headers,body:JSON.stringify({ids})});
 }catch{/* Each gateway retains its batch until the old desktop acknowledges. */}
 }}catch{/* The desktop may be powered off; keep both queues pending. */}finally{busy=false;}
}
return {poll};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const activation=JSON.parse(fs.readFileSync('/var/lib/choibox-connect/owner-activation.json'));
 const bridge=createLegacyForwarder({activation,appSecret:process.env.META_APP_SECRET,cloudflareUrl:process.env.CLOUDFLARE_CONNECT_URL});
 await bridge.poll();setInterval(bridge.poll,5000);
}
