const {app,BrowserWindow,ipcMain,Menu,dialog,shell,safeStorage}=require('electron');
const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');const {spawn}=require('node:child_process');
const {normalizeServerUrl}=require('./config.cjs');
const root=path.join(__dirname,'..');let workspace=null,tunnel=null,chatWindow=null,launchWindow=null,quitting=false,booting=false,lastNotice='',tunnelBuffer='';
const configRoot=process.env.CHOIBOX_PROFILE_DIR||app.getPath('userData');const cfgFile=path.join(configRoot,'connection.json');
if(process.env.CHOIBOX_PROFILE_DIR){fs.mkdirSync(configRoot,{recursive:true});app.setPath('userData',configRoot);}
process.on('SIGINT',()=>app.quit());process.on('SIGTERM',()=>app.quit());
function readCfg(){try{return JSON.parse(fs.readFileSync(cfgFile,'utf8'));}catch{return {};}}
function saveCfg(c){fs.mkdirSync(configRoot,{recursive:true,mode:0o700});fs.writeFileSync(cfgFile,JSON.stringify(c,null,2),{mode:0o600});}
function defaultDataDir(){if(process.env.DATA_DIR)return process.env.DATA_DIR;if(!app.isPackaged)return path.join(root,'data');return path.join(configRoot,'server-data');}
function bundledConnection(){for(const p of [path.join(root,'choibox-connection.json'),path.join(path.dirname(app.getPath('exe')),'choibox-connection.json')]){try{const c=JSON.parse(fs.readFileSync(p));if(c.app==='Choibox')return normalizeServerUrl(c.serverUrl);}catch{}}return '';}
function isLauncher(event){return launchWindow&&!launchWindow.isDestroyed()&&event.sender.id===launchWindow.webContents.id&&event.sender.getURL().startsWith(pathToFileURL(path.join(__dirname,'launcher.html')).href);}
function cloudflaredPath(){return path.join(app.isPackaged?process.resourcesPath:path.join(root,'build','cloudflared',`${process.platform==='darwin'?'mac':'win'}-${process.arch}`),'cloudflared'+(process.platform==='win32'?'.exe':''));}
function showLauncher(){if(launchWindow&&!launchWindow.isDestroyed()){launchWindow.show();launchWindow.focus();return;}launchWindow=new BrowserWindow({title:'Choibox · Kết nối đội ngũ',width:760,height:790,minWidth:650,minHeight:700,backgroundColor:'#f5f7f3',icon:path.join(root,'public','logo.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});launchWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));launchWindow.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('file:'))e.preventDefault();});launchWindow.loadFile(path.join(__dirname,'launcher.html'));launchWindow.on('closed',()=>{launchWindow=null;});}
async function probe(url){const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok)throw Error('Máy chủ chưa sẵn sàng hoặc địa chỉ chưa đúng.');const d=await r.json();if(d.app!=='Choibox')throw Error('Địa chỉ này không phải máy chủ Choibox.');}
async function startTunnel(c){if(!fs.existsSync(cloudflaredPath()))throw Error('Thiếu thành phần kết nối Internet trong gói ứng dụng.');let token='';if(c.tunnelMode==='named'){if(!c.tokenCipher)throw Error('Nhập Cloudflare Tunnel token cho địa chỉ cố định.');token=safeStorage.decryptString(Buffer.from(c.tokenCipher,'base64'));}
 const args=c.tunnelMode==='named'?['tunnel','--no-autoupdate','run']:['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${c.port}`];
 const tunnelProcess=spawn(cloudflaredPath(),args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...(token?{TUNNEL_TOKEN:token}:{})}});tunnel=tunnelProcess;tunnelBuffer='';
 return new Promise((resolve,reject)=>{let finished=false;const timer=setTimeout(()=>{if(!finished){finished=true;reject(Error('Chưa tạo được kết nối HTTPS. Máy chủ local vẫn dùng được; kiểm tra Internet rồi thử lại.'));}},30000);
  const finish=url=>{if(finished)return;finished=true;clearTimeout(timer);workspace.setPublicUrl(url);resolve(url);};
  const log=chunk=>{const text=chunk.toString();tunnelBuffer=(tunnelBuffer+text).slice(-12000);if(c.tunnelMode==='named'){if(/Registered tunnel connection/.test(tunnelBuffer))finish(normalizeServerUrl(c.publicUrl));}else{const url=tunnelBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(url&&/Registered tunnel connection/.test(tunnelBuffer))finish(url[0]);}};
  tunnel.stdout.on('data',log);tunnel.stderr.on('data',log);tunnel.on('error',()=>{if(!finished){finished=true;clearTimeout(timer);reject(Error('Không khởi động được kết nối Internet.'));}});tunnel.on('exit',()=>{if(tunnel===tunnelProcess){workspace?.setPublicUrl('');tunnel=null;}if(!finished){finished=true;clearTimeout(timer);reject(Error('Kết nối Internet đã dừng. Máy chủ local vẫn hoạt động.'));}});
 });
}
async function stopWorkspace(){if(tunnel){tunnel.kill();tunnel=null;}if(workspace){await new Promise(r=>workspace.server.close(r));workspace.db.close();workspace=null;}}
async function openConnection(raw){if(booting)throw Error('Đang kết nối, vui lòng chờ.');booting=true;try{const old=readCfg();let c={mode:raw.mode,port:Number(raw.port||4317),internet:!!raw.internet,tunnelMode:['named','external'].includes(raw.tunnelMode)?raw.tunnelMode:'quick',dataDir:raw.dataDir||old.dataDir||defaultDataDir()};if(!['server','client'].includes(c.mode))throw Error('Chọn cách sử dụng Choibox.');if(!Number.isInteger(c.port)||c.port<1024||c.port>65535)throw Error('Cổng máy chủ cần từ 1024 đến 65535.');if(raw.tunnelToken){if(!safeStorage.isEncryptionAvailable())throw Error('Hệ điều hành chưa có kho khóa để lưu token an toàn.');c.tokenCipher=safeStorage.encryptString(raw.tunnelToken).toString('base64');}else if(old.tokenCipher)c.tokenCipher=old.tokenCipher;
 if(c.mode==='client'){c.serverUrl=normalizeServerUrl(raw.serverUrl);await probe(c.serverUrl);await stopWorkspace();}
 else {
  if(c.internet&&['named','external'].includes(c.tunnelMode)){c.publicUrl=normalizeServerUrl(raw.publicUrl);if(!c.publicUrl.startsWith('https://'))throw Error('Địa chỉ cố định phải dùng HTTPS.');if(c.tunnelMode==='named'&&!c.tokenCipher)throw Error('Cần Cloudflare Tunnel token.');}
  await stopWorkspace();const {createApp}=await import(pathToFileURL(path.join(root,'server.mjs')).href);workspace=createApp({dataDir:c.dataDir});workspace.db.prepare("UPDATE messages SET status='failed',error=? WHERE status='sending'").run('Ứng dụng dừng khi đang gửi; kiểm tra hộp thư gốc trước khi gửi lại.');
  try{await new Promise((resolve,reject)=>{workspace.server.once('error',reject);workspace.server.listen(c.port,'127.0.0.1',resolve);});}catch{workspace.db.close();workspace=null;throw Error('Cổng này đang được dùng. Dừng bản máy chủ cũ hoặc chọn cổng khác.');}
  c.serverUrl=`http://127.0.0.1:${c.port}`;lastNotice='';if(c.internet)try{if(c.tunnelMode==='external'){workspace.setPublicUrl(c.publicUrl);c.shareUrl=c.publicUrl;lastNotice='Địa chỉ cố định đã cấu hình. Dịch vụ trung chuyển trên VPS và đường kết nối từ máy này cần được chạy bởi người triển khai.';}else c.shareUrl=await startTunnel(c);}catch(e){lastNotice=e.message;if(tunnel){tunnel.kill();tunnel=null;}}
 }
 saveCfg(c);openChat(c.serverUrl);if(launchWindow&&!launchWindow.isDestroyed())launchWindow.close();return {ok:true,notice:lastNotice,shareUrl:c.shareUrl||''};
 }finally{booting=false;}}
async function activateSharedFacebook(){
 try{
  const c=readCfg();if(c.mode!=='server'||!workspace)throw Error('Mở Choibox ở chế độ máy chủ quản trị trước khi kích hoạt.');
  if(booting)throw Error('Choibox đang khởi động, vui lòng chờ.');
  const picked=await dialog.showOpenDialog({title:'Chọn tệp kích hoạt Choibox của khách hàng',properties:['openFile'],filters:[{name:'Kích hoạt Choibox',extensions:['json']}]});if(picked.canceled)return;
  const {parseActivation}=require('./activation.cjs'),activation=parseActivation(fs.readFileSync(picked.filePaths[0],'utf8'));
  const r=await fetch(activation.url+'/v1/status',{headers:{Authorization:'Bearer '+activation.token},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Tệp kích hoạt đã bị thu hồi hoặc dịch vụ chưa sẵn sàng.');
  const status=await r.json();if(status.workspace!==activation.workspace)throw Error('Tệp kích hoạt không khớp khách hàng.');
  const file=path.join(c.dataDir,'connect.json'),old=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  if(old&&JSON.parse(old).workspace!==activation.workspace)throw Error('Máy này đã kích hoạt cho khách hàng khác. Liên hệ quản trị Choibox để chuyển.');
  const confirm=await dialog.showMessageBox({type:'question',title:'Kích hoạt Choibox',message:'Kết nối máy này với '+status.name+'?',detail:'Choibox sẽ mở lại hộp thư. Sau đó bạn có thể đăng nhập Facebook và chọn Page.',buttons:['Kích hoạt','Huỷ'],defaultId:0,cancelId:1});if(confirm.response!==0)return;
  fs.writeFileSync(file,JSON.stringify(activation),{mode:0o600});
  try{await openConnection(c);}catch(e){if(old)fs.writeFileSync(file,old,{mode:0o600});else fs.unlinkSync(file);throw e;}
  await dialog.showMessageBox({type:'info',title:'Đã kích hoạt Choibox',message:'Vào Kênh kết nối → Thêm kênh → Kết nối Facebook.'});
 }catch(e){await dialog.showMessageBox({type:'error',title:'Chưa kích hoạt được Choibox',message:e.message.startsWith('Unexpected')?'Tệp kích hoạt không hợp lệ.':e.message});}
}
function openChat(url){if(chatWindow&&!chatWindow.isDestroyed())chatWindow.close();chatWindow=new BrowserWindow({title:'Choibox',width:1380,height:860,minWidth:800,minHeight:620,backgroundColor:'#f5f7f3',icon:path.join(root,'public','logo.png'),webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'persist:choibox-workspace'}});const origin=new URL(url).origin;chatWindow.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return {action:'deny'};});chatWindow.webContents.on('will-navigate',(e,next)=>{if(new URL(next).origin!==origin)e.preventDefault();});chatWindow.loadURL(url);const currentWindow=chatWindow;chatWindow.on('closed',()=>{if(chatWindow===currentWindow)chatWindow=null;});if(lastNotice)chatWindow.webContents.once('did-finish-load',()=>dialog.showMessageBox(chatWindow,{type:'info',title:'Choibox',message:'Máy chủ local đã chạy',detail:lastNotice}));}
ipcMain.handle('choibox:config',event=>{if(!isLauncher(event))throw Error('Không được phép.');const c=readCfg();return {mode:c.mode||'client',serverUrl:c.serverUrl||bundledConnection(),port:c.port||4317,internet:c.internet??true,tunnelMode:c.tunnelMode||'quick',publicUrl:c.publicUrl||'',dataDir:c.dataDir||defaultDataDir(),hasToken:!!c.tokenCipher,notice:lastNotice};});
ipcMain.handle('choibox:connect',async(event,c)=>{if(!isLauncher(event))throw Error('Không được phép.');return openConnection(c);});
ipcMain.handle('choibox:choose-data',async event=>{if(!isLauncher(event))throw Error('Không được phép.');const r=await dialog.showOpenDialog(launchWindow,{title:'Chọn thư mục dữ liệu Choibox',properties:['openDirectory','createDirectory']});return r.canceled?'':r.filePaths[0];});
if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',()=>{const w=chatWindow||launchWindow;w?.show();w?.focus();});
 app.whenReady().then(async()=>{Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Choibox',submenu:[{label:'Kết nối / Cài đặt máy chủ…',click:showLauncher},{label:'Kích hoạt kết nối Facebook chung…',click:activateSharedFacebook},{label:'Tải lại hộp thư',click:()=>chatWindow?.reload()},{type:'separator'},{role:'quit',label:'Thoát Choibox'}]},{label:'Chỉnh sửa',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'Hiển thị',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));const c=readCfg();if(c.mode){try{await openConnection(c);return;}catch(e){lastNotice=e.message;}}showLauncher();});
 app.on('activate',()=>{if(chatWindow)chatWindow.show();else showLauncher();});
 app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
 app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;stopWorkspace().finally(()=>app.quit());});
}
