import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { run, probe, renderProject } from '../src/render.js';
import { defaultProject, validateProject } from '../src/project.js';

test('real FFmpeg export: mixed sources, original audio, narration, music, exact frames and cache reuse',async t=>{
  try{await run('ffmpeg',['-version']);}catch{t.skip('FFmpeg is not installed');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-render-'));
  try{
    const video=path.join(root,'source.mp4'),image=path.join(root,'still.png'),voice=path.join(root,'voice.wav');
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=red:s=320x240:r=30:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',video]);
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=240x320','-frames:v','1',image]);
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=660:duration=0.5',voice]);
    const assets=await Promise.all([[video,'v'],[image,'i'],[voice,'a']].map(async([file,id])=>({id,path:file,name:path.basename(file),sha256:id,...await probe(file)})));
    const p=validateProject({...defaultProject(),width:1280,height:720,narration:'a',music:'a',clips:[{id:randomUUID(),assetId:'v',sourceIn:.12,duration:.64,muted:false,subtitle:'有声视频'},{id:randomUUID(),assetId:'i',sourceIn:0,duration:.36,subtitle:'静态镜头'}]},assets);
    const job={id:randomUUID(),status:'running'};await renderProject(p,assets,root,job,new AbortController().signal);
    assert.equal(job.status,'completed');
    const out=path.join(root,'exports',job.id,'film.mp4');
    const data=JSON.parse(await run('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',out]));
    const stream=data.streams.find(s=>s.codec_type==='video');
    assert.equal(Number(stream.nb_read_frames),25);assert.equal(stream.width,1280);assert.equal(stream.height,720);
    assert.equal(Number(stream.start_time),0);
    assert.ok(data.streams.some(s=>s.codec_type==='audio'));
    assert.ok(Math.abs(Number(data.format.duration)-1)<.005);
    // Full decode catches timestamp or concatenation failures that metadata alone misses.
    await run('ffmpeg',['-v','error','-i',out,'-f','null','-']);
    assert.match(await readFile(path.join(root,'exports',job.id,'subtitles.srt'),'utf8'),/00:00:00,640 --> 00:00:01,000/);
    const cache=await readdir(path.join(root,'cache'));
    const second={id:randomUUID(),status:'running'};await renderProject({...p,narration:null,music:null},assets,root,second,new AbortController().signal);
    assert.deepEqual(await readdir(path.join(root,'cache')),cache);
    const silent=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path.join(root,'exports',second.id,'film.mp4')]));
    assert.equal(Number(silent.streams.find(s=>s.codec_type==='video').start_time),0);
    assert.equal(Number(silent.format.duration),1);
    const burned={id:randomUUID(),status:'running'};
    await renderProject({...p,burnSubtitles:true,clips:p.clips.map((c,i)=>({...c,subtitle:i===0?'中文字幕 \\ {安全} < &':' ' })),narration:null,music:null},assets,root,burned,new AbortController().signal);
    const burnedFile=path.join(root,'exports',burned.id,'film.mp4');
    assert.equal(JSON.parse(await readFile(path.join(root,'exports',burned.id,'report.json'),'utf8')).burnSubtitles,true);
    const bright=async(time)=>{
      const file=path.join(root,`frame-${time}.raw`);
      await run('ffmpeg',['-v','error','-y','-ss',String(time),'-i',burnedFile,'-frames:v','1','-vf','crop=1280:200:0:520,format=gray','-f','rawvideo',file]);
      return [...await readFile(file)].filter(v=>v>220).length;
    };
    assert.ok(await bright(.2)>100,'caption pixels must exist in video');
    assert.equal(await bright(.8),0,'blank next clip must not retain caption pixels');
    const burnedData=JSON.parse(await run('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',burnedFile]));
    assert.equal(Number(burnedData.streams.find(s=>s.codec_type==='video').nb_read_frames),25);
    assert.equal(Number(burnedData.streams.find(s=>s.codec_type==='video').start_time),0);
    const beforeEdit=await readdir(path.join(root,'cache'));
    await renderProject({...p,burnSubtitles:true,clips:p.clips.map(c=>({...c,subtitle:'修改后的字幕'}))},assets,root,{id:randomUUID()},new AbortController().signal);
    assert.ok((await readdir(path.join(root,'cache'))).length>beforeEdit.length,'caption changes must invalidate cached video');

  }finally{await rm(root,{recursive:true,force:true});}
});
test('cancellation terminates the worker process',async()=>{
  const controller=new AbortController();
  const task=run(process.execPath,['-e','setTimeout(()=>{},10000)'],{signal:controller.signal});
  controller.abort();await assert.rejects(task,e=>e.name==='AbortError');
});
