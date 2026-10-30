import {validateProject} from './project.js';

const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const list=(value,max,label)=>{assert(Array.isArray(value)&&value.length<=max,`${label}格式无效`);return value;};
const cleanText=(value,max=12000)=>String(value??'').slice(0,max);
const fields=(object,keys)=>Object.fromEntries(keys.filter(key=>object[key]!==undefined).map(key=>[key,object[key]]));

export function projectFile(project,creation,assets){
  // Asset IDs and hashes allow relinking in another local library. Media and paths
  // are deliberately separate from this lightweight editing document.
  const data={format:'cutpot-project',version:1,project:structuredClone(project),creation:structuredClone(creation)};
  for(const job of data.creation?.jobs||[])delete job.input;
  data.assets=assets.map(a=>fields(a,['id','name','type','sha256']));
  return data;
}

export function readProjectFile(input,assets){
  const usedAssetIds=new Set();
  const full=input?.format==='cutpot-project';
  assert(full?input.version===1:input?.version===1&&Array.isArray(input.clips),'不支持的工程文件，请选择 CutPot 导出的 JSON 工程');
  const manifest=full?list(input.assets||[],10000,'素材清单'):[];
  const resolve=(id,type)=>{
    const record=manifest.find(a=>a.id===id);
    const a=assets.find(a=>a.id===id&&(!record?.sha256||a.sha256===record.sha256))||record?.sha256&&assets.find(a=>a.sha256===record.sha256);
    assert(a&&(!type||a.type===type),`缺少素材：${record?.name||id}。请先将原素材导入本机素材库`);
    usedAssetIds.add(a.id);
    return a.id;
  };
  const raw=structuredClone(full?input.project:input);
  assert(raw&&uuid(raw.id),'工程 ID 无效');
  list(raw.clips,2000,'剪辑镜头').forEach(c=>c.assetId=resolve(c.assetId));
  for(const key of ['narration','music'])if(raw[key])raw[key]=resolve(raw[key],'audio');
  const project=validateProject(raw,assets);
  if(!full||!input.creation)return {project,creation:null,usedAssetIds:[...usedAssetIds]};
  const source=input.creation;
  assert(source.version===1&&source.projectId===project.id,'分镜与剪辑工程不匹配');
  const settings=source.settings;
  assert(settings&&['mock','live'].includes(settings.mode)&&['16:9','9:16','1:1'].includes(settings.ratio)&&['2k','4k'].includes(settings.resolution)&&Number.isInteger(settings.candidates)&&settings.candidates>=1&&settings.candidates<=10,'工程生成设置无效');
  const versions=(item,type)=>{
    const seen=new Set();
    const result=list(item.versions,1000,'候选版本').map(v=>{
      assert(v&&uuid(v.id)&&!seen.has(v.id),'候选版本 ID 无效或重复');seen.add(v.id);
      const next=fields(v,['id','jobId','externalId','mode','prompt','createdAt','size','duration','actualDuration','review','firstPSNR','lastPSNR','qualityError']);
      next.assetId=resolve(v.assetId,type);next.prompt=cleanText(v.prompt);
      assert(['mock','live','imported'].includes(next.mode),'候选版本来源无效');
      if(next.jobId)assert(uuid(next.jobId),'任务 ID 无效');
      if(type==='video'){
        next.firstAssetId=resolve(v.firstAssetId,'image');next.lastAssetId=resolve(v.lastAssetId,'image');
        assert(Number.isFinite(next.duration)&&next.duration>=1&&next.duration<=10,'视频版本时长无效');
        assert(['pending','approved','rejected'].includes(next.review),'视频检查状态无效');
        for(const key of ['firstPSNR','lastPSNR'])if(next[key]!=null)assert(Number.isFinite(next[key]),'画面质量指标无效');
      }
      return next;
    });
    assert(item.selectedVersionId==null||result.some(v=>v.id===item.selectedVersionId),'选用版本不存在');
    return result;
  };
  const collection=source=>{
    const ids=new Set();
    const shots=list(source.shots,1000,'分镜').map(s=>{
      assert(s&&uuid(s.id)&&!ids.has(s.id),'分镜 ID 无效或重复');ids.add(s.id);
      return {id:s.id,title:cleanText(s.title,200),description:cleanText(s.description),prompt:cleanText(s.prompt),negativePrompt:cleanText(s.negativePrompt,4000),versions:versions(s,'image'),selectedVersionId:s.selectedVersionId??null};
    });
    const segmentIds=new Set();
    const segments=list(source.segments,1000,'视频片段').map(s=>{
      assert(s&&uuid(s.id)&&!segmentIds.has(s.id)&&ids.has(s.fromShotId)&&ids.has(s.toShotId),'视频片段关联无效');segmentIds.add(s.id);
      assert(Number.isFinite(s.duration)&&s.duration>=1&&s.duration<=10,'视频片段时长无效');
      return {id:s.id,fromShotId:s.fromShotId,toShotId:s.toShotId,prompt:cleanText(s.prompt),duration:s.duration,versions:versions(s,'video'),selectedVersionId:s.selectedVersionId??null};
    });
    assert(segments.length===Math.max(0,shots.length-1)&&segments.every((s,i)=>s.fromShotId===shots[i].id&&s.toShotId===shots[i+1].id),'视频首尾帧顺序与分镜不匹配');
    return {shots,segments};
  };
  const creation={version:1,projectId:project.id,revision:0,script:cleanText(source.script,50000),style:cleanText(source.style,4000),settings:fields(settings,['mode','ratio','resolution','candidates']),references:list(source.references,10,'主体参考图').map(id=>resolve(id,'image')),...collection(source)};
  creation.archives=list(source.archives||[],200,'分镜历史').map(a=>{assert(uuid(a.id),'分镜历史 ID 无效');return {id:a.id,createdAt:cleanText(a.createdAt,64),script:cleanText(a.script,50000),...collection(a)};});
  creation.jobs=list(source.jobs||[],10000,'任务记录').map(j=>{
    assert(uuid(j.id)&&uuid(j.targetId)&&['image','video'].includes(j.kind),'生成任务记录无效');
    const job=fields(j,['id','kind','targetId','mode','externalId','createdAt','updatedAt']);
    job.status=['completed','failed','cancelled'].includes(j.status)?j.status:'cancelled';
    job.progress=job.status==='completed'?100:0;job.message=job.status===j.status?cleanText(j.message):'从工程导入的任务记录，未恢复或重新提交生成';
    return job;
  });
  return {project,creation,usedAssetIds:[...usedAssetIds]};
}
