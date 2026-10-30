import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/render.js';

const entry=fileURLToPath(new URL('../bin/cutpot-cli.js',import.meta.url));
async function cli(args,base,expected=0){
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,...(base?['--url',base]:[]),'--json',...args]);
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.once('error',reject);child.once('exit',code=>resolve({code,out,err}));
  });
  assert.equal(result.code,expected,`${args.join(' ')}\n${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('CLI help, unknown options and error outputs are script-friendly',async()=>{
  assert.match((await cli(['--help'])).help,/compose FILE/);
  assert.match((await cli(['--help'])).help,/validate MANIFEST/);
  assert.equal((await cli(['--version'])).version,'0.9.0');
  const unknown=await cli(['not-a-command'],null,1);
  assert.match(unknown.error,/未知命令/);
  assert.equal(unknown.code,'UNKNOWN_COMMAND');
  assert.equal(unknown.retryable,false);
  assert.match((await cli(['clip','edit','1','--frobnicate'],null,1)).error,/Unknown option/);
  assert.match((await cli(['status','--url','https://example.com'],null,1)).error,/仅支持/);
  assert.match((await cli(['export','--no-wait','-o','ignored.mp4'],null,1)).error,/不能与/);
  const caps=await cli(['capabilities']);
  assert.equal(caps.app,'cutpot');
  assert.ok(caps.commands.includes('validate'));
  assert.ok(caps.features.dryRun);
  assert.equal((await cli(['schema','manifest'])).kind,'cutpot.render.manifest');
});

test('CLI real editing + composition + manifest + downloads preserve current workbench project',async t=>{
  try{await run('ffmpeg',['-version']);await run('ffprobe',['-version']);}catch{t.skip('FFmpeg/ffprobe not installed');return;}
  const temp=await mkdtemp(path.join(os.tmpdir(),"cutpot cli 'case'-"));
  const data=path.join(temp,'data'),port=String(22000+Math.floor(Math.random()*18000)),base=`http://127.0.0.1:${port}`;
  try{
    const started=await cli(['start','--port',port,'--data',data],base);assert.equal(started.dataDir,data);
    assert.equal((await cli(['status'],base)).running,true);
    const doctor=await cli(['doctor'],base);
    assert.equal(doctor.ok,true);
    assert.equal(doctor.dependencies.ffmpeg.ready,true);
    assert.ok(doctor.dependencies.burnSubtitles);
    const video=path.join(temp,'shot_02 with space.mp4'),image=path.join(temp,'分镜01.png'),audio=path.join(temp,'voice.wav');
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=red:s=160x120:r=30:d=1','-c:v','libx264',video]);
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=120x160','-frames:v','1',image]);
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=0.2',audio]);
    assert.equal((await cli(['probe',video],base)).type,'video');
    const imported=await cli(['assets','import',video,image,audio],base);assert.equal(imported.length,3);
    assert.equal((await cli(['assets','import',image],base))[0].id,imported[1].id);
    await cli(['project','new','--name','CLI test','--resolution','1280x720'],base);
    await cli(['clip','add',imported[0].id,'--duration','0.4','--in','0.2'],base);
    await cli(['clip','add',imported[1].id,'--duration','0.6','--subtitle','最初字幕'],base);
    await cli(['arrange'],base);
    let clips=await cli(['clip','list'],base);assert.equal(clips[0].assetId,imported[1].id);
    const special='文字 $(touch unsafe) `echo unsafe` < &';
    await cli(['clip','edit','1','--subtitle',special,'--title','自定义镜头'],base);
    await cli(['clip','edit','1','--lock'],base);
    assert.match((await cli(['clip','remove','1'],base,1)).error,/锁定/);
    assert.match((await cli(['clip','move','2','--to','1'],base,1)).error,/锁定/);
    await cli(['clip','edit','1','--unlock'],base);
    await cli(['clip','duplicate','1'],base);await cli(['clip','remove','2'],base);
    await cli(['clip','move','1','--to','2'],base);
    await cli(['audio','set','--narration',imported[2].id,'--music',imported[2].id,'--music-volume','0.08'],base);
    const saved=path.join(temp,'saved.json');await cli(['project','save',saved],base);
    const before=await cli(['project','show'],base);assert.equal(before.clips[1].subtitle,special);
    assert.match((await cli(['project','new'],base,1)).error,/--force/);
    assert.match((await cli(['clip','edit','1','--duration','5'],base,1)).error,/超出/);
    const state=await (await fetch(`${base}/api/state`)).json();
    assert.equal((await fetch(`${base}/api/project`,{method:'PUT',headers:{'If-Match':'stale'},body:JSON.stringify(state.project)})).status,409);
    const output=path.join(temp,'final.mp4');const exported=await cli(['export','--burn-subtitles','-o',output],base);
    assert.equal(exported.status,'completed');assert.equal(exported.output,output);assert.equal(JSON.parse(await readFile(exported.report,'utf8')).burnSubtitles,true);
    assert.match(await readFile(exported.subtitles,'utf8'),/文字 \$\(touch unsafe\)/);
    const metadata=JSON.parse(await run('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',output]));
    assert.equal(Number(metadata.format.duration),1);assert.equal(Number(metadata.streams.find(s=>s.codec_type==='video').nb_read_frames),25);
    assert.match((await cli(['export','-o',output],base,1)).error,/已存在/);
    await cli(['compose',video,image,'--duration','.4','--resolution','1280x720','--music',audio,'-o',path.join(temp,'compose.mp4')],base);
    assert.deepEqual(await cli(['project','show'],base),before);
    const manifest=path.join(temp,'manifest.json');
    await writeFile(manifest,JSON.stringify({name:'manifest',resolution:'1280x720',fps:25,narration:'voice.wav',clips:[{file:path.basename(video),sourceIn:.12,duration:.4},{file:'分镜01.png',duration:.6,subtitle:'清单字幕'}]}));
    const checked=await cli(['validate',manifest],base);assert.equal(checked.ok,true);assert.equal(checked.summary.clips,2);
    const dry=await cli(['render',manifest,'--dry-run','-o',path.join(temp,'planned.mp4')],base);
    assert.equal(dry.ok,true);assert.equal(dry.dryRun,true);assert.equal(dry.imported,false);assert.equal(dry.frames,25);
    assert.deepEqual(await cli(['project','show'],base),before);
    const rendered=await cli(['render',manifest,'-o',path.join(temp,'manifest.mp4')],base);assert.equal(rendered.status,'completed');
    assert.deepEqual(await cli(['project','show'],base),before);
    await cli(['project','new','--force'],base);await cli(['project','open',saved],base);
    assert.equal((await cli(['clip','list'],base)).length,2);
    const queued=await cli(['export','--no-wait'],base);assert.equal(queued.status,'running');
    assert.equal((await cli(['job',queued.id],base)).id,queued.id);
    const waited=await cli(['job','wait',queued.id],base);assert.equal(waited.status,'completed');
    await cli(['download',queued.id,'-o',path.join(temp,'async.mp4')],base);
    assert.equal((await cli(['jobs'],base)).length,4);
    const timeout=await cli(['compose',image,'--duration','3600','--resolution','1920x1080','--timeout','0.1','-o',path.join(temp,'timeout.mp4')],base,1);
    assert.match(timeout.error,/^等待超时/);
    const waitCancelled=async id=>{
      for(let i=0;i<100;i++){
        const job=await cli(['job',id],base);
        if(job.status==='cancelled')return;
        assert.equal(job.status,'running',job.message);
        await new Promise(r=>setTimeout(r,20));
      }
      assert.fail('Render cancellation did not finish');
    };
    await waitCancelled((await cli(['jobs'],base)).at(-1).id);
    const cancellable=await cli(['compose',image,'--duration','3600','--resolution','1920x1080','--no-wait'],base);
    assert.match((await cli(['stop'],base,1)).error,/正在导出/);
    await cli(['cancel',cancellable.id],base);await waitCancelled(cancellable.id);
    // Files remain downloadable even though in-memory job history is reset on restart.
    await cli(['stop'],base);
    for(let i=0;i<50;i++){if(!(await cli(['status'],base)).running)break;await new Promise(r=>setTimeout(r,50));}
    await cli(['start','--port',port,'--data',data],base);
    await cli(['download',rendered.id,'-o',path.join(temp,'after-restart.mp4')],base);
    assert.deepEqual(await cli(['jobs'],base),[]);
  }finally{
    try{await cli(['stop','--force'],base);}catch{}
    await rm(temp,{recursive:true,force:true});
  }
});

test('CLI TTS produces downloadable narration, attaches safely, exports and supports cancellation',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS speech integration');return;}
  try{await run('say',['-v','?']);await run('ffmpeg',['-version']);}catch{t.skip('local speech/FFmpeg unavailable');return;}
  const temp=await mkdtemp(path.join(os.tmpdir(),'cutpot-tts-cli-'));
  const port=String(22000+Math.floor(Math.random()*18000)),base=`http://127.0.0.1:${port}`;
  try{
    await cli(['start','--port',port,'--data',path.join(temp,'data')],base);
    assert.ok((await cli(['tts','providers'],base)).providers.some(p=>p.id==='macos'&&p.available));
    const voices=await cli(['tts','voices','--provider','macos'],base);assert.ok(voices.voices.some(v=>v.locale==='zh-CN'));
    assert.equal((await cli(['tts','config'],base)).configured,false);
    const childOnly=await cli(['tts','voices','--provider','macos','--category','child'],base);assert.equal(childOnly.voices.length,0);assert.match(childOnly.notice,/没有儿童参考/);
    const image=path.join(temp,'still.png');
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x120','-frames:v','1',image]);
    const [a]=await cli(['assets','import',image],base);
    await cli(['project','new','--resolution','1280x720'],base);
    await cli(['clip','add',a.id,'--duration','5'],base);
    const output=path.join(temp,'voice.wav');
    const generated=await cli(['tts','generate','--text','你好。','--voice',voices.defaultVoice,'--preset','child-bright','--speed','1.2','-o',output,'--attach'],base);
    assert.equal(generated.status,'completed');assert.equal(generated.attached,true);
    assert.ok(generated.duration>.1);assert.equal(generated.asset.tts.provider,'macos');
    assert.equal(generated.asset.tts.preset,'child-bright');
    const rejectedReference=await fetch(`${base}/api/tts/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({referenceAssetId:generated.asset.id,promptText:'你好。',ageGroup:'child'})});
    assert.equal(rejectedReference.status,400);assert.match((await rejectedReference.json()).error,/成人或变调/);
    assert.equal((await cli(['project','show'],base)).narration,generated.asset.id);
    assert.equal((await cli(['probe',output],base)).type,'audio');
    await cli(['tts','download',generated.id,'-o',path.join(temp,'downloaded.wav')],base);
    assert.match((await cli(['tts','generate','--text','你好。','-o',output],base,1)).error,/已存在/);
    assert.match((await cli(['tts','generate','--text','x','--file',output],base,1)).error,/只能指定/);
    assert.match((await cli(['tts','generate','--text','x','--provider','unknown'],base,1)).error,/仅支持/);
    const invalid=await cli(['tts','generate','--text','x','--voice','missing-voice'],base,1);
    assert.match(invalid.error,/音色不存在/);
    const film=await cli(['export','-o',path.join(temp,'spoken-film.mp4')],base);assert.equal(film.status,'completed');
    const textFile=path.join(temp,'script.txt');await writeFile(textFile,'这段文字用于测试取消。'.repeat(500));
    const pending=await cli(['tts','generate','--file',textFile,'--no-wait'],base);
    assert.equal(pending.status,'running');
    assert.match((await cli(['stop'],base,1)).error,/配音/);
    await cli(['tts','cancel',pending.id],base);
    let cancelled;
    for(let i=0;i<100;i++){cancelled=await cli(['tts','job',pending.id],base);if(cancelled.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(cancelled.status,'cancelled');
    await cli(['audio','set','--narration','none'],base);
    await cli(['clip','edit','1','--duration','0.04'],base);
    const tooLong=await cli(['tts','generate','--text','你好。','--attach','-o',path.join(temp,'too-long.wav')],base,1);
    assert.match(tooLong.error,/配音已生成.*设置旁白失败/);
    assert.equal((await cli(['project','show'],base)).narration,null);
    assert.match((await cli(['tts','generate','--text','你好','--target','child','--provider','macos'],base,1)).error,/原生儿童/);
    assert.equal((await cli(['tts','config'],base)).configured,false);
    assert.match((await cli(['tts','configure','--reference-audio',output,'--prompt-text','你好','--age-group','child'],base,1)).error,/3—10/);
    assert.match((await cli(['tts','voices','--provider','azure'],base,1)).error,/未知/);
  }finally{
    try{await cli(['stop','--force'],base);}catch{}
    await rm(temp,{recursive:true,force:true});
  }
});


test('CLI GPT-SoVITS reference configuration, HTTP synthesis, attachment, export and reload',async t=>{
  try{await run('ffmpeg',['-version']);}catch{t.skip('FFmpeg unavailable');return;}
  const temp=await mkdtemp(path.join(os.tmpdir(),'cutpot-sovits-cli-'));
  const port=String(22000+Math.floor(Math.random()*18000)),base=`http://127.0.0.1:${port}`,data=path.join(temp,'data');
  const reference=path.join(temp,'child-reference.wav'),fixture=path.join(temp,'synthesized.wav');
  let payload;
  const backend=http.createServer(async(req,res)=>{
    try{
      if(req.url==='/openapi.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({paths:{'/tts':{post:{}}}}));return;}
      assert.equal(req.method,'POST');assert.equal(req.url,'/tts');
      const chunks=[];for await(const c of req)chunks.push(c);payload=JSON.parse(Buffer.concat(chunks));
      res.setHeader('Content-Type','audio/wav');res.end(await readFile(fixture));
    }catch{res.statusCode=500;res.end();}
  });
  try{
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=3.5',reference]);
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=500:duration=0.2',fixture]);
    await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
    const endpoint=`http://127.0.0.1:${backend.address().port}`;
    await cli(['start','--port',port,'--data',data],base);
    const conf=await cli(['tts','configure','--endpoint',endpoint,'--reference-audio',reference,'--prompt-text','这是参考原文。','--age-group','child'],base);
    assert.equal(conf.configured,true);assert.equal(conf.ageGroup,'child');
    assert.ok((await cli(['tts','providers'],base)).providers.some(p=>p.id==='gpt-sovits'&&p.available));
    assert.ok(!(await cli(['tts','providers'],base)).providers.some(p=>p.id==='azure'));
    const voices=await cli(['tts','voices','--provider','gpt-sovits','--category','child'],base);
    assert.equal(voices.voices[0].classification,'user-reference');
    const image=path.join(temp,'still.png');await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x120','-frames:v','1',image]);
    const [asset]=await cli(['assets','import',image],base);await cli(['clip','add',asset.id,'--duration','1'],base);
    const result=await cli(['tts','generate','--provider','gpt-sovits','--target','child','--text','一起学习吧。','--attach','-o',path.join(temp,'narration.wav')],base);
    assert.equal(result.status,'completed');assert.equal(result.asset.tts.ageGroup,'child');
    assert.equal(payload.text,'一起学习吧。');assert.equal(payload.prompt_text,'这是参考原文。');assert.equal(payload.ref_audio_path,conf.referenceAudio);
    assert.equal((await cli(['project','show'],base)).narration,result.asset.id);
    await cli(['tts','configure','--endpoint',endpoint,'--reference-audio',reference,'--prompt-text','老师参考原文','--age-group','adult','--character-id','teacher','--character-name','老师'],base);
    assert.equal((await cli(['tts','config'],base)).characters.length,2);
    const script=path.join(temp,'dialogue.json');await writeFile(script,JSON.stringify({lines:[{characterId:'reference',text:'学生提问',start:0},{characterId:'teacher',text:'老师回答',start:.4},{characterId:'reference',text:'学生回应',start:.8}]}));
    const dialogue=await cli(['tts','generate','--dialogue',script,'--attach','-o',path.join(temp,'dialogue.wav')],base);
    assert.equal(dialogue.asset.tts.mode,'dialogue');assert.deepEqual(dialogue.asset.tts.lines.map(l=>l.characterId),['reference','teacher','reference']);
    assert.equal((await cli(['export','-o',path.join(temp,'film.mp4')],base)).status,'completed');
    await cli(['stop'],base);await cli(['start','--port',port,'--data',data],base);
    assert.equal((await cli(['tts','config'],base)).referenceAudio,conf.referenceAudio);
  }finally{
    try{await cli(['stop','--force'],base);}catch{}
    backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));await rm(temp,{recursive:true,force:true});
  }
});
