// Profile lookups are optional enrichment. Never construct a public Facebook
// profile URL from a Page-scoped Messenger ID.
export function providerFailure(data,httpStatus){
 const e=data?.error,code=Number(e?.code||e)||null,subcode=Number(e?.error_subcode)||null,message=String(e?.message||'');
 const reason=/must be granted before impersonating|pages_[a-z_]+ permission/i.test(message)?'page_permissions':/appsecret_proof/i.test(message)?'app_configuration':code===190?'authorization':[10,200].includes(code)?'profile_permission':code===100&&subcode===33?'profile_unavailable':'provider_error';
 return Object.assign(new Error('Nền tảng từ chối yêu cầu. Kiểm tra quyền, token và hạn mức nhắn tin.'),{providerCode:code,providerSubcode:subcode,providerReason:reason,httpStatus});
}
export const profileMessages={page_permissions:'Kết nối Page đang thiếu quyền. Quản trị viên cần kết nối lại Facebook và cấp quyền cho Page.',authorization:'Quyền truy cập Facebook đã hết hiệu lực. Quản trị viên cần kết nối lại Page.',app_configuration:'Cấu hình ứng dụng Facebook chưa hợp lệ. Liên hệ quản trị viên Choibox.',profile_permission:'Facebook chưa cấp quyền đọc hồ sơ khách hàng cho ứng dụng.',profile_unavailable:'Facebook chưa cho phép đọc hồ sơ khách này.',provider_error:'Chưa tải được hồ sơ từ nền tảng. Choibox sẽ tự thử lại.',image_unavailable:'Nền tảng chưa trả về ảnh đại diện dùng được.',missing_author:'Facebook chưa trả về thông tin người bình luận.'};
export function customerProfiles({db,decrypt,transport,avatarBytes,profileLink}){
 const get=(s,...p)=>db.prepare(s).get(...p),all=(s,...p)=>db.prepare(s).all(...p),run=(s,...p)=>db.prepare(s).run(...p);
 for(const [name,type] of [['retry_at','INTEGER DEFAULT 0'],['avatar_updated','INTEGER DEFAULT 0'],['profile_status',"TEXT DEFAULT 'pending'"],['profile_reason','TEXT'],['profile_code','INTEGER'],['link_source',"TEXT DEFAULT 'manual'"]])if(!all('PRAGMA table_info(customer_profiles)').some(c=>c.name===name))db.exec(`ALTER TABLE customer_profiles ADD COLUMN ${name} ${type}`);
 const pending=new Map();
 const publicState=id=>{const p=get('SELECT profile_url,phone,address,avatar IS NOT NULL has_avatar,avatar_updated,profile_status,profile_reason,profile_code FROM customer_profiles WHERE conversation_id=?',id)||{};return {...p,profile_message:profileMessages[p.profile_reason]||''};};
 async function profile(c,{force=false}={}){
  if(pending.has(c.id))return pending.get(c.id);
  const ch=get('SELECT * FROM channels WHERE id=?',c.channel_id);if(!ch||ch.mode!=='live'||!ch.enabled||!ch.secret)return;
  const cached=get('SELECT * FROM customer_profiles WHERE conversation_id=?',c.id);
  if(cached?.retry_at>Date.now()&&(!force||cached.checked>Date.now()-15000))return;
  const task=(async()=>{
   run("INSERT INTO customer_profiles(conversation_id,checked,profile_status) VALUES(?,?,'loading') ON CONFLICT(conversation_id) DO UPDATE SET checked=excluded.checked,profile_status='loading'",c.id,Date.now());
   const errors=[];let gotImage=false,gotLink=false,gotName=false;
   try{
    const secret=decrypt(ch.secret);
    const graph=async(path,params={})=>{const u=new URL(`https://graph.facebook.com/${secret.graph_version}/${path}`);u.search=new URLSearchParams(params);return transport(u.href,{headers:{Authorization:'Bearer '+secret.access_token}});};
    const attempt=async fn=>{try{return await fn();}catch(e){errors.push(e);return null;}};
    async function absorb(d,id){
     if(!d||d.id&&String(d.id)!==String(id))return;
     const name=String(d.name||d.display_name||[d.first_name,d.last_name].filter(Boolean).join(' ')).trim().slice(0,200);
     if(name){run('UPDATE conversations SET name=?,version=version+1 WHERE id=? AND name<>?',name,c.id,name);gotName=true;}
     const link=profileLink(d.link||d.profile_url,ch.provider);if(link){run("UPDATE customer_profiles SET profile_url=?,link_source='provider' WHERE conversation_id=? AND (profile_url='' OR link_source='provider')",link,c.id);gotLink=true;}
     const url=d.profile_pic||d.picture?.data?.url||d.avatar;
     if(url&&!d.picture?.data?.is_silhouette){const image=await attempt(()=>avatarBytes(url));if(image){run('UPDATE customer_profiles SET avatar=?,avatar_type=?,avatar_updated=? WHERE conversation_id=?',image.data,image.mime,Date.now(),c.id);gotImage=true;}}
    }
    if(ch.provider==='facebook'){
     let id=c.kind==='comment'?c.contact_id:c.external_id;
     if(c.kind==='comment'&&!/^\d+$/.test(id||'')&&c.comment_id){
      // Backfill historical comments, whose webhook author was not stored in 1.7.0.
      const d=await attempt(()=>graph(encodeURIComponent(c.comment_id),{fields:'from{id,name}'}));
      if(/^\d+$/.test(String(d?.from?.id||''))&&String(d.from.id)!==ch.external_id){id=String(d.from.id);run('UPDATE conversations SET contact_id=? WHERE id=?',id,c.id);await absorb(d.from,id);}
     }
     if(/^\d+$/.test(id||'')){
      // Keep the optional link field separate: an unsupported field must not
      // make a successful avatar response fail.
      if(c.kind!=='comment')await absorb(await attempt(()=>graph(id,{fields:'first_name,last_name,profile_pic'})),id);
      if(!gotImage){const p=await attempt(()=>graph(id+'/picture',{redirect:'false',width:'200',height:'200'}));if(p?.data&&!p.data.is_silhouette)await absorb({picture:{data:p.data}},id);}
      const storedLink=get('SELECT profile_url,link_source FROM customer_profiles WHERE conversation_id=?',c.id);
      if(!storedLink?.profile_url||storedLink.link_source==='provider'){const d=await attempt(()=>graph(id,{fields:'link'}));await absorb({id:d?.id,link:d?.link},id);}
     }else if(!errors.length)errors.push({providerReason:'missing_author'});
    }else{
     const u=new URL('https://openapi.zalo.me/v2.0/oa/getprofile');u.searchParams.set('data',JSON.stringify({user_id:c.external_id}));const d=await attempt(()=>transport(u.href,{headers:{access_token:secret.access_token}}));await absorb(d?.data,c.external_id);
    }
    const saved=get('SELECT avatar,profile_url FROM customer_profiles WHERE conversation_id=?',c.id),complete=!!saved?.avatar;
    const error=errors.find(e=>['page_permissions','authorization','app_configuration'].includes(e.providerReason))||errors.find(e=>e.providerReason)||errors[0];
    const reason=complete?null:error?.providerReason||(gotName||gotLink?'image_unavailable':'provider_error');
    run('UPDATE customer_profiles SET profile_status=?,profile_reason=?,profile_code=?,retry_at=? WHERE conversation_id=?',complete?'ready':'unavailable',reason,Number(error?.providerCode)||null,Date.now()+(complete?86400000:60000),c.id);
   }catch{try{run("UPDATE customer_profiles SET profile_status='unavailable',profile_reason='provider_error',retry_at=? WHERE conversation_id=?",Date.now()+60000,c.id);}catch{/* workspace closed */}}
  })();pending.set(c.id,task);try{await task;}finally{pending.delete(c.id);}
 }
 return {profile,publicState};
}
