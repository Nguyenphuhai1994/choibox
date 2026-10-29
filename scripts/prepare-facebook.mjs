import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
export function prepareConnector(root,platform=process.platform,arch=process.arch){
 const target=(platform==='win32'?'windows':platform)+'-'+(arch==='x64'?'amd64':arch);
 const folder=path.join(root,'connectors/facebook-personal/bin'),name='choibox-facebook'+(platform==='win32'?'.exe':'');
 const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8')),expected=manifest[target];
 if(!/^[a-f0-9]{64}$/.test(expected||'')){console.log('Chưa có bộ kết nối Facebook cá nhân cho '+target+'. Biên dịch từ connectors/facebook-personal/README.md; Page và Zalo vẫn chạy.');return false;}
 const binary=path.join(folder,target,name),compressed=binary+'.gz';
 const hash=b=>createHash('sha256').update(b).digest('hex');
 if(fs.existsSync(binary)&&hash(fs.readFileSync(binary))===expected){if(platform!=='win32')fs.chmodSync(binary,0o755);console.log('Facebook connector '+target+': verified');return true;}
 if(!fs.existsSync(compressed))throw Error('Missing connector artifact: '+target);
 if(fs.statSync(compressed).size>32*1024**2)throw Error('Connector archive is too large');
 const bytes=gunzipSync(fs.readFileSync(compressed),{maxOutputLength:64*1024**2});
 if(hash(bytes)!==expected)throw Error('Connector checksum mismatch; existing binary was preserved');
 const temp=binary+'.tmp-'+process.pid+'-'+randomBytes(6).toString('hex');
 let fd;
 try{fd=fs.openSync(temp,'wx',0o755);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,binary);}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 console.log('Facebook connector '+target+': prepared and verified');return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{prepareConnector(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));}catch(e){console.error(e.message);process.exitCode=1;}
}
