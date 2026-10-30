import http from 'node:http';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, stat, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipeline } from './pipeline.js';
import { projectFile, readProjectFile } from './project-file.js';
import { defaultProject, validateProject, autoArrange } from './project.js';
import { probe, run, renderProject } from './render.js';
import { ttsProviders, ttsVoices, voiceCategory, validateTTS, validateDialogue, synthesizeSpeech } from './tts.js';
import { loadSovitsSettings, saveSovitsSettings, sovitsSettingsStatus } from './tts-config.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root = path.resolve(process.env.CUTPOT_DATA || path.join(workspace,'.cutpot'));
const port = Number(process.env.PORT || 4317);
const projectRevision = () => createHash('sha256').update(JSON.stringify(project)).digest('hex');
await mkdir(path.join(root,'media'),{recursive:true});
await mkdir(path.join(root,'thumbs'),{recursive:true});
try{await loadSovitsSettings(root);}catch{console.warn('GPT-SoVITS 本机配置无法加载，请在自动配音面板中重新配置');}
let assets = [], project = defaultProject();
try { assets = JSON.parse(await readFile(path.join(root,'assets.json'),'utf8')); } catch(e) { if(e.code !== 'ENOENT') throw e; }
try { project = JSON.parse(await readFile(path.join(root,'project.json'),'utf8')); } catch(e) { if(e.code !== 'ENOENT') throw e; }
let saveQueue = Promise.resolve();
function persist() {
  const snapshot = {assets:JSON.stringify(assets),project:JSON.stringify(project,null,2)};
  const next = saveQueue.then(async()=>{
    for (const [name,data] of Object.entries(snapshot)) {
      const file = path.join(root,`${name}.json`);
      await writeFile(`${file}.tmp`,data); await rename(`${file}.tmp`,file);
    }
  });
  saveQueue = next.catch(()=>{});
  return next;
}
const jobs = new Map(), controllers = new Map();
const speechJobs = new Map(), speechControllers = new Map();
const publicAsset = ({path:ignored,...asset})=>asset;
const json = (res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req,limit=4*1024*1024) {
  const chunks=[];let size=0;
  for await (const c of req) { size+=c.length;if(size>limit) throw new Error('请求内容过大'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const mime = {'.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.flac':'audio/flac','.srt':'application/x-subrip; charset=utf-8','.json':'application/json'};
async function serve(req,res,file) {
  const s=await stat(file), type=mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'};
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1]&&!match[2])) {res.writeHead(416,{'Content-Range':`bytes */${s.size}`});res.end();return;}
    const start=match[1]?Number(match[1]):Math.max(0,s.size-Number(match[2]));
    const end=match[1]?(match[2]?Math.min(Number(match[2]),s.size-1):s.size-1):s.size-1;
    if(start>end||start>=s.size){res.writeHead(416,{'Content-Range':`bytes */${s.size}`});res.end();return;}
    res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${s.size}`});
    await pipeline(createReadStream(file,{start,end}),res);
  } else {res.writeHead(200,{...headers,'Content-Length':s.size});await pipeline(createReadStream(file),res);}
}
async function addAsset(file,name,tts=null) {
  const metadata=await probe(file);
  const hash=createHash('sha256');for await(const c of createReadStream(file))hash.update(c);
  const sha256=hash.digest('hex');
  const existing=assets.find(a=>a.sha256===sha256&&(!tts||JSON.stringify(a.tts)===JSON.stringify(tts)));if(existing){if(!existsSync(existing.path))existing.path=file;return existing;}
  const id=randomUUID(), asset={id,name,path:file,sha256,...metadata,...(tts?{tts}:{})};
  if(metadata.type!=='audio'){
    try { await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',file,'-frames:v','1','-vf','scale=320:-2',path.join(root,'thumbs',`${id}.jpg`)]); asset.thumbnail=`/api/assets/${id}/thumbnail`; } catch {}
  }
  assets.push(asset);return asset;
}

// Persist a new editor project before starting external jobs so its ID survives an early restart.
if(!existsSync(path.join(root,'project.json')))await persist();
const creation = await createPipeline({ root, workspace, getProject:()=>project, getAssets:()=>assets, addAsset, saveAssets:persist, editorRevision:projectRevision,
  async setProject(next, expected) {
    if (!expected || expected!==projectRevision()) throw Object.assign(new Error('剪辑工程已更新，请刷新后重新送入剪辑'),{statusCode:409});
    project=validateProject(next,assets);await persist();
  }
});

const demoShots = [
  [1,2,'乐乐开场','大家好，我是乐乐！'],[3,3,'课间怎么玩','课间怎么玩才安全？'],
  [4,2,'翻花绳','翻花绳、下飞行棋，'],[5,2,'飞行棋',''],[7,3,'跳绳','跳跳绳、看看新叶，'],[9,2,'观察嫩叶','课间真快乐！'],
  [10,4,'门口相遇',''],[11,1.52,'先停一停','小心，先停一停！'],[12,1.48,'站稳等待',''],
  [14,4,'温和提醒','拿水杯，慢慢走；'],[15,4,'礼让通过','经过门口先看看，等同学通过再走。'],
  [17,4,'平稳上楼','扶好扶手，慢慢上楼。'],[18,2,'扶手边的提醒','危险！'],[19,2,'立即制止','先停下！'],
  [20,2,'停止动作','扶手帮助我们站稳，'],[21,3,'解释规则','可不能当滑梯！'],[22,10,'记住安全规则','上下楼梯慢慢走，扶手不能攀爬、滑行。'],
  [23,3,'课堂提问','现在，他应该怎么做？'],[23,5,'安静思考','如果你是这位同学，接下来应该怎么做？'],
];

const server=http.createServer(async(req,res)=>{
  try {
    // Only the local workbench may mutate the local media library.
    const host=req.headers.host;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)){json(res,403,{error:'仅允许本机访问'});return;}
    if(req.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin)){json(res,403,{error:'不允许跨站请求'});return;}
    const url=new URL(req.url,`http://${host}`), p=url.pathname;
    if(req.method==='GET'&&p==='/api/health'){
      json(res,200,{app:'cutpot',apiVersion:1,version:'0.9.0',capabilities:['storyboard','first-last-frame','generation-versions','pipeline-handoff','tts','tts-child-presets','tts-gpt-sovits','tts-native-child','tts-config','tts-characters','tts-dialogue','burn-subtitles'],pid:process.pid,dataDir:root,url:`http://127.0.0.1:${port}`});return;
    }
    if(req.method==='GET'&&p==='/api/pipeline'){json(res,200,creation.view());return;}
    if(req.method==='POST'&&p==='/api/pipeline'){json(res,200,await creation.act(await body(req)));return;}
    if(req.method==='GET'&&p==='/api/tts/config'){json(res,200,sovitsSettingsStatus());return;}
    if(req.method==='PUT'&&p==='/api/tts/config'){
      const input=await body(req);
      if(input.referenceAssetId){const ref=assets.find(a=>a.id===input.referenceAssetId&&a.type==='audio');if(!ref)throw new Error('请选择素材库中的参考音频');if(input.ageGroup==='child'&&ref.tts&&(ref.tts.ageGroup!=='child'||ref.tts.preset!=='natural'))throw new Error('已知的成人或变调音频不能作为儿童原声参考');input.referenceAudio=ref.path;input.referenceName=ref.name;}
      json(res,200,await saveSovitsSettings(root,input));return;
    }
    if(req.method==='GET'&&p==='/api/tts/providers'){json(res,200,await ttsProviders());return;}
    if(req.method==='GET'&&p==='/api/tts/voices'){json(res,200,voiceCategory(await ttsVoices(url.searchParams.get('provider')||undefined),url.searchParams.get('category')||'all'));return;}
    if(req.method==='POST'&&p==='/api/tts'){
      const raw=await body(req),input=raw.lines?validateDialogue(raw):validateTTS(raw);
      if([...speechJobs.values()].some(j=>j.status==='running')){json(res,409,{error:'已有配音任务在运行，请完成或取消后再生成'});return;}
      const job={id:randomUUID(),type:'tts',name:input.name,status:'running',progress:0,message:'准备配音',provider:input.provider,createdAt:new Date().toISOString()};
      const controller=new AbortController();speechJobs.set(job.id,job);speechControllers.set(job.id,controller);
      (async()=>{
        const result=await synthesizeSpeech(input,root,job,controller.signal);
        controller.signal.throwIfAborted();
        const a=await addAsset(result.file,result.name,result.tts);
        if(a.path!==result.file)await rm(result.file,{force:true});
        else a.tts=result.tts;
        await persist();controller.signal.throwIfAborted();
        job.asset=publicAsset(a);job.duration=a.duration;job.progress=100;job.message='配音已生成';job.status='completed';
      })().catch(e=>{
        job.status=controller.signal.aborted?'cancelled':'failed';job.message=controller.signal.aborted?'配音已取消':e.message;
      }).finally(()=>speechControllers.delete(job.id));
      json(res,202,job);return;
    }
    if(req.method==='GET'&&p==='/api/tts/jobs'){json(res,200,[...speechJobs.values()]);return;}
    const speechMatch=/^\/api\/tts\/jobs\/([\w-]+)(\/cancel)?$/.exec(p);
    if(speechMatch){
      const job=speechJobs.get(speechMatch[1]);if(!job){json(res,404,{error:'配音任务不存在'});return;}
      if(req.method==='POST'&&speechMatch[2]){const requested=job.status==='running'&&speechControllers.has(job.id);if(requested)speechControllers.get(job.id).abort();json(res,200,{ok:true,requested,status:job.status});return;}
      if(req.method==='GET'&&!speechMatch[2]){json(res,200,job);return;}
    }
    if(req.method==='GET'&&p==='/api/state'){
      let engine=true;try{await run('ffmpeg',['-version']);}catch{engine=false;}
      json(res,200,{project,projectRevision:projectRevision(),assets:assets.map(publicAsset),jobs:[...jobs.values()],engine});return;
    }
    if(req.method==='GET'&&p==='/api/project-file'){
      const creationSnapshot=creation.snapshot();
      json(res,200,{...projectFile(project,creationSnapshot,assets),editorRevision:projectRevision(),creationRevision:creationSnapshot.revision});return;
    }
    if(req.method==='POST'&&p==='/api/project-file'){
      const input=await body(req,32*1024*1024);
      const data=readProjectFile(input,assets);
      for(const id of data.usedAssetIds){const a=assets.find(a=>a.id===id);if(!existsSync(a.path))throw new Error(`源文件无法读取：${a.name}。请重新导入原素材后再导入工程`);}
      if([...jobs.values(),...speechJobs.values()].some(j=>j.status==='running')){json(res,409,{error:'请等待导出或配音任务完成后再导入工程'});return;}
      await creation.importSnapshot(data,req.headers['if-match'],Number(req.headers['x-cutpot-creation-revision']));
      res.setHeader('ETag',projectRevision());json(res,200,{project,projectRevision:projectRevision()});return;
    }
    if(req.method==='PUT'&&p==='/api/project'){
      const input=await body(req);
      if(req.headers['if-match'] && req.headers['if-match']!==projectRevision()){
        json(res,409,{error:'工程已被其他页面或命令修改，请重新读取后再编辑'});return;
      }
      project=validateProject(input,assets);await persist();res.setHeader('ETag',projectRevision());json(res,200,project);return;
    }
    if(req.method==='POST'&&p==='/api/arrange'){
      if(req.headers['if-match'] && req.headers['if-match']!==projectRevision()){json(res,409,{error:'工程已被其他页面修改，请刷新后重试'});return;}
      project=autoArrange(validateProject(await body(req),assets),assets);await persist();res.setHeader('ETag',projectRevision());json(res,200,project);return;
    }
    if(req.method==='POST'&&p==='/api/assets/upload'){
      const name=path.basename(url.searchParams.get('name')||'素材');
      const ext=path.extname(name).toLowerCase();
      if(!['.mp4','.mov','.webm','.mkv','.png','.jpg','.jpeg','.webp','.mp3','.wav','.m4a','.aac','.ogg','.flac'].includes(ext))throw new Error('暂不支持这个文件格式');
      const file=path.join(root,'media',`${randomUUID()}${ext}`);let size=0;
      const limit=new Transform({transform(c,encoding,callback){size+=c.length;callback(size>1024**3?new Error('单文件最多 1 GB'):null,c);}});
      try {
        await pipeline(req,limit,createWriteStream(file));
        const asset=await addAsset(file,name);if(asset.path!==file)await rm(file,{force:true});
        await persist();json(res,201,publicAsset(asset));
      } catch(e){await rm(file,{force:true});throw e;}
      return;
    }
    if(req.method==='POST'&&p==='/api/demo'){
      const demoRoot=[path.join(workspace,'demo','lele'),path.join(workspace,'storyboard','乐乐安全教育','全片分镜_01-23'),path.join(workspace,'storyboard','全片分镜_01-23')].find(dir=>existsSync(path.join(dir,'分镜01.png')));
      if(!demoRoot)throw new Error('此安装未包含示例素材，请先导入自己的图片或视频');
      const clips=[];
      for(const [number,duration,title,subtitle] of demoShots){
        const file=path.join(demoRoot,`分镜${String(number).padStart(2,'0')}.png`);
        const asset=await addAsset(file,`分镜${String(number).padStart(2,'0')}.png`);
        clips.push({id:randomUUID(),assetId:asset.id,title,duration,sourceIn:0,subtitle,muted:true,locked:number===23});
      }
      project={...defaultProject(),name:'乐乐的课间发现',clips};await persist();
      json(res,200,{project,projectRevision:projectRevision(),assets:assets.map(publicAsset)});return;
    }
    if(req.method==='POST'&&p==='/api/render'){
      if([...jobs.values()].some(j=>j.status==='running')){json(res,409,{error:'已有导出任务正在运行'});return;}
      const snapshot=validateProject(await body(req),assets);
      if(!snapshot.clips.length)throw new Error('请先添加镜头');
      const job={id:randomUUID(),name:snapshot.name,status:'running',progress:0,message:'准备导出',createdAt:new Date().toISOString()};
      const controller=new AbortController();jobs.set(job.id,job);controllers.set(job.id,controller);
      renderProject(snapshot,structuredClone(assets),root,job,controller.signal).catch(e=>{
        job.status=controller.signal.aborted?'cancelled':'failed';job.message=controller.signal.aborted?'导出已取消':e.message;
      }).finally(()=>controllers.delete(job.id));
      json(res,202,job);return;
    }
    const cancel=/^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p);
    if(req.method==='POST'&&cancel){
      const job=jobs.get(cancel[1]);
      if(!job){json(res,404,{error:'任务不存在'});return;}
      const requested=job.status==='running'&&controllers.has(job.id);
      if(requested)controllers.get(job.id).abort();
      json(res,200,{ok:true,requested,status:job.status});return;
    }
    if(req.method==='GET'&&p==='/api/jobs'){json(res,200,[...jobs.values()]);return;}
    if(req.method==='POST'&&p==='/api/shutdown'){
      const input=await body(req);
      if(!input.force && (creation.hasActive() || [...jobs.values(),...speechJobs.values()].some(j=>j.status==='running'))){json(res,409,{error:'正在导出、配音或创作，请等待完成或使用 --force 停止本地服务（远端任务会继续）'});return;}
      json(res,200,{stopped:true});setImmediate(shutdown);return;
    }
    const assetMatch=/^\/api\/assets\/([\w-]+)\/(content|thumbnail)$/.exec(p);
    if(req.method==='GET'&&assetMatch){
      const asset=assets.find(a=>a.id===assetMatch[1]);if(!asset){json(res,404,{error:'素材不存在'});return;}
      await serve(req,res,assetMatch[2]==='content'?asset.path:path.join(root,'thumbs',`${asset.id}.jpg`));return;
    }
    const exported=/^\/api\/exports\/([\w-]+)\/(film\.mp4|subtitles\.srt|project\.json|report\.json)$/.exec(p);
    if(req.method==='GET'&&exported){await serve(req,res,path.join(root,'exports',exported[1],exported[2]));return;}
    if(req.method==='GET'&&['/','/storyboard','/videos'].includes(p)){await serve(req,res,path.join(workspace,'public','pipeline.html'));return;}
    if(req.method==='GET'&&['/editor','/app.js','/style.css','/timeline.js','/project-io.js','/project-io.css','/pipeline.js','/pipeline.css','/favicon.svg'].includes(p)){await serve(req,res,path.join(workspace,'public',p==='/editor'?'index.html':p.slice(1)));return;}
    json(res,404,{error:'接口不存在'});
  }catch(e){
    if(!res.headersSent&&!res.destroyed)json(res,e.statusCode || (e.code==='ENOENT'?404:400),{error:e.message});
    else if(!res.destroyed)res.end();
  }
});
server.listen(port,'127.0.0.1',()=>console.log(`CutPot 工作台：http://127.0.0.1:${port}`));
server.on('error',error=>{console.error(`CutPot 启动失败：${error.message}`);process.exit(1);});
function shutdown(){creation.close();for(const c of [...controllers.values(),...speechControllers.values()])c.abort();server.close(()=>process.exit(0));}
for(const event of ['SIGINT','SIGTERM'])process.on(event,shutdown);
