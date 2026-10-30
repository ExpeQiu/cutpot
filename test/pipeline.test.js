import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command, imageArgs, videoArgs, parseResult } from '../src/generation.js';
import { splitScript } from '../src/pipeline.js';

test('script splitting preserves all story content and avoids invented shots', () => {
  const script='乐乐走进教室。\n\n同学们一起下棋。\n\n放学后回家。';
  const shots=splitScript(script,2);assert.equal(shots.length,2);
  assert.equal(shots.join('').replace(/\s/g,''),script.replace(/\s/g,''));
  assert.equal(splitScript('一段没有更多分句的脚本',8).length,1);
  assert.throws(()=>splitScript('故事',Infinity));
});

test('live adapters enforce first/last mode and pass dangerous prompts as literal arguments',()=>{
  const prompt='字面量 $(touch unsafe) `echo unsafe` < &';
  const args=videoArgs({input:{prompt,firstPath:'/tmp/first frame.png',lastPath:'/tmp/last.png',duration:3,ratio:'16:9'}});
  assert.equal(args[args.indexOf('--play')+1],'first_last_frame');assert.equal(args[args.indexOf('--prompt')+1],prompt);
  assert.equal(args.includes('--workflow'),false);
  assert.throws(()=>videoArgs({input:{firstPath:'/tmp/first.png'}}),/首尾帧/);
  const image=imageArgs({input:{references:['/tmp/ref.png'],prompt,negativePrompt:'文字',resolution:'2k',ratio:'9:16',candidates:4}});
  assert.equal(image[0],'image2image');assert.equal(image[image.indexOf('--generate_num')+1],'4');
  assert.equal(parseResult('log\n{\n"submit_id":"known-id"\n}\n').submit_id,'known-id');
});

test('pipeline real media roundtrip, stale propagation, conflict protection, handoff and restart',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'cutpot-pipeline-')),data=path.join(temp,'data');
  const port=String(24000+Math.floor(Math.random()*15000)),base=`http://127.0.0.1:${port}`;
  let child;
  const start=async()=>{
    child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:port,CUTPOT_DATA:data},stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{let err='';child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('exit',code=>reject(new Error(`server ${code}: ${err}`)));child.stdout.once('data',resolve);});
  };
  const stop=async()=>{if(child?.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}};
  const get=async()=>{const r=await fetch(`${base}/api/pipeline`);assert.equal(r.status,200);return r.json();};
  const post=async(payload,state)=>{state ||= await get();const r=await fetch(`${base}/api/pipeline`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:state.projectId,revision:state.revision,...payload})});return {code:r.status,data:await r.json()};};
  const ok=async payload=>{const r=await post(payload);assert.equal(r.code,200,JSON.stringify(r.data));return r.data;};
  const wait=async()=>{for(let i=0;i<160;i++){const s=await get();if(!s.jobs.some(j=>['queued','running'].includes(j.status))){assert.ok(s.jobs.every(j=>j.status==='completed'),JSON.stringify(s.jobs));return s;}await new Promise(r=>setTimeout(r,100));}assert.fail('generation timed out');};
  try{
    await start();
    for(const route of ['/','/storyboard','/videos','/editor','/pipeline.js','/favicon.svg'])assert.equal((await fetch(base+route)).status,200,route);
    let s=await ok({action:'split',script:'乐乐进教室。\n\n同学一起下棋。\n\n大家一起回家。',count:3});
    assert.equal(s.shots.length,3);assert.equal(s.segments.length,2);assert.equal(s.settings.mode,'mock');
    assert.equal((await post({action:'add-shot'}, {...s,revision:s.revision-1})).code,409);
    s=await ok({action:'settings',settings:{...s.settings,candidates:2}});
    await ok({action:'generate',kind:'image',ids:s.shots.map(x=>x.id)});s=await wait();
    assert.ok(s.shots.every(x=>x.versions.length===2));
    assert.equal((await post({action:'settings',settings:{...s.settings,mode:'live'}})).code,200);
    assert.equal((await post({action:'generate',kind:'video',ids:[s.segments[0].id]})).code,400,'no implicit live authorization');
    assert.equal((await post({action:'generate',kind:'video',ids:[s.segments[0].id],authorizeLive:true})).code,400,'no mock first/last frames in live job');
    s=await ok({action:'settings',settings:{...s.settings,mode:'mock'}});
    await ok({action:'generate',kind:'video',ids:s.segments.map(x=>x.id)});s=await wait();
    assert.ok(s.segments.every(x=>x.versions[0].firstPSNR>0&&x.versions[0].lastPSNR>0));
    const video=s.assets.find(a=>a.id===s.segments[0].versions[0].assetId);
    assert.ok(video.duration>=3);assert.equal(video.type,'video');
    const content=await fetch(`${base}/api/assets/${video.id}/content`,{headers:{Range:'bytes=0-31'}});assert.equal(content.status,206);assert.equal((await content.arrayBuffer()).byteLength,32);
    const originalShot=s.shots[1],oldVersion=originalShot.selectedVersionId;
    s=await ok({action:'select-version',kind:'image',id:originalShot.id,versionId:originalShot.versions[1].id});
    assert.ok(s.segments.every(x=>x.stale),'both adjacent videos become stale');
    assert.equal((await post({action:'handoff',editorRevision:s.editorRevision})).code,400);
    s=await ok({action:'select-version',kind:'image',id:originalShot.id,versionId:oldVersion});
    assert.ok(s.segments.every(x=>!x.stale));
    s=await ok({action:'handoff',editorRevision:s.editorRevision});
    s=await ok({action:'handoff',editorRevision:s.editorRevision});
    let editor=await (await fetch(`${base}/api/state`)).json();assert.equal(editor.project.clips.length,2,'repeat handoff must not duplicate clips');
    assert.equal(editor.project.clips[0].pipelineSegmentId,s.segments[0].id);
    const snapshot=structuredClone(editor.project);snapshot.clips[0].subtitle='保留手工字幕';
    snapshot.clips.splice(1,0,{...snapshot.clips[0],id:crypto.randomUUID(),duration:2,sourceIn:1});snapshot.clips[0].duration=1;
    const changed=await fetch(`${base}/api/project`,{method:'PUT',body:JSON.stringify(snapshot)});assert.equal(changed.status,200);
    assert.equal((await post({action:'handoff',editorRevision:s.editorRevision})).code,409,'stale editor revision rejected');
    s=await get();
    await ok({action:'review',id:s.segments[0].id,review:'rejected'});
    assert.equal((await post({action:'handoff',editorRevision:s.editorRevision})).code,400,'rejected clips cannot hand off');
    s=await ok({action:'review',id:s.segments[0].id,review:'approved'});
    s=await ok({action:'handoff',editorRevision:s.editorRevision});
    editor=await (await fetch(`${base}/api/state`)).json();assert.equal(editor.project.clips[0].subtitle,'保留手工字幕');
    assert.equal(editor.project.clips.length,3,'editor splits retain unique clips after handoff');assert.equal(editor.project.clips[1].sourceIn,1);assert.equal(new Set(editor.project.clips.map(c=>c.id)).size,3);
    await stop();await start();
    s=await get();assert.equal(s.shots.length,3);assert.equal(s.segments[0].versions.length,1);assert.equal(s.segments[0].versions[0].review,'approved');
    const persisted=JSON.parse(await readFile(path.join(data,'pipeline.json'),'utf8'));assert.equal(persisted.projects[s.projectId].jobs.length,5);
    s=await ok({action:'split',script:'另一个故事。',count:1,replace:true});assert.equal(s.archives.length,1);
    s=await ok({action:'restore',id:s.archives[0].id});assert.equal(s.segments.length,2);assert.equal(s.segments[0].versions.length,1);
    assert.equal((await fetch(`${base}/api/pipeline`,{method:'POST',headers:{Origin:'https://foreign.invalid'},body:'{}'})).status,403);
  }finally{await stop();await rm(temp,{recursive:true,force:true});}
});

test('known live image task resumes after interruption and restart without a second submission',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'cutpot-cli-recovery-')),data=path.join(temp,'data'),fake=path.join(temp,'dreamina-test.mjs');
  const fixture=path.join(temp,'source.png'),counter=path.join(temp,'calls.jsonl'),failed=path.join(temp,'once');
  await command('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x90','-frames:v','1',fixture]);
  await writeFile(fake,`#!${process.execPath}\nimport{appendFileSync,existsSync,writeFileSync,copyFileSync}from'node:fs';\nimport path from'node:path';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(counter)},JSON.stringify(args)+'\\n');\nif(args[0]==='text2image'){console.log(JSON.stringify({submit_id:'retained-task-id',gen_status:'querying'}));}\nelse if(!existsSync(${JSON.stringify(failed)})){writeFileSync(${JSON.stringify(failed)},'failed');console.error('temporary query failure');process.exitCode=1;}\nelse{const i=args.indexOf('--download_dir');if(i>=0)copyFileSync(${JSON.stringify(fixture)},path.join(args[i+1],'candidate.png'));console.log(JSON.stringify({submit_id:'retained-task-id',gen_status:'success'}));}\n`);
  await chmod(fake,0o755);
  const port=String(24000+Math.floor(Math.random()*15000)),base=`http://127.0.0.1:${port}`;let child;
  const start=async()=>{child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:port,CUTPOT_DATA:data,CUTPOT_DREAMINA_BIN:fake},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`server exited ${code}`)));});};
  const stop=async()=>{if(child?.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}};
  const get=async()=> (await fetch(base+'/api/pipeline')).json();
  const act=async payload=>{const s=await get(),r=await fetch(base+'/api/pipeline',{method:'POST',body:JSON.stringify({...payload,projectId:s.projectId,revision:s.revision})});assert.equal(r.status,200);return r.json();};
  const waitStatus=async status=>{for(let i=0;i<100;i++){const s=await get();if(s.jobs[0]?.status===status)return s;await new Promise(r=>setTimeout(r,30));}assert.fail(`no ${status}`);};
  try{
    await start();let s=await act({action:'split',script:'测试任务恢复。',count:1});
    await act({action:'settings',settings:{...s.settings,mode:'live',candidates:1}});
    await act({action:'generate',kind:'image',ids:[s.shots[0].id],authorizeLive:true});
    s=await waitStatus('interrupted');assert.equal(s.jobs[0].externalId,'retained-task-id');
    await stop();await start();s=await get();assert.equal(s.jobs[0].status,'interrupted');
    await act({action:'resume',id:s.jobs[0].id});s=await waitStatus('completed');
    assert.equal(s.shots[0].versions.length,1);assert.equal(s.shots[0].versions[0].mode,'live');
    const calls=(await readFile(counter,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.filter(a=>a[0]==='text2image').length,1,'never resubmit a known paid task');
    assert.ok(calls.some(a=>a.includes('--download_dir')));
  }finally{await stop();await rm(temp,{recursive:true,force:true});}
});
