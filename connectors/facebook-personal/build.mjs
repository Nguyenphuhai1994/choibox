import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const targets=(process.argv.find(a=>a.startsWith('--targets='))?.slice(10)||process.platform+'-'+process.arch).split(',');
const supported=new Set(['darwin-amd64','darwin-arm64','windows-amd64','linux-amd64','linux-arm64']);
const platformName=process.platform==='win32'?'windows':process.platform;
const host=platformName+'-'+(process.arch==='x64'?'amd64':process.arch);
const normalized=targets.map(t=>t===process.platform+'-'+process.arch?host:t.replace('win32-','windows-').replace(/-x64$/,'-amd64'));
fs.mkdirSync(path.join(root,'bin'),{recursive:true});
let manifest={};try{manifest=JSON.parse(fs.readFileSync(path.join(root,'bin','manifest.json'),'utf8'));}catch{}
const go=process.env.GO||'go';
for(const target of normalized){
 if(!supported.has(target))throw Error('Unsupported build target: '+target);
 const [GOOS,GOARCH]=target.split('-'),dir=path.join(root,'bin',target);fs.mkdirSync(dir,{recursive:true});
 const output=path.join(dir,'choibox-facebook'+(GOOS==='windows'?'.exe':''));
 const result=spawnSync(go,['build','-mod=readonly','-trimpath','-ldflags=-s -w','-o',output,'.'],{cwd:root,stdio:'inherit',env:{...process.env,GOOS,GOARCH,CGO_ENABLED:'0'}});
 if(result.status!==0)throw Error('Connector build failed: '+target);
 manifest[target]=createHash('sha256').update(fs.readFileSync(output)).digest('hex');
}
fs.writeFileSync(path.join(root,'bin','manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const dependencies=spawnSync(go,['list','-m','-f','{{.Path}} {{.Version}} {{.Sum}}','all'],{cwd:root,encoding:'utf8'});
if(dependencies.status!==0)throw Error('Cannot produce dependency manifest');
fs.writeFileSync(path.join(root,'dependency-manifest.txt'),dependencies.stdout);
console.log('Built Facebook connector targets: '+normalized.join(', '));
