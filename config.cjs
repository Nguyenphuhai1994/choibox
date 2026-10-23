const os=require('node:os');
function localAddresses(){return [...new Set(Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address))];}
function allowedHosts(extra=''){return ['localhost','127.0.0.1','[::1]',os.hostname(),...localAddresses(),...extra.split(',').map(x=>x.trim()).filter(Boolean)];}
function normalizeServerUrl(input){const u=new URL(String(input).trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Nhập địa chỉ máy chủ gốc, ví dụ https://choibox.example.com.');const host=u.hostname;const privateHost=host==='localhost'||host==='127.0.0.1'||host==='[::1]'||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host);if(u.protocol==='http:'&&!privateHost)throw Error('Máy chủ qua Internet phải dùng HTTPS.');return u.origin;}
module.exports={localAddresses,allowedHosts,normalizeServerUrl};
