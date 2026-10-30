import { workflowCommand } from './workflow-cli.js';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { readFile, writeFile, mkdir, open, stat, rm, rename, copyFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultProject, validateProject, autoArrange } from './project.js';
import { timelineDuration } from '../public/timeline.js';
import { probe, run } from './render.js';
import { ManifestIssue, manifestSchema, validateManifestFile, dryRunManifest } from './manifest.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '0.9.0';
const apiVersion = 1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const definitions = {
  'authorize-live':{type:'boolean'},
  json:{type:'boolean',short:'j'}, help:{type:'boolean',short:'h'}, version:{type:'boolean',short:'v'},
  url:{type:'string'}, port:{type:'string'}, data:{type:'string'}, force:{type:'boolean',short:'f'},
  output:{type:'string',short:'o'}, name:{type:'string'}, fps:{type:'string'}, resolution:{type:'string'},
  duration:{type:'string'}, in:{type:'string'}, title:{type:'string'}, subtitle:{type:'string'}, asset:{type:'string'},
  at:{type:'string'}, to:{type:'string'}, 'keep-audio':{type:'boolean'}, mute:{type:'boolean'},
  lock:{type:'boolean'}, unlock:{type:'boolean'}, narration:{type:'string'}, music:{type:'string'},
  'music-volume':{type:'string'}, 'no-wait':{type:'boolean'}, timeout:{type:'string'}, 'dry-run':{type:'boolean'},
  provider:{type:'string'}, voice:{type:'string'}, speed:{type:'string'}, text:{type:'string'}, file:{type:'string'}, attach:{type:'boolean'},
  preset:{type:'string'},category:{type:'string'},
  target:{type:'string'},style:{type:'string'},endpoint:{type:'string'},'reference-audio':{type:'string'},'prompt-text':{type:'string'},'age-group':{type:'string'},'character-id':{type:'string'},'character-name':{type:'string'},dialogue:{type:'string'},'burn-subtitles':{type:'boolean'},
};
const commands = {
  'workflow show':[], 'workflow apply':['authorize-live'], 'workflow generate':['authorize-live'],
  'workflow wait':['timeout'], 'workflow handoff':[],
  start: ['port','data'], serve:['port','data'], stop:['force'], status:[], doctor:[], probe:[],
  capabilities:[], 'schema manifest':[], validate:[],
  'project show':[], 'project new':['name','fps','resolution','force'], 'project save':['force'], 'project open':['force'],
  'assets list':[], 'assets import':[], 'clip list':[],
  'clip add':['duration','in','title','subtitle','at','keep-audio','mute','lock'],
  'clip edit':['duration','in','title','subtitle','asset','keep-audio','mute','lock','unlock'],
  'clip remove':[], 'clip duplicate':[], 'clip move':['to'], arrange:[],
  'audio set':['narration','music','music-volume'],
  export:['output','force','no-wait','timeout','burn-subtitles'],
  compose:['output','force','no-wait','timeout','burn-subtitles','fps','resolution','name','duration','keep-audio','mute','narration','music','music-volume'],
  render:['output','force','no-wait','timeout','burn-subtitles','dry-run'], jobs:[], job:[], 'job wait':['timeout'], cancel:[], download:['output','force'],
  'tts providers':[], 'tts voices':['provider','category'], 'tts generate':['provider','voice','preset','speed','target','style','text','file','dialogue','name','output','force','no-wait','timeout','attach'],
  'tts config':[], 'tts configure':['endpoint','reference-audio','prompt-text','age-group','character-id','character-name'],
  'tts jobs':[], 'tts job':[], 'tts cancel':[], 'tts download':['output','force'],
};

export const help = `CutPot CLI ${version} — 本地视频编辑、合成与导出

用法：cutpot-cli <命令> [参数] [选项]

服务
  start [--port 4317] [--data DIR]     后台启动；编辑/导出命令也会按需启动
  serve [--port 4317] [--data DIR]     前台运行工作台，Ctrl+C 停止
  status | stop [--force]              查询 / 停止本地服务
  doctor | probe FILE                  检查依赖 / 读取素材参数
  capabilities [--json]                返回 CLI/API/清单能力与依赖就绪状态
  schema manifest [--json]             版本化清单字段定义与示例

创作工作流（分镜图 → 首尾帧视频 → 剪辑）
  workflow show                       查看分镜、首尾帧片段、候选版本与生成任务
  workflow apply ACTION.json           执行单个工作流操作；真实生成需 --authorize-live
  workflow generate image|video all|ID... [--authorize-live]
                                      排队生成分镜图 / 首尾帧视频，返回新增任务 ID
  workflow wait ID... [--timeout SEC]  等待指定生成任务；超时不取消远端任务
  workflow handoff                    将已选视频版本送入剪辑

工程与素材
  project show                        查看当前工程、镜头与音轨
  project new --name NAME [--force]    创建空工程（替换已有时间线需 --force）
  project save FILE [--force]          保存工程 JSON（引用本机素材库）
  project open FILE [--force]          打开已保存的工程 JSON
  assets import FILE...               导入视频 / 图片 / 音频，返回素材 ID
  assets list                         列出素材及 ID

编辑当前时间线（镜头以从 1 开始的序号或完整 ID 指定）
  clip list
  clip add ASSET [--duration SEC] [--in SEC] [--at N] [--subtitle TEXT]
  clip edit CLIP [--asset ASSET] [--duration SEC] [--in SEC] [--title TEXT]
                 [--subtitle TEXT] [--keep-audio | --mute] [--lock | --unlock]
  clip move CLIP --to N | clip duplicate CLIP | clip remove CLIP
  arrange                             按分镜编号排序，保留锁定位置
  audio set [--narration ASSET|none] [--music ASSET|none] [--music-volume 0.12]

自动配音
  tts providers | tts voices [--provider macos|edge|gpt-sovits] [--category child]
  tts config | tts configure --reference-audio FILE --prompt-text TEXT --age-group child
      [--endpoint http://127.0.0.1:9880] [--character-id lele --character-name 乐乐]
  tts generate --text TEXT | --file script.txt | --dialogue dialogue.json
      [--provider macos|edge|gpt-sovits] [--voice VOICE] [--speed 1] [-o voice.wav] [--attach]
      [--preset natural|child-bright|child-soft] 童声风格为调音效果，非原生儿童音色
      [--target child] 原生儿童模式，禁止成人音色和变调；[--style neutral] 语气来自参考录音
  tts jobs | tts job ID | tts cancel ID | tts download ID -o voice.wav
  默认 macOS 本地中文语音；GPT-SoVITS 使用本机开源服务；Edge 为在线服务。

合成与导出
  compose FILE... -o film.mp4          按文件顺序直接合成，不替换当前时间线
      [--duration SEC] [--narration FILE] [--music FILE] [--keep-audio]
  validate MANIFEST.json               执行前检查清单（不导入、不改工作台）
  render MANIFEST.json -o film.mp4     按含本地文件路径的镜头清单合成
  render MANIFEST.json --dry-run       预览帧量化计划与阻塞项，不导入不渲染
  export -o film.mp4 [--burn-subtitles] 导出当前时间线；可将字幕直接烧录至画面
  jobs | job ID | job wait ID | cancel ID  查询 / 等待 / 取消任务
  download ID -o film.mp4              下载已完成任务（也支持服务重启前的 ID）

通用：--json / -j 为脚本输出 JSON；进度写入 stderr；失败退出码为 1。
      错误 JSON 含 error / code / retryable，可能含 clip / field。
      --url http://127.0.0.1:4317 或 CUTPOT_URL 指定本地服务。
输出：MP4 + 同名 .srt / .project.json / .report.json；覆盖需 --force。
格式：--resolution 1920x1080|1280x720|1080x1920；--fps 24|25|30。
导出：--no-wait 仅提交任务；job wait ID 等待已有任务；--timeout SEC 超时取消；Ctrl+C 取消等待中的导出。
清单格式与完整示例：${path.join(workspace,'docs','cutpot-cli.md')}
`;

function number(value, label, { min=0, max=Infinity, integer=false }={}) {
  const n=Number(value);
  if(value==='' || !Number.isFinite(n) || n<min || n>max || integer&&!Number.isInteger(n)) throw new Error(`${label} 数值无效`);
  return n;
}
function outputSettings(project, options) {
  if(options.fps!==undefined)project.fps=number(options.fps,'帧率');
  if(options.resolution!==undefined){
    const match=/^(\d+)x(\d+)$/.exec(options.resolution);
    if(!match)throw new Error('分辨率应写为 1920x1080、1280x720 或 1080x1920');
    project.width=Number(match[1]);project.height=Number(match[2]);
  }
  if(options.name!==undefined)project.name=options.name;
  if(options['music-volume']!==undefined)project.musicVolume=number(options['music-volume'],'音乐音量',{max:1});
  return project;
}
function localURL(value) {
  const url=new URL(value);
  if(url.protocol!=='http:' || !['localhost','127.0.0.1'].includes(url.hostname) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('--url 仅支持 http://127.0.0.1:端口 或 http://localhost:端口');
  return url.origin;
}
async function request(base, route, options={}) {
  const res=await fetch(`${base}${route}`,{signal:AbortSignal.timeout(30000),...options});
  const text=await res.text();let data;
  try{data=JSON.parse(text);}catch{throw new Error('目标端口不是兼容的 CutPot 服务');}
  if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);
  return data;
}
const send=(base,route,data,method='POST',headers={})=>request(base,route,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
async function health(base) {
  const data=await request(base,'/api/health',{signal:AbortSignal.timeout(1500)});
  if(data.app!=='cutpot'||data.apiVersion!==1)throw new Error('目标端口不是兼容的 CutPot 服务');
  return data;
}
async function start(base, dataDir) {
  try{
    const running=await health(base);
    if(dataDir&&path.resolve(dataDir)!==running.dataDir)throw new Error('此端口已使用其他数据目录；请选择另一个 --port');
    return running;
  }catch(e){
    if(e.message.includes('此端口') || e.message.includes('不是兼容'))throw e;
    if(e.cause?.code!=='ECONNREFUSED')throw new Error(`无法连接服务：${e.message}`);
  }
  const root=path.resolve(dataDir||process.env.CUTPOT_DATA||path.join(workspace,'.cutpot'));
  await mkdir(root,{recursive:true});
  const log=await open(path.join(root,'server.log'),'a');
  const child=spawn(process.execPath,[path.join(workspace,'src/server.js')],{
    detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,PORT:new URL(base).port||'80',CUTPOT_DATA:root},
  });
  let startupError;child.once('error',e=>startupError=e);child.unref();await log.close();
  for(let i=0;i<100;i++){
    if(startupError)throw startupError;
    try{const result=await health(base);if(result.dataDir!==root)throw new Error('端口被其他数据目录的 CutPot 占用');return result;}
    catch(e){if(e.message.includes('占用')||e.message.includes('不是兼容'))throw e;}
    if(child.exitCode!==null)break;
    await sleep(100);
  }
  throw new Error(`服务启动失败，请查看 ${path.join(root,'server.log')}`);
}
async function connect(base){try{return await health(base);}catch(e){if(e.cause?.code==='ECONNREFUSED')return start(base);throw e;}}

function resolveAsset(assets, value) {
  const matches=assets.filter(a=>a.id===value||a.name===value);
  if(matches.length!==1)throw new Error(matches.length?'素材名称重复，请使用完整 ID':`找不到素材：${value}`);
  return matches[0];
}
function resolveClip(project,value) {
  const index=/^\d+$/.test(value)?Number(value)-1:project.clips.findIndex(c=>c.id===value);
  if(index<0||index>=project.clips.length)throw new Error(`找不到镜头：${value}`);
  return index;
}
function newClip(asset, options={}, fps=25) {
  if(!['image','video'].includes(asset.type))throw new Error('音频素材应使用 audio set 配置');
  const sourceIn=number(options.in??0,'素材入点');
  const duration=options.duration!==undefined?number(options.duration,'镜头时长',{min:1/fps}):asset.type==='image'?3:Math.floor((asset.duration-sourceIn)*fps+1e-6)/fps;
  return {id:randomUUID(),assetId:asset.id,title:options.title??asset.name,duration,sourceIn,subtitle:options.subtitle??'',muted:!options['keep-audio'],locked:options.lock===true};
}
function lockCheck(clip){if(clip.locked)throw new Error('镜头已锁定，请先 clip edit CLIP --unlock');}
async function upload(base,file) {
  const absolute=path.resolve(file),info=await stat(absolute);
  if(!info.isFile()||info.size>1024**3)throw new Error(`素材必须是文件，且不超过 1 GB：${file}`);
  return request(base,`/api/assets/upload?name=${encodeURIComponent(path.basename(file))}`,{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:createReadStream(absolute),duplex:'half',signal:AbortSignal.timeout(30*60*1000),
  });
}
async function saveProject(base,state,project) {
  const validated=validateProject(project,state.assets);
  return send(base,'/api/project',validated,'PUT',{'If-Match':state.projectRevision});
}
async function exists(file){try{await stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function atomicWrite(file,data,force=false){
  const target=path.resolve(file);await mkdir(path.dirname(target),{recursive:true});
  if(!force){await writeFile(target,data,{flag:'wx'});return;}
  const temp=`${target}.${randomUUID()}.partial`;
  try{await writeFile(temp,data);await rename(temp,target);}finally{await rm(temp,{force:true});}
}
function destinations(output){
  if(!output||path.extname(output).toLowerCase()!=='.mp4')throw new Error('请通过 -o / --output 指定 .mp4 输出文件');
  const mp4=path.resolve(output),stem=mp4.slice(0,-4);
  return [['film.mp4',mp4],['subtitles.srt',`${stem}.srt`],['project.json',`${stem}.project.json`],['report.json',`${stem}.report.json`]];
}
async function checkDestinations(options){const files=destinations(options.output);for(const [,file]of files)if(!options.force&&await exists(file))throw new Error(`输出已存在，覆盖需 --force：${file}`);return files;}
async function downloadJob(base,id,options) {
  if(!/^[a-f\d-]{36}$/i.test(id))throw new Error('任务 ID 无效');
  const files=await checkDestinations(options),tempFiles=[];
  try{
    for(const [source,target] of files){
      const res=await fetch(`${base}/api/exports/${id}/${source}`,{signal:AbortSignal.timeout(30*60*1000)});
      if(!res.ok)throw new Error(`无法下载 ${source}，请确认任务已完成`);
      await mkdir(path.dirname(target),{recursive:true});
      const temp=`${target}.${randomUUID()}.partial`;tempFiles.push([temp,target]);
      await pipeline(Readable.fromWeb(res.body),createWriteStream(temp,{flags:'wx'}));
    }
    for(const [temp,target]of tempFiles){if(options.force)await rename(temp,target);else{await copyFile(temp,target,constants.COPYFILE_EXCL);await rm(temp);}}
    return {id,output:files[0][1],subtitles:files[1][1],project:files[2][1],report:files[3][1]};
  }finally{for(const [temp]of tempFiles)await rm(temp,{force:true});}
}
function cliError(message,{code='ERROR',clip=null,field=null,retryable=false,exitCode=1}={}){
  const e=new Error(message);e.code=code;e.clip=clip;e.field=field;e.retryable=retryable;e.exitCode=exitCode;return e;
}
function errorPayload(e){
  if(e instanceof ManifestIssue)return e.toJSON();
  return {
    error:e.message,
    code:e.code||'ERROR',
    ...(e.clip!=null?{clip:e.clip}:{}),
    ...(e.field?{field:e.field}:{}),
    retryable:Boolean(e.retryable),
  };
}
async function waitExportJob(base,jobId,options,{download=true}={}){
  const timeout=options.timeout!==undefined?number(options.timeout,'超时秒数',{min:.1}):null;
  let interrupted=false,lastMessage='';
  const interrupt=()=>{interrupted=true;};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const started=Date.now();
  try{
    while(true){
      const jobs=await request(base,'/api/jobs'),status=jobs.find(j=>j.id===jobId);
      if(!status)throw cliError('服务重启或任务不存在，请检查导出目录',{code:'JOB_MISSING',retryable:true});
      if(status.message!==lastMessage){process.stderr.write(`[${status.progress}%] ${status.message}\n`);lastMessage=status.message;}
      if(status.status==='completed')return download&&options.output?{...await downloadJob(base,jobId,options),status:'completed'}:{...status,status:'completed'};
      if(status.status==='failed')throw cliError(status.message,{code:'JOB_FAILED',retryable:false});
      if(status.status==='cancelled')throw cliError(status.message,{code:'JOB_CANCELLED',retryable:false});
      if(interrupted||timeout!==null&&Date.now()-started>timeout*1000){
        const cancelled=await send(base,`/api/jobs/${jobId}/cancel`,{});
        if(cancelled.status==='completed')return download&&options.output?{...await downloadJob(base,jobId,options),status:'completed'}:{...cancelled,status:'completed'};
        const error=cliError(interrupted?'已请求取消导出':'等待超时，已请求取消导出',{code:interrupted?'JOB_INTERRUPTED':'JOB_TIMEOUT',retryable:true,exitCode:interrupted?130:1});
        throw error;
      }
      await sleep(200);
    }
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
async function exportProject(base, project, options) {
  if(!project.clips.length)throw cliError('工程中没有镜头',{code:'PROJECT_EMPTY'});
  if(!options['no-wait'])await checkDestinations(options);
  const state=await request(base,'/api/state');validateProject(project,state.assets);
  const job=await send(base,'/api/render',{...project,...(options['burn-subtitles']!==undefined?{burnSubtitles:options['burn-subtitles']}:{})});
  if(options['no-wait'])return job;
  return waitExportJob(base,job.id,options,{download:true});
}
async function checkBinary(name,args=['-version']){
  try{await run(name,args);return {ok:true};}catch(e){return {ok:false,error:e.message};}
}
async function checkPythonSubtitles(){
  const managed=path.join(workspace,'.cutpot','subtitle-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const python=process.env.CUTPOT_SUBTITLE_PYTHON||(await exists(managed)?managed:'python3');
  const result={supported:true,ready:false,python,pillow:false,font:false};
  try{
    const out=await run(python,['-c','import PIL,sys;print(PIL.__version__);print(sys.executable)']);
    result.pillow=true;result.pythonVersion=out.trim().split('\n')[0];
  }catch(e){result.error=e.message;return result;}
  try{
    await run(python,['-c',"from PIL import ImageFont; ImageFont.truetype('/System/Library/Fonts/PingFang.ttc', 24) if __import__('sys').platform=='darwin' else ImageFont.load_default()"]);
    result.font=true;
  }catch{result.font=false;}
  result.ready=result.pillow;
  return result;
}
async function doctorReport(base){
  const ffmpeg=await checkBinary('ffmpeg');
  const ffprobe=await checkBinary('ffprobe');
  let libx264=false;
  if(ffmpeg.ok){try{libx264=(await run('ffmpeg',['-hide_banner','-encoders'])).includes('libx264');}catch{}}
  const subtitles=await checkPythonSubtitles();
  const tts={supported:true,ready:false,providers:[]};
  try{
    await run('say',['-v','?']);
    tts.providers.push({id:'macos',supported:true,ready:process.platform==='darwin'});
  }catch{tts.providers.push({id:'macos',supported:true,ready:false});}
  try{
    const service=await health(base);
    if(service.capabilities?.includes('tts')){
      try{
        const providers=await request(base,'/api/tts/providers');
        tts.providers=providers.providers||providers;
        tts.ready=(tts.providers||[]).some(p=>p.available);
        tts.service=true;
      }catch(e){tts.serviceError=e.message;}
    }
  }catch{tts.service=false;}
  const result={
    ok:ffmpeg.ok&&ffprobe.ok&&libx264,
    node:process.version,
    version,
    apiVersion,
    dependencies:{
      ffmpeg:{supported:true,ready:ffmpeg.ok},
      ffprobe:{supported:true,ready:ffprobe.ok},
      libx264:{supported:true,ready:libx264},
      burnSubtitles:subtitles,
      tts,
    },
    // Keep flat flags for older scripts.
    ffmpeg:ffmpeg.ok,ffprobe:ffprobe.ok,libx264,
  };
  console.error('[doctor]',JSON.stringify({ok:result.ok,ffmpeg:result.ffmpeg,ffprobe:result.ffprobe,libx264,subtitles:subtitles.ready,tts:tts.ready}));
  return result;
}
async function capabilitiesReport(base){
  let service=null;
  try{service=await health(base);}catch{service=null;}
  const doctor=await doctorReport(base);
  return {
    app:'cutpot',
    version,
    apiVersion,
    manifestSchemaVersion:manifestSchema().schemaVersion,
    service:service?{running:true,url:service.url||base,dataDir:service.dataDir,capabilities:service.capabilities}:{running:false,url:base},
    commands:Object.keys(commands).sort(),
    features:{
      compose:true,render:true,validate:true,dryRun:true,projectEdit:true,tts:true,burnSubtitles:true,jobWait:true,
    },
    dependencies:doctor.dependencies,
    ready:{
      render:doctor.ok,
      burnSubtitles:doctor.dependencies.burnSubtitles.ready,
      tts:doctor.dependencies.tts.ready||doctor.dependencies.tts.providers?.some?.(p=>p.ready||p.available),
    },
  };
}
async function manifestProject(base,file){
  const absolute=path.resolve(file),input=JSON.parse(await readFile(absolute,'utf8'));
  if(!input||!Array.isArray(input.clips)||input.clips.length===0||input.clips.length>2000)throw new Error('清单 clips 必须包含 1—2000 个镜头');
  const project=outputSettings(defaultProject(),{name:input.name??'清单合成',fps:input.fps,resolution:input.resolution,'music-volume':input.musicVolume});
  if(input.width!==undefined)project.width=input.width;if(input.height!==undefined)project.height=input.height;
  validateProject(project,[]);
  for(const c of input.clips){
    if(typeof c.file!=='string')throw new Error('每个镜头必须提供 file 路径');
    const a=await upload(base,path.resolve(path.dirname(absolute),c.file));
    project.clips.push(newClip(a,{...c,in:c.sourceIn??c.in,'keep-audio':c.muted===false,lock:c.locked===true},project.fps));
  }
  for(const key of ['narration','music'])if(input[key])project[key]=(await upload(base,path.resolve(path.dirname(absolute),input[key]))).id;
  return project;
}

async function speechOutput(options){
  if(options.output===undefined)return;
  if(path.extname(options.output).toLowerCase()!=='.wav')throw new Error('配音输出请使用 .wav 文件');
  if(!options.force&&await exists(path.resolve(options.output)))throw new Error(`输出已存在，覆盖需 --force：${options.output}`);
}
async function downloadSpeech(base,job,options){
  await speechOutput(options);
  const target=path.resolve(options.output),temp=`${target}.${randomUUID()}.partial`;
  try{
    const res=await fetch(`${base}/api/assets/${job.asset.id}/content`,{signal:AbortSignal.timeout(10*60*1000)});
    if(!res.ok)throw new Error('配音文件下载失败');
    await mkdir(path.dirname(target),{recursive:true});
    await pipeline(Readable.fromWeb(res.body),createWriteStream(temp,{flags:'wx'}));
    if(options.force)await rename(temp,target);else await copyFile(temp,target,constants.COPYFILE_EXCL);
    return target;
  }finally{await rm(temp,{force:true});}
}
async function waitSpeech(base,id,options){
  const timeout=options.timeout!==undefined?number(options.timeout,'超时秒数',{min:.1}):null;
  const started=Date.now();let interrupted=false,last='';const interrupt=()=>{interrupted=true;};
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try{
    while(true){
      const job=await request(base,`/api/tts/jobs/${id}`);
      if(job.message!==last){process.stderr.write(`[${job.progress}%] ${job.message}\n`);last=job.message;}
      if(job.status==='completed')return job;
      if(job.status==='failed'||job.status==='cancelled')throw new Error(job.message);
      if(interrupted||timeout!==null&&Date.now()-started>timeout*1000){
        const result=await send(base,`/api/tts/jobs/${id}/cancel`,{});
        if(result.status==='completed')continue;
        const e=new Error(interrupted?'已请求取消配音':'等待超时，已请求取消配音');e.exitCode=interrupted?130:1;throw e;
      }
      await sleep(200);
    }
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
async function speechCommand(base,command,args,options){
  if(command==='tts config')return request(base,'/api/tts/config');
  if(command==='tts configure'){
    if(!options['reference-audio']||!options['prompt-text']||!options['age-group'])throw new Error('请指定 --reference-audio、--prompt-text 和 --age-group child|adult');
    return send(base,'/api/tts/config',{endpoint:options.endpoint,referenceAudio:path.resolve(options['reference-audio']),promptText:options['prompt-text'],ageGroup:options['age-group'],characterId:options['character-id'],characterName:options['character-name']},'PUT');
  }
  if(command==='tts providers')return request(base,'/api/tts/providers');
  if(command==='tts voices'){
    const params=new URLSearchParams();if(options.provider)params.set('provider',options.provider);if(options.category)params.set('category',options.category);
    return request(base,`/api/tts/voices?${params}`,{signal:AbortSignal.timeout(35000)});
  }
  if(command==='tts jobs')return request(base,'/api/tts/jobs');
  if(['tts job','tts cancel','tts download'].includes(command)){
    if(!/^[a-f\d-]{36}$/i.test(args[0]))throw new Error('配音任务 ID 无效');
    const job=await request(base,`/api/tts/jobs/${args[0]}`);
    if(command==='tts job')return job;
    if(command==='tts cancel')return send(base,`/api/tts/jobs/${job.id}/cancel`,{});
    if(job.status!=='completed')throw new Error('配音任务尚未完成');
    if(!options.output)throw new Error('请指定 -o voice.wav');
    return {id:job.id,asset:job.asset,output:await downloadSpeech(base,job,options)};
  }
  if([options.text,options.file,options.dialogue].filter(v=>v!==undefined).length!==1)throw new Error('配音需要且只能指定 --text、--file 或 --dialogue');
  if(options['no-wait']&&options.attach)throw new Error('--attach 需要等待生成完成，不能与 --no-wait 同用');
  if(options.timeout!==undefined)number(options.timeout,'超时秒数',{min:.1});
  await speechOutput(options);
  const script=options.dialogue?JSON.parse(await readFile(path.resolve(options.dialogue),'utf8')):null;
  const text=options.file?await readFile(path.resolve(options.file),'utf8'):options.text;
  const state=options.attach?await request(base,'/api/state'):null;
  const job=await send(base,'/api/tts',{lines:script?(Array.isArray(script)?script:script.lines):undefined,text,provider:options.provider,voice:options.voice,speed:options.speed,preset:options.preset,target:options.target,style:options.style,name:options.name});
  if(options['no-wait'])return job;
  const complete=await waitSpeech(base,job.id,options);
  const result={id:complete.id,status:'completed',asset:complete.asset,duration:complete.duration};
  if(options.output)result.output=await downloadSpeech(base,complete,options);
  if(options.attach){
    try{
      if(!state.project.clips.length||complete.duration>timelineDuration(state.project)+.05)throw new Error('旁白长于成片，请先增加画面时长再设置旁白');
      if(!state.assets.some(a=>a.id===complete.asset.id))state.assets.push(complete.asset);
      await saveProject(base,state,{...state.project,narration:complete.asset.id});result.attached=true;
    }catch(e){throw new Error(`配音已生成${result.output?`（${result.output}）`:''}，素材 ID ${complete.asset.id}；设置旁白失败：${e.message}`);}
  }
  return result;
}

export async function main(argv) {
  let options={};
  try{
    const parsed=parseArgs({args:argv,options:definitions,allowPositionals:true});options=parsed.values;
    if(options.version){console.log(options.json?JSON.stringify({version}):version);return 0;}
    const args=parsed.positionals;
    if(options.help||args.length===0||args[0]==='help'){console.log(options.json?JSON.stringify({help}):help);return 0;}
    let command;
    if(['project','assets','clip','audio','tts','schema','workflow'].includes(args[0])){
      const head=args.shift(),tail=args.shift();
      if(tail===undefined)throw cliError(`${head} 需要子命令；使用 cutpot-cli --help 查看用法`,{code:'UNKNOWN_COMMAND'});
      command=`${head} ${tail}`;
    }else if(args[0]==='job'&&args[1]==='wait'){args.shift();args.shift();command='job wait';}
    else command=args.shift();
    if(!commands[command])throw cliError(`未知命令：${command}；使用 cutpot-cli --help 查看用法`,{code:'UNKNOWN_COMMAND'});
    const allowed=new Set(['url','json','help','version',...commands[command]]);
    for(const key of Object.keys(options))if(!allowed.has(key))throw cliError(`${command} 不支持 --${key}`,{code:'UNKNOWN_OPTION'});
    if(options.mute&&options['keep-audio'])throw cliError('--mute 与 --keep-audio 不能同时使用',{code:'OPTION_CONFLICT'});
    if(options.lock&&options.unlock)throw cliError('--lock 与 --unlock 不能同时使用',{code:'OPTION_CONFLICT'});
    if(options['no-wait']&&(options.output!==undefined||options.timeout!==undefined||options.force||options['dry-run']))throw cliError('--no-wait 仅提交任务，不能与 --output、--timeout、--force 或 --dry-run 同用；完成后使用 download ID -o FILE 或 job wait ID',{code:'OPTION_CONFLICT'});
    if(options['dry-run']&&(options['no-wait']||options.timeout!==undefined||options.force||options['burn-subtitles']))throw cliError('--dry-run 不能与 --no-wait、--timeout、--force 或 --burn-subtitles 同用',{code:'OPTION_CONFLICT'});
    const minMax={'workflow apply':[1,1],'workflow generate':[2,101],'workflow wait':[1,100],probe:[1,1],validate:[1,1],'schema manifest':[0,0],'project save':[1,1],'project open':[1,1],'assets import':[1,2000],'clip add':[1,1],'clip edit':[1,1],'clip remove':[1,1],'clip duplicate':[1,1],'clip move':[1,1],compose:[1,2000],render:[1,1],job:[1,1],'job wait':[1,1],cancel:[1,1],download:[1,1],'tts job':[1,1],'tts cancel':[1,1],'tts download':[1,1]};
    const [min,max]=minMax[command]||[0,0];if(args.length<min||args.length>max)throw cliError(`${command} 需要 ${min===max?min:`${min}—${max}`} 个位置参数`,{code:'ARGUMENT_COUNT'});
    const port=options.port===undefined?null:number(options.port,'端口',{min:1,max:65535,integer:true});
    const base=localURL(options.url||process.env.CUTPOT_URL||`http://127.0.0.1:${port??4317}`);
    if(port!==null&&Number(new URL(base).port||80)!==port)throw cliError('--port 与 --url 指向不同端口',{code:'OPTION_CONFLICT'});
    let result;
    if(command==='doctor'){
      result=await doctorReport(base);
      console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return result.ok?0:1;
    }else if(command==='capabilities'){
      result=await capabilitiesReport(base);
      console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return 0;
    }else if(command==='schema manifest'){
      result=manifestSchema();
      console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return 0;
    }else if(command==='validate'){
      result=await validateManifestFile(args[0]);
      console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return result.ok?0:1;
    }else if(command==='render'&&options['dry-run']){
      result=await dryRunManifest(args[0],{output:options.output});
      console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return result.ok?0:1;
    }else if(command==='probe')result={file:path.resolve(args[0]),...await probe(path.resolve(args[0]))};
    else if(command==='start')result=await start(base,options.data);
    else if(command==='serve'){
      if(options.json)throw new Error('serve 为前台服务；脚本请使用 start --json');
      const child=spawn(process.execPath,[path.join(workspace,'src/server.js')],{stdio:'inherit',env:{...process.env,PORT:new URL(base).port||'80',CUTPOT_DATA:path.resolve(options.data||process.env.CUTPOT_DATA||path.join(workspace,'.cutpot'))}});
      return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?130:0)));});
    }else if(command==='status'){
      try{result={running:true,...await health(base)};}catch(e){if(e.cause?.code!=='ECONNREFUSED')throw e;result={running:false,url:base};}
    }else if(command==='stop'){await health(base);result=await send(base,'/api/shutdown',{force:Boolean(options.force)});}
    else{
      const service=await connect(base);
      if(options['burn-subtitles']&&!service.capabilities.includes('burn-subtitles'))throw new Error('请重启 CutPot 加载字幕烧录功能');
      if(command.startsWith('workflow ')){
        if(!service.capabilities?.includes('storyboard'))throw new Error('请重启 CutPot 加载创作工作流功能');
        result=await workflowCommand(base,command,args,options,{request,send});
      }else if(command.startsWith('tts ')){
        if(!service.capabilities?.includes('tts'))throw new Error('当前服务不支持 TTS，请先 cutpot-cli stop，再 cutpot-cli start');
        if((options.preset!==undefined||options.category!==undefined)&&!service.capabilities.includes('tts-child-presets')||options.provider==='gpt-sovits'&&!service.capabilities.includes('tts-gpt-sovits'))throw new Error('当前服务尚未加载儿童音色功能，请先 cutpot-cli stop，再 cutpot-cli start');
        if((options.dialogue!==undefined||options['character-id']!==undefined)&&!service.capabilities.includes('tts-dialogue'))throw new Error('请重启 CutPot 加载多角色配音功能');
        if((options.target!==undefined||options.style!==undefined)&&!service.capabilities.includes('tts-native-child')||['tts config','tts configure'].includes(command)&&!service.capabilities.includes('tts-config'))throw new Error('请重启 CutPot 以加载原生儿童配音与本机配置功能');
        result=await speechCommand(base,command,args,options);
      }
      else if(command==='assets import'){result=[];for(const file of args)result.push(await upload(base,file));}
      else if(command==='jobs')result=await request(base,'/api/jobs');
      else if(command==='job'){result=(await request(base,'/api/jobs')).find(j=>j.id===args[0]);if(!result)throw cliError('任务不存在（任务列表仅保留本次服务会话）',{code:'JOB_MISSING',retryable:true});}
      else if(command==='job wait'){
        if(!/^[a-f\d-]{36}$/i.test(args[0]))throw cliError('任务 ID 无效',{code:'JOB_ID_INVALID'});
        const existing=(await request(base,'/api/jobs')).find(j=>j.id===args[0]);
        if(!existing)throw cliError('任务不存在（任务列表仅保留本次服务会话）',{code:'JOB_MISSING',retryable:true});
        console.error('[job wait]',JSON.stringify({id:args[0],status:existing.status}));
        result=await waitExportJob(base,args[0],options,{download:false});
      }
      else if(command==='cancel'){const jobs=await request(base,'/api/jobs');if(!jobs.some(j=>j.id===args[0]&&j.status==='running'))throw cliError('没有这个正在运行的任务',{code:'JOB_NOT_RUNNING'});result=await send(base,`/api/jobs/${args[0]}/cancel`,{});}
      else if(command==='download')result=await downloadJob(base,args[0],options);
      else if(command==='render')result=await exportProject(base,await manifestProject(base,args[0]),options);
      else if(command==='compose'){
        if(!options['no-wait'])await checkDestinations(options);
        const project=outputSettings(defaultProject(),{...options,name:options.name??'文件合成'});validateProject(project,[]);
        for(const file of args)project.clips.push(newClip(await upload(base,file),options,project.fps));
        for(const key of ['narration','music'])if(options[key])project[key]=(await upload(base,options[key])).id;
        result=await exportProject(base,project,options);
      }else{
        const state=await request(base,'/api/state'),project=structuredClone(state.project);
        if(command==='project show')result=project;
        else if(command==='assets list')result=state.assets;
        else if(command==='clip list')result=project.clips.map((c,i)=>({index:i+1,...c}));
        else if(command==='export')result=await exportProject(base,project,options);
        else if(command==='project save'){await atomicWrite(args[0],JSON.stringify(project,null,2)+'\n',options.force);result={saved:path.resolve(args[0])};}
        else{
          if(command==='project new'||command==='project open'){
            if(project.clips.length&&!options.force)throw new Error('当前时间线非空，替换需 --force；可先 project save FILE');
            const next=command==='project new'?outputSettings(defaultProject(),options):JSON.parse(await readFile(path.resolve(args[0]),'utf8'));
            result=await saveProject(base,state,next);
          }else{
            if(command==='arrange')project.clips=autoArrange(project,state.assets).clips;
            if(command==='clip add'){
              const c=newClip(resolveAsset(state.assets,args[0]),options,project.fps);
              const at=options.at!==undefined?number(options.at,'插入位置',{min:1,max:project.clips.length+1,integer:true})-1:project.clips.length;
              if(project.clips.slice(at).some(c=>c.locked))throw new Error('插入会移动锁定镜头，请先解锁或添加到末尾');
              project.clips.splice(at,0,c);
            }
            if(['clip edit','clip remove','clip duplicate','clip move'].includes(command)){
              const i=resolveClip(project,args[0]),c=project.clips[i];
              if(command==='clip edit'){
                const editKeys=Object.keys(options).filter(k=>commands[command].includes(k));
                if(!editKeys.length)throw new Error('请提供要编辑的选项');
                if(c.locked&&!(options.unlock&&editKeys.length===1))lockCheck(c);
                if(options.asset!==undefined){const a=resolveAsset(state.assets,options.asset);if(a.type==='audio')throw new Error('画面镜头不能关联音频素材');c.assetId=a.id;c.sourceIn=0;}
                if(options.duration!==undefined)c.duration=number(options.duration,'时长',{min:1/project.fps});
                if(options.in!==undefined)c.sourceIn=number(options.in,'入点');
                for(const key of ['title','subtitle'])if(options[key]!==undefined)c[key]=options[key];
                if(options['keep-audio'])c.muted=false;if(options.mute)c.muted=true;
                if(options.lock)c.locked=true;if(options.unlock)c.locked=false;
              }else{
                lockCheck(c);
                if(command==='clip remove'){if(project.clips.slice(i+1).some(c=>c.locked))throw new Error('删除会移动后续锁定镜头，请先解锁');project.clips.splice(i,1);}
                if(command==='clip duplicate'){if(project.clips.slice(i+1).some(c=>c.locked))throw new Error('复制会移动后续锁定镜头，请先解锁');project.clips.splice(i+1,0,{...c,id:randomUUID()});}
                if(command==='clip move'){
                  const to=number(options.to??'','目标位置',{min:1,max:project.clips.length,integer:true})-1;
                  if(project.clips.slice(Math.min(i,to),Math.max(i,to)+1).some(c=>c.locked))throw new Error('移动不能跨越锁定镜头');
                  project.clips.splice(i,1);project.clips.splice(to,0,c);
                }
              }
            }
            if(command==='audio set'){
              if(!['narration','music','music-volume'].some(k=>options[k]!==undefined))throw new Error('请指定 --narration、--music 或 --music-volume');
              for(const key of ['narration','music'])if(options[key]!==undefined){const a=options[key]==='none'?null:resolveAsset(state.assets,options[key]);if(a&&a.type!=='audio')throw new Error('音轨只能使用音频素材');project[key]=a?.id??null;}
              if(options['music-volume']!==undefined)project.musicVolume=number(options['music-volume'],'音乐音量',{max:1});
            }
            result=await saveProject(base,state,project);
          }
        }
      }
    }
    console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return 0;
  }catch(e){
    const payload=errorPayload(e);
    if(options.json||argv.includes('--json')||argv.includes('-j'))console.log(JSON.stringify(payload));
    else console.error(`cutpot-cli: ${payload.error}${payload.code&&payload.code!=='ERROR'?` [${payload.code}]`:''}`);
    return e.exitCode??1;
  }
}
