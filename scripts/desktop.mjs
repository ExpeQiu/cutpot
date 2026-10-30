import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(root,'bin','cutpot-cli.js');
const python=path.join(root,'.cutpot','subtitle-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const env={...process.env,...(existsSync(python)?{CUTPOT_SUBTITLE_PYTHON:python}:{})};
function execute(command,args,{capture=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,env,stdio:capture?['ignore','pipe','pipe']:'inherit'});
    let out='',err='';if(capture){child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);}
    child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error(err||`${command} exited ${code}`)));
  });
}
try{
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('需要 Node.js 22 或更新版本');
  if(process.argv[2]==='check'){
    await execute(process.execPath,[cli,'doctor']);
    const test=path.join(root,'.cutpot','subtitle-check.json');
    const {writeFile,rm,mkdir}=await import('node:fs/promises');
    await mkdir(path.dirname(test),{recursive:true});
    await writeFile(test,JSON.stringify({width:1280,height:720,clips:[{text:'中文字幕安装检查',file:`${test}.png`}]}));
    try{await execute(env.CUTPOT_SUBTITLE_PYTHON||'python3',[path.join(root,'scripts','render-subtitles.py'),test]);}
    finally{await rm(test,{force:true});await rm(`${test}.png`,{force:true});}
    console.log('依赖检查通过：视频编码、字幕字体和 Pillow 均可用。');
  }else if(process.argv[2]==='start'){
    const result=JSON.parse(await execute(process.execPath,[cli,'start','--data',path.join(root,'.cutpot'),'--json'],{capture:true}));
    console.log(`CutPot 已启动：${result.url}\n数据目录：${result.dataDir}`);
    if(!process.env.CUTPOT_NO_BROWSER){
      if(process.platform==='darwin')await execute('open',[result.url]);
      else if(process.platform==='win32')await execute('rundll32.exe',['url.dll,FileProtocolHandler',result.url]);
      else await execute('xdg-open',[result.url]);
    }
  }else throw new Error('用法：node scripts/desktop.mjs check|start');
}catch(e){console.error(e.message);process.exitCode=1;}
