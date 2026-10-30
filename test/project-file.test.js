import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {defaultProject} from '../src/project.js';
import {projectFile,projectPackage,collectUsedAssetIds,readProjectFile} from '../src/project-file.js';
import {writeZip,listZip,extractZipEntry,readZipText} from '../src/zip-store.js';

function fixture(){
  const assets=['image','image','video'].map((type,i)=>({id:randomUUID(),type,name:`asset-${i}`,sha256:`hash-${i}`,duration:10,path:`/private/source-${i}`}));
  const shots=assets.slice(0,2).map((a,i)=>{const v={id:randomUUID(),assetId:a.id,mode:'imported'};return {id:randomUUID(),title:`分镜${i}`,description:'脚本原文',prompt:'保持人物一致',negativePrompt:'',versions:[v],selectedVersionId:v.id};});
  const v={id:randomUUID(),assetId:assets[2].id,mode:'live',firstAssetId:assets[0].id,lastAssetId:assets[1].id,duration:3,review:'approved'};
  const segment={id:randomUUID(),fromShotId:shots[0].id,toShotId:shots[1].id,prompt:'相机前移',duration:3,versions:[v],selectedVersionId:v.id};
  const project={...defaultProject(),name:'完整故事',clips:[{id:randomUUID(),assetId:assets[2].id,sourceIn:.4,speed:1.5,duration:2,subtitle:'字幕',muted:true}]};
  const creation={version:1,projectId:project.id,script:'完整脚本',style:'三维动画',references:[assets[0].id],settings:{mode:'live',ratio:'16:9',resolution:'2k',candidates:4},shots,segments:[segment],jobs:[{id:randomUUID(),targetId:segment.id,kind:'video',mode:'live',status:'running',externalId:'paid-task-id',input:{firstPath:'/private/source-0'}}],archives:[]};
  return {project,creation,assets};
}
test('unified project files preserve all three pages, relink hashes and never resume imported jobs',()=>{
  const {project,creation,assets}=fixture(),file=projectFile(project,creation,assets);
  assert.equal(JSON.stringify(file).includes('/private/source'),false);
  const moved=assets.map(a=>({...a,id:randomUUID()})),restored=readProjectFile(file,moved);
  assert.equal(restored.project.clips[0].assetId,moved[2].id);
  assert.equal(restored.project.clips[0].speed,1.5);
  assert.equal(restored.creation.script,creation.script);
  assert.equal(restored.creation.references[0],moved[0].id);
  assert.equal(restored.creation.segments[0].versions[0].lastAssetId,moved[1].id);
  assert.equal(restored.creation.jobs[0].status,'cancelled');
  assert.equal(restored.creation.jobs[0].externalId,'paid-task-id');
  assert.equal(restored.creation.jobs[0].input,undefined);
});
test('imports validate missing media and relations, and retain legacy editor file support',()=>{
  const {project,creation,assets}=fixture(),file=projectFile(project,creation,assets);
  assert.equal(readProjectFile(project,assets).creation,null);
  assert.throws(()=>readProjectFile(file,assets.slice(0,2)),/缺少素材/);
  const broken=structuredClone(file);broken.creation.shots[0].id='"><img src=x>';
  assert.throws(()=>readProjectFile(broken,assets),/分镜 ID/);
  const wrong=structuredClone(file);wrong.creation.segments[0].toShotId=wrong.creation.shots[0].id;
  assert.throws(()=>readProjectFile(wrong,assets),/首尾帧顺序/);
  assert.throws(()=>readProjectFile({...file,version:99},assets),/不支持/);
});
test('project package maps used media files and zip roundtrips without host paths',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'cutpot-package-'));
  try{
    const files=[];
    for(const [i,type] of [['a.png','image'],['b.png','image'],['c.mp4','video']].entries()){
      const file=path.join(dir,['a.png','b.png','c.mp4'][i]);
      const body=Buffer.from(`media-${i}-${type}-${randomUUID()}`);
      await writeFile(file,body);
      files.push({id:randomUUID(),type,name:path.basename(file),sha256:createHash('sha256').update(body).digest('hex'),duration:type==='video'?10:0,path:file});
    }
    const unused={id:randomUUID(),type:'image',name:'unused.png',sha256:'dead',duration:0,path:path.join(dir,'unused.png')};
    await writeFile(unused.path,'unused');
    const shots=files.slice(0,2).map((a,i)=>{const v={id:randomUUID(),assetId:a.id,mode:'imported'};return {id:randomUUID(),title:`分镜${i}`,description:'脚本',prompt:'画面',negativePrompt:'',versions:[v],selectedVersionId:v.id};});
    const v={id:randomUUID(),assetId:files[2].id,mode:'imported',firstAssetId:files[0].id,lastAssetId:files[1].id,duration:3,review:'approved'};
    const segment={id:randomUUID(),fromShotId:shots[0].id,toShotId:shots[1].id,prompt:'运镜',duration:3,versions:[v],selectedVersionId:v.id};
    const project={...defaultProject(),name:'打包故事',clips:[{id:randomUUID(),assetId:files[2].id,sourceIn:0,duration:2,subtitle:'',muted:true}]};
    const creation={version:1,projectId:project.id,script:'脚本',style:'风格',references:[files[0].id],settings:{mode:'mock',ratio:'16:9',resolution:'2k',candidates:1},shots,segments:[segment],jobs:[],archives:[]};
    const used=collectUsedAssetIds(project,creation);
    assert.equal(used.size,3);
    const {manifest,media}=projectPackage(project,creation,[...files,unused]);
    assert.equal(manifest.bundle,'media');
    assert.equal(media.length,3);
    assert.equal(JSON.stringify(manifest).includes(dir),false);
    const zip=path.join(dir,'story.cutpot.zip');
    await writeZip(zip,[{name:'project.json',data:JSON.stringify(manifest,null,2)},...media.map(item=>({name:item.file,path:item.path}))]);
    const entries=await listZip(zip);
    assert.ok(entries.some(e=>e.name==='project.json'));
    assert.equal(entries.filter(e=>e.name.startsWith('media/')).length,3);
    const restored=JSON.parse(await readZipText(zip,entries.find(e=>e.name==='project.json')));
    assert.equal(restored.assets[0].file.startsWith('media/'),true);
    const extracted=path.join(dir,'out.bin');
    await extractZipEntry(zip,entries.find(e=>e.name===restored.assets[0].file),extracted);
    assert.equal(createHash('sha256').update(await readFile(extracted)).digest('hex'),restored.assets[0].sha256);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('project-file API restores both workspaces, rejects stale tabs, and survives restart',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-project-file-'));
  const port=String(24000+Math.floor(Math.random()*15000)),base=`http://127.0.0.1:${port}`;let child;
  const start=async()=>{child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:port,CUTPOT_DATA:root},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`server ${code}`)));});};
  const stop=async()=>{if(child?.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}};
  const get=async route=>(await fetch(base+route)).json();
  const act=async payload=>{const s=await get('/api/pipeline');const r=await fetch(base+'/api/pipeline',{method:'POST',body:JSON.stringify({...payload,projectId:s.projectId,revision:s.revision})});assert.equal(r.status,200);return r.json();};
  const restore=async(file,revision=file)=>fetch(base+'/api/project-file',{method:'POST',headers:{'If-Match':revision.editorRevision,'X-Cutpot-Creation-Revision':String(revision.creationRevision)},body:JSON.stringify(file)});
  try{
    await start();
    for(const route of ['/project-io.js','/project-io.css'])assert.equal((await fetch(base+route)).status,200);
    await act({action:'split',script:'第一幕。\n\n第二幕。',count:2});
    const beforeNew=await get('/api/project-file');
    const projectFolder=await mkdtemp(path.join(os.tmpdir(),'cutpot-new-project-'));
    assert.equal((await fetch(`${base}/api/project/new`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'缺目录'})})).status,400);
    const created=await fetch(`${base}/api/project/new`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'空白新项目',projectDir:projectFolder})});
    assert.equal(created.status,200,(await created.clone().json().catch(()=>({}))).error);
    const createdBody=await created.json();
    assert.equal(createdBody.project.name,'空白新项目');
    assert.notEqual(createdBody.project.id,beforeNew.project.id);
    assert.equal(createdBody.project.clips.length,0);
    assert.equal(createdBody.projectDir,projectFolder);
    assert.equal((await get('/api/pipeline')).shots.length,0);
    assert.ok(existsSync(path.join(projectFolder,'.cutpot','project.json')));
    await act({action:'split',script:'第一幕。\n\n第二幕。',count:2});
    const file=await get('/api/project-file');assert.equal(file.creation.shots.length,2);
    await act({action:'script',script:'尚未保存到文件的修改',style:'写实'});
    assert.equal((await restore(file)).status,409);
    const latest=await get('/api/project-file');
    assert.equal((await restore(file,latest)).status,200);
    assert.equal((await get('/api/pipeline')).script,'第一幕。\n\n第二幕。');
    const pack=await fetch(`${base}/api/project-package`);
    assert.equal(pack.status,200);assert.match(pack.headers.get('content-type')||'',/zip/);
    const zipBytes=Buffer.from(await pack.arrayBuffer());
    assert.equal(zipBytes.subarray(0,2).toString(),'PK');
    const afterPack=await get('/api/project-file');
    const imported=await fetch(`${base}/api/project-package`,{method:'POST',headers:{'Content-Type':'application/zip','If-Match':afterPack.editorRevision,'X-Cutpot-Creation-Revision':String(afterPack.creationRevision)},body:zipBytes});
    assert.equal(imported.status,200,(await imported.json()).error);
    assert.equal((await get('/api/pipeline')).shots.length,2);
    await stop();await start();assert.equal((await get('/api/project-file')).creation.shots.length,2);
    const current=await get('/api/project-file'),broken=structuredClone(current);broken.creation.settings.mode='unsupported';
    assert.equal((await restore(broken,current)).status,400);
    assert.equal((await get('/api/pipeline')).shots.length,2,'invalid file leaves current project intact');
  }finally{await stop();await rm(root,{recursive:true,force:true});}
});
