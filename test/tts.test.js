import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseMacVoices, parseEdgeVoices, voiceCategory, validateTTS, ttsVoices, synthesizeSpeech, checkSovits, validateDialogue } from '../src/tts.js';
import { run } from '../src/render.js';
import { loadSovitsSettings,saveSovitsSettings,sovitsSettingsStatus,validateSovitsSettings } from '../src/tts-config.js';

test('TTS validates text, provider, speed and voice catalog names',async()=>{
  assert.equal(validateTTS({text:'  你好  ',provider:'macos'}).text,'你好');
  for(const input of [{text:''},{text:'x'.repeat(10001)},{text:'x',provider:'unknown'},{text:'x',speed:0},{text:'x',voice:''}])assert.throws(()=>validateTTS(input));
  assert.deepEqual(parseMacVoices('Tingting       zh_CN    # 你好。\nEddy (中文（中国大陆）)    zh_CN    # 大家好。'),[
    {id:'Tingting',locale:'zh-CN',sample:'你好。'},{id:'Eddy (中文（中国大陆）)',locale:'zh-CN',sample:'大家好。'},
  ]);
  assert.equal(parseEdgeVoices('Name Gender ContentCategories\nzh-CN-XiaoxiaoNeural Female General Friendly')[0].id,'zh-CN-XiaoxiaoNeural');
  const calls=[];
  await assert.rejects(ttsVoices('edge',{execute:async(binary)=>{calls.push(binary);throw new Error('offline');}}),/未切换/);
  assert.equal(calls.length,1);assert.ok(!calls.includes('say'));
});

test('native child requires an open source reference voice and rejects Azure and pitch effects',()=>{
  const edge=parseEdgeVoices('zh-CN-YunxiaNeural Male General Cute');
  assert.equal(voiceCategory({voices:edge},'child').voices.length,0);
  assert.throws(()=>voiceCategory({voices:edge},'teen'));
  for(const input of [{provider:'azure'},{provider:'macos',target:'child'},{provider:'gpt-sovits',target:'child',preset:'child-soft'},{provider:'gpt-sovits',style:'chat'}])assert.throws(()=>validateTTS({text:'你好',...input}));
});

test('GPT-SoVITS config validates local endpoints, reference duration, persists and reloads',async t=>{
  try{await run('ffmpeg',['-version']);}catch{t.skip('FFmpeg unavailable');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-sovits-config-')),env={};
  try{
    assert.equal((await loadSovitsSettings(root,env)).configured,false);
    const reference=path.join(root,'reference.wav');
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=3.5',reference]);
    const input={referenceAudio:reference,promptText:'这是一段测试录音。',ageGroup:'child'};
    for(const endpoint of ['https://example.com','http://127.0.0.1:9880/tts','http://user:pass@localhost:9880','http://localhost:9880/?x=1'])assert.throws(()=>validateSovitsSettings({...input,endpoint}),/本机/);
    const result=await saveSovitsSettings(root,input,env);assert.equal(result.configured,true);
    assert.notEqual(result.referenceAudio,reference);assert.equal(result.ageGroup,'child');
    assert.equal((await stat(path.join(root,'gpt-sovits.json'))).mode&0o777,0o600);
    await rm(reference);assert.ok((await stat(result.referenceAudio)).size>0);
    const restart={};await loadSovitsSettings(root,restart);assert.deepEqual(sovitsSettingsStatus(restart),result);
    await assert.rejects(saveSovitsSettings(root,{...input,referenceAudio:root},env),/文件/);
    await assert.rejects(checkSovits({env:{},fetcher:()=>assert.fail('unconfigured must not connect')}),/未配置/);
    await assert.rejects(checkSovits({env,fetcher:async()=>{throw new Error('offline');}}),/无法连接/);
    await assert.rejects(checkSovits({env,fetcher:async()=>Response.json({paths:{}})}),/不兼容|不是兼容/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('GPT-SoVITS synthesis uses official JSON API, preserves child identity and refuses adult references',async t=>{
  try{await run('ffmpeg',['-version']);}catch{t.skip('FFmpeg unavailable');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-sovits-adapter-'));
  const input={endpoint:'http://127.0.0.1:9880',referenceAudio:'/tmp/reference.wav',promptText:'参考录音原文',ageGroup:'child'};
  const env={CUTPOT_SOVITS_SETTINGS:JSON.stringify(input)};
  try{
    const fixture=path.join(root,'audio.wav');await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=0.2',fixture]);
    let submissions=0;
    const fetcher=async(url,options)=>{
      assert.equal(options.redirect,'error');
      if(url.endsWith('/openapi.json'))return Response.json({paths:{'/tts':{post:{}}}});
      assert.equal(url,'http://127.0.0.1:9880/tts');submissions++;
      const payload=JSON.parse(options.body);assert.equal(payload.text,'你好 $(echo test)');assert.equal(payload.ref_audio_path,input.referenceAudio);assert.equal(payload.prompt_text,input.promptText);assert.equal(payload.speed_factor,.95);assert.equal(payload.streaming_mode,false);assert.equal(payload.text_lang,'zh');
      return new Response(await readFile(fixture));
    };
    const result=await synthesizeSpeech({text:'你好 $(echo test)',provider:'gpt-sovits',target:'child',speed:.95},root,{id:randomUUID()},new AbortController().signal,{fetcher,env});
    assert.equal(result.tts.ageGroup,'child');assert.equal(result.tts.classification,'user-reference');assert.equal(result.tts.preset,'natural');assert.equal(result.metadata.codec,'pcm_s16le');
    env.CUTPOT_SOVITS_SETTINGS=JSON.stringify({...input,ageGroup:'adult'});
    await assert.rejects(synthesizeSpeech({text:'你好',provider:'gpt-sovits',target:'child'},root,{id:randomUUID()},new AbortController().signal,{fetcher,env}),/未标记为儿童/);
    assert.equal(submissions,1);
    env.CUTPOT_SOVITS_SETTINGS=JSON.stringify(input);
    await assert.rejects(synthesizeSpeech({text:'你好',provider:'gpt-sovits'},root,{id:randomUUID()},new AbortController().signal,{env,fetcher:async(url)=>url.endsWith('/openapi.json')?Response.json({paths:{'/tts':{post:{}}}}):new Response('secret details',{status:500})}),/HTTP 500/);
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(synthesizeSpeech({text:'你好',provider:'gpt-sovits'},root,{id:randomUUID()},aborted.signal,{env,fetcher:async(_,opts)=>{opts.signal.throwIfAborted();}}));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('child-style effect raises measured pitch while preserving approximate duration',async t=>{
  try{await run('ffmpeg',['-version']);}catch{t.skip('FFmpeg not installed');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-child-style-'));
  try{
    const execute=async(binary,args,options)=>{
      if(args.includes('--list-voices'))return 'zh-CN-XiaoxiaoNeural Female General Friendly';
      if(args.includes('--write-media'))return run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1',args[args.indexOf('--write-media')+1]],options);
      return run(binary,args,options);
    };
    for(const preset of ['child-bright','child-soft']){
      const result=await synthesizeSpeech({text:'pitch test',provider:'edge',preset},root,{id:randomUUID()},new AbortController().signal,{execute});
      assert.ok(Math.abs(result.metadata.duration-1)<.06);
      const pcm=path.join(root,`${preset}.pcm`);await run('ffmpeg',['-v','error','-y','-i',result.file,'-f','s16le',pcm]);
      const bytes=await readFile(pcm);let crossings=0;
      for(let i=2;i<bytes.length;i+=2)if(bytes.readInt16LE(i-2)<=0&&bytes.readInt16LE(i)>0)crossings++;
      const frequency=crossings/(bytes.length/2/48000);
      assert.ok(Math.abs(frequency-(preset==='child-bright'?523:494))<10,`measured ${frequency} Hz`);
      assert.equal(result.tts.ageGroup,'unspecified');assert.equal(result.tts.preset,preset);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Edge adapter passes text by file and speed by argument without shell or fallback',async t=>{
  try{await run('ffmpeg',['-version']);}catch{t.skip('FFmpeg not installed');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-tts-adapter-')),calls=[];
  try{
    const text='测试 $(touch unsafe) `echo unsafe` < &';
    const execute=async(binary,args,options)=>{
      calls.push({binary,args});
      if(args.includes('--list-voices'))return 'zh-CN-XiaoxiaoNeural Female General Friendly';
      if(args.includes('--write-media')){
        assert.equal(await readFile(args[args.indexOf('--file')+1],'utf8'),text);
        assert.ok(args.includes('--rate=+20%'));assert.ok(!args.includes(text));
        return run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=0.1',args[args.indexOf('--write-media')+1]],options);
      }
      return run(binary,args,options);
    };
    const result=await synthesizeSpeech({text,provider:'edge',speed:1.2},root,{id:randomUUID()},new AbortController().signal,{execute});
    assert.equal(result.tts.provider,'edge');assert.equal(result.metadata.type,'audio');assert.ok(result.metadata.duration>0);
    assert.ok(calls.every(c=>c.binary!=='say'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('macOS TTS generates real non-silent Chinese WAV and removes temporary script',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS only');return;}
  let catalog;
  try{catalog=await ttsVoices('macos');await run('ffmpeg',['-version']);}catch{t.skip('local speech/FFmpeg unavailable');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-tts-real-'));
  try{
    const id=randomUUID();
    const result=await synthesizeSpeech({text:'你好，这是自动配音测试。',provider:'macos',voice:catalog.defaultVoice},root,{id},new AbortController().signal);
    assert.ok(result.metadata.duration>.2);
    assert.equal(result.metadata.codec,'pcm_s16le');
    const levels=await run('ffmpeg',['-v','error','-i',result.file,'-af','astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-','-f','null','-']);
    assert.match(levels,/Peak_level=-?\d/);
    await assert.rejects(readFile(path.join(root,'tts',id,'text.txt')),e=>e.code==='ENOENT');
  }finally{await rm(root,{recursive:true,force:true});}
});


test('multiple character profiles persist independently and concurrent updates retain all roles',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-characters-')),env={};
  try{
    const reference=path.join(root,'reference.wav');await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=3.5',reference]);
    const base={referenceAudio:reference,promptText:'参考原文。'};
    await Promise.all([
      saveSovitsSettings(root,{...base,characterId:'lele',characterName:'乐乐',ageGroup:'child'},env),
      saveSovitsSettings(root,{...base,characterId:'teacher',characterName:'老师',ageGroup:'adult'},env),
    ]);
    assert.equal(sovitsSettingsStatus(env).characters.length,2);
    await saveSovitsSettings(root,{...base,characterId:'lele',characterName:'乐乐新版',ageGroup:'child'},env);
    const restarted={};await loadSovitsSettings(root,restarted);
    assert.deepEqual(sovitsSettingsStatus(restarted).characters.map(c=>[c.id,c.name,c.ageGroup]),[['lele','乐乐新版','child'],['teacher','老师','adult']]);
    assert.equal(voiceCategory(await ttsVoices('gpt-sovits',{env:restarted}),'child').voices.length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('multi-character speech routes each line to its own frozen reference and aligns real WAV samples',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cutpot-dialogue-'));
  const characters=[{id:'lele',name:'乐乐',endpoint:'http://127.0.0.1:9880',referenceAudio:'/tmp/lele.wav',promptText:'儿童参考',ageGroup:'child'},{id:'teacher',name:'老师',endpoint:'http://127.0.0.1:9880',referenceAudio:'/tmp/teacher.wav',promptText:'成人参考',ageGroup:'adult'}];
  const env={CUTPOT_SOVITS_SETTINGS:JSON.stringify({characters})};
  try{
    const tones=[];
    for(const frequency of [440,660]){const file=path.join(root,`${frequency}.wav`);await run('ffmpeg',['-v','error','-y','-f','lavfi','-i',`sine=frequency=${frequency}:duration=0.2`,file]);tones.push(await readFile(file));}
    const calls=[];
    const fetcher=async(url,opts)=>{
      if(url.endsWith('/openapi.json'))return Response.json({paths:{'/tts':{post:{}}}});
      const body=JSON.parse(opts.body);calls.push(body);
      env.CUTPOT_SOVITS_SETTINGS=JSON.stringify({characters:[{...characters[0],referenceAudio:'/tmp/changed.wav'},characters[1]]});
      return new Response(tones[body.ref_audio_path==='/tmp/teacher.wav'?1:0]);
    };
    const lines=[{characterId:'lele',text:'你好',start:0,duration:.3},{characterId:'teacher',text:'大家好',start:.6},{characterId:'lele',text:'一起玩吧'}];
    const result=await synthesizeSpeech({lines},root,{id:randomUUID()},new AbortController().signal,{env,fetcher});
    assert.deepEqual(calls.map(c=>c.ref_audio_path),['/tmp/lele.wav','/tmp/teacher.wav','/tmp/lele.wav']);
    assert.deepEqual(result.tts.lines.map(l=>l.characterId),['lele','teacher','lele']);
    assert.ok(Math.abs(result.metadata.duration-1.2)<.005);
    const pcm=path.join(root,'output.pcm');await run('ffmpeg',['-v','error','-y','-i',result.file,'-f','s16le',pcm]);const bytes=await readFile(pcm);
    const frequencyAt=time=>{let crossings=0;for(let n=Math.round(time*48000);n<Math.round((time+.1)*48000);n++)if(bytes.readInt16LE(n*2)<=0&&bytes.readInt16LE((n+1)*2)>0)crossings++;return crossings*10;};
    assert.ok(Math.abs(frequencyAt(.04)-440)<20);assert.ok(Math.abs(frequencyAt(.64)-660)<20);assert.equal(frequencyAt(.35),0);assert.ok(Math.abs(frequencyAt(1.04)-440)<20);
    assert.throws(()=>validateDialogue({lines:[{characterId:'lele',text:'x',start:-1}]}));
    let submissions=0;
    await assert.rejects(synthesizeSpeech({lines:[{characterId:'missing',text:'你好'}]},root,{id:randomUUID()},new AbortController().signal,{env,fetcher:()=>{submissions++;}}),/角色音色不存在/);assert.equal(submissions,0);
    await assert.rejects(synthesizeSpeech({lines:[{characterId:'lele',text:'太长',duration:.1}]},root,{id:randomUUID()},new AbortController().signal,{env,fetcher}),/超出指定时长/);
  }finally{await rm(root,{recursive:true,force:true});}
});
