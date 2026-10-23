// Zalo's built-in emoji are text; native stickers carry a sticker ID and/or image URLs.
function object(value){if(value&&typeof value==='object'&&!Array.isArray(value))return value;if(typeof value==='string'&&value.length<16000){try{const d=JSON.parse(value);if(d&&typeof d==='object'&&!Array.isArray(d))return d;}catch{}}return {};}
export function zaloContent(data){
 const raw=data.content,c=object(raw),params=object(c.params),type=String(data.msgType||'');
 if(type!=='chat.sticker'&&typeof raw==='string')return {body:raw,kind:'text',sources:[]};
 if(type==='webchat')return {body:String(c.text||c.msg||c.title||'[Tin nhắn]'),kind:'text',sources:[]};
 const sticker=type==='chat.sticker',kind=sticker?'sticker':['chat.photo','chat.doodle'].includes(type)?'image':['chat.gif'].includes(type)?'gif':['chat.video','chat.video.msg'].includes(type)?'video':['share.file','chat.file'].includes(type)?'file':'other';
 const label={sticker:'[Sticker]',image:'[Ảnh đính kèm]',gif:'[GIF]',video:'[Video đính kèm]',file:'[Tệp đính kèm]',other:'[Nội dung đính kèm]'}[kind];
 const rawId=c.id??c.stickerId??c.sticker_id??params.id??params.stickerId??params.sticker_id;
 const stickerId=/^\d{1,12}$/.test(String(rawId||''))&&Number.isSafeInteger(Number(rawId))?Number(rawId):null;
 const sources=[...new Set([c.stickerWebpUrl,c.stickerUrl,c.url,c.href,c.thumb,params.stickerWebpUrl,params.stickerUrl,params.url,params.href].filter(v=>typeof v==='string'&&v.length<8000))];
 return {body:label+(c.title?' '+String(c.title).slice(0,500):''),kind,stickerId,sources};
}
