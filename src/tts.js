import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, probe } from './render.js';
import { sovitsConfig, sovitsCharacters } from './tts-config.js';

export const defaultTTSProvider = () => process.env.CUTPOT_TTS_PROVIDER || 'macos';
export function edgeCommand({env=process.env,exists=existsSync}={}){
  const managed=fileURLToPath(new URL('../.cutpot/tts-runtime/bin/edge-tts',import.meta.url));
  return env.CUTPOT_EDGE_TTS || (exists(managed)?managed:'edge-tts');
}
export const voicePresets = [
  {id:'natural',name:'原始音色',kind:'original',semitones:0},
  {id:'child-bright',name:'童声风格 · 明亮',kind:'processed',semitones:3},
  {id:'child-soft',name:'童声风格 · 柔和',kind:'processed',semitones:2},
];
export async function checkSovits({signal,fetcher=fetch,env=process.env,voice}={}){
  const config=sovitsConfig(env,voice);
  let res;
  try{res=await fetcher(`${config.endpoint}/openapi.json`,{signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(5000)]),redirect:'error'});}
  catch{throw new Error('无法连接 GPT-SoVITS，请启动本机 api_v2.py（默认端口 9880）');}
  if(!res.ok)throw new Error(`GPT-SoVITS 服务检查失败（HTTP ${res.status}）`);
  const schema=await res.json();
  if(!schema.paths?.['/tts']?.post)throw new Error('服务不是兼容的 GPT-SoVITS api_v2：缺少 POST /tts');
  return config;
}
export function voiceCategory(catalog,category='all'){
  if(!['all','child'].includes(category))throw new Error('音色分类仅支持 all 或 child');
  if(category==='all')return catalog;
  const voices=catalog.voices.filter(v=>v.ageGroup==='child');
  return {...catalog,category,voices,defaultVoice:voices.some(v=>v.id===catalog.defaultVoice)?catalog.defaultVoice:voices[0]?.id??null,
    notice:voices.length?undefined:'当前服务没有儿童参考音色，请在 GPT-SoVITS 中添加儿童参考录音。'};
}
export function parseMacVoices(output) {
  return output.split('\n').flatMap(line => {
    const match=/^(.+?)\s+([a-z]{2,3}_[A-Z\d]+)\s+#\s*(.*)$/.exec(line);
    return match ? [{id:match[1].trim(),locale:match[2].replace('_','-'),sample:match[3]}] : [];
  });
}

export function parseEdgeVoices(output) {
  return output.split('\n').flatMap(line => {
    const match=/^([a-z]{2,3}-[A-Za-z\d]+-[\w-]+Neural)\s+(Male|Female)\b/.exec(line.trim());
    return match ? [{id:match[1],locale:match[1].split('-').slice(0,2).join('-'),gender:match[2]}] : [];
  });
}

export function validateTTS(input) {
  const provider=input?.provider ?? defaultTTSProvider();
  if(!['macos','edge','gpt-sovits'].includes(provider))throw new Error('TTS 服务仅支持 macos、edge 或 gpt-sovits');
  if(typeof input?.text!=='string'||!input.text.trim()||input.text.length>10000)throw new Error('配音文字需要 1—10000 个字符');
  const speed=Number(input.speed??1);
  if(!Number.isFinite(speed)||speed<0.5||speed>2)throw new Error('语速倍率需在 0.5—2 之间');
  if(input.voice!==undefined&&(typeof input.voice!=='string'||!input.voice.trim()||input.voice.length>160))throw new Error('音色名称无效');
  const preset=input.preset??'natural';
  if(!voicePresets.some(p=>p.id===preset))throw new Error('未知声音效果，请使用 natural、child-bright 或 child-soft');
  const target=input.target??'general',style=input.style??'neutral';
  if(!['general','child'].includes(target))throw new Error('配音目标仅支持 general 或 child');
  if(typeof style!=='string'||!/^[\w-]{1,40}$/.test(style))throw new Error('说话风格无效');
  if(target==='child'&&(provider!=='gpt-sovits'||preset!=='natural'))throw new Error('原生儿童模式必须使用 GPT-SoVITS 儿童参考音色，不支持成人变调替代');
  if(style!=='neutral')throw new Error('当前服务只支持 neutral；自然语气由参考录音决定');
  return {provider,text:input.text.trim(),voice:input.voice,speed,preset,target,style,name:path.basename(String(input.name||'自动配音.wav')).slice(0,120)};
}

export async function ttsProviders(execute=run) {
  const providers=await Promise.all(['macos','edge','gpt-sovits'].map(async id=>{
    const result={id,name:{macos:'macOS 本地语音',edge:'Edge 在线语音','gpt-sovits':'GPT-SoVITS 开源配音'}[id],requiresNetwork:id==='edge',available:false};
    try{
      if(id==='macos'){
        if(process.platform!=='darwin')throw new Error('macOS 本地语音仅支持 macOS');
        const voices=parseMacVoices(await execute('say',['-v','?'],{signal:AbortSignal.timeout(10000)}));
        if(!voices.length)throw new Error('系统没有可用音色');
      }else if(id==='edge')await execute(edgeCommand(),['--version'],{signal:AbortSignal.timeout(10000)});
      else await checkSovits();
      result.available=true;
    }catch(e){result.reason=id==='edge'?'未找到可用的 edge-tts；安装后重启服务，或配置 CUTPOT_EDGE_TTS':e.message;}
    return result;
  }));
  return {defaultProvider:defaultTTSProvider(),providers};
}

export async function ttsVoices(provider=defaultTTSProvider(), {signal, execute=run,fetcher=fetch,env=process.env}={}) {
  if(!['macos','edge','gpt-sovits'].includes(provider))throw new Error('未知 TTS 服务');
  const bounded=AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(30000)]);
  if(provider==='macos'&&process.platform!=='darwin')throw new Error('macOS 语音在当前系统不可用，请明确选择可用服务');
  if(provider==='gpt-sovits'){
    const characters=sovitsCharacters(env);
    return {provider,requiresNetwork:false,defaultVoice:characters[0].id,voices:characters.map(c=>({id:c.id,locale:'zh-CN',displayName:`${c.name} · ${c.ageGroup==='child'?'儿童参考音色':'成人参考音色'}`,ageGroup:c.ageGroup,classification:'user-reference',styles:[]})),presets:voicePresets};
  }
  let output;
  try{output=await execute(provider==='macos'?'say':edgeCommand(),provider==='macos'?['-v','?']:['--list-voices'],{signal:bounded});}
  catch(e){throw new Error(`${provider} 音色加载失败：${e.message}。未切换其他服务。`);}
  const voices=provider==='macos'?parseMacVoices(output):parseEdgeVoices(output);
  if(!voices.length)throw new Error(`${provider} 未返回可用音色`);
  const preferred=provider==='macos'?'Tingting':'zh-CN-XiaoxiaoNeural';
  return {provider,requiresNetwork:provider==='edge',defaultVoice:voices.find(v=>v.id===preferred)?.id??voices.find(v=>v.locale==='zh-CN')?.id??voices[0].id,voices,presets:voicePresets};
}

// Text is passed through a UTF-8 file, never through shell interpolation or a command argument.
export async function synthesizeSpeech(input, root, job, signal, {execute=run,fetcher=fetch,env=process.env}={}) {
  env={...env}; // Freeze reference identity for the whole job, including concurrent configuration changes.
  if(input?.lines)return synthesizeDialogue(input,root,job,signal,{execute,fetcher,env});
  const options=validateTTS(input);
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(10*60*1000)]);
  const work=path.join(root,'tts',job.id),output=path.join(root,'media',`tts-${job.id}.wav`);
  await mkdir(work,{recursive:true});await mkdir(path.dirname(output),{recursive:true});
  let succeeded=false;
  try{
    job.message='加载音色';job.progress=5;
    const catalog=await ttsVoices(options.provider,{signal:bounded,execute,fetcher,env});
    if(options.target==='child'&&!catalog.voices.some(v=>v.ageGroup==='child'))throw new Error('当前参考音频未标记为儿童，请配置儿童原声参考录音');
    const voice=options.voice??(options.target==='child'?catalog.voices.find(v=>v.id===catalog.defaultVoice&&v.ageGroup==='child')?.id??catalog.voices.find(v=>v.ageGroup==='child')?.id:catalog.defaultVoice);
    if(!catalog.voices.some(v=>v.id===voice))throw new Error(`音色不存在：${voice}；请先查询 tts voices`);
    const selected=catalog.voices.find(v=>v.id===voice);
    if(options.target==='child'&&selected.ageGroup!=='child')throw new Error('原生儿童模式不能使用成人参考音频，已停止生成');
    if(options.style!=='neutral'&&!selected.styles?.includes(options.style))throw new Error(`所选音色不支持 ${options.style} 风格，请按音色目录选择`);
    const textFile=path.join(work,'text.txt');await writeFile(textFile,options.text,'utf8');
    job.message=`正在生成配音 · ${voice}`;job.progress=15;
    const raw=path.join(work,options.provider==='macos'?'speech.aiff':options.provider==='gpt-sovits'?'speech.wav':'speech.mp3');
    if(options.provider==='macos')await execute('say',['-v',voice,'-r',String(Math.round(180*options.speed)),'-f',textFile,'-o',raw],{signal:bounded});
    else if(options.provider==='edge'){
      const percent=Math.round((options.speed-1)*100);
      try{await execute(edgeCommand(),['--voice',voice,`--rate=${percent>=0?'+':''}${percent}%`,'--file',textFile,'--write-media',raw],{signal:bounded});}
      catch(e){if(e.message.includes('403'))throw new Error('Edge 语音服务拒绝请求（HTTP 403）；请更新客户端或检查服务状态，未切换其他服务');throw new Error('Edge 未能生成音频，请检查网络与客户端；未切换其他服务');}
    }else{
      const config=await checkSovits({env,voice,fetcher,signal:bounded});
      const res=await fetcher(`${config.endpoint}/tts`,{signal:bounded,redirect:'error',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:options.text,text_lang:'zh',ref_audio_path:config.referenceAudio,prompt_text:config.promptText,prompt_lang:'zh',text_split_method:'cut5',batch_size:1,speed_factor:options.speed,media_type:'wav',streaming_mode:false,seed:42})});
      if(!res.ok)throw new Error(`GPT-SoVITS 生成失败（HTTP ${res.status}），请检查模型和参考音频；未切换其他服务`);
      await writeFile(raw,Buffer.from(await res.arrayBuffer()));
    }
    bounded.throwIfAborted();job.message='转换并校验配音';job.progress=80;
    const preset=voicePresets.find(p=>p.id===options.preset),args=['-hide_banner','-loglevel','error','-y','-i',raw,'-vn'];
    if(preset.semitones){
      const rate=Math.round(48000*2**(preset.semitones/12));
      args.push('-af',`aresample=48000,asetrate=${rate},aresample=48000,atempo=${48000/rate}`);
    }
    args.push('-ar','48000','-ac','1','-c:a','pcm_s16le',output);
    await execute('ffmpeg',args,{signal:bounded});
    const metadata=await probe(output);bounded.throwIfAborted();
    if(metadata.type!=='audio'||!Number.isFinite(metadata.duration)||metadata.duration<=0)throw new Error('TTS 未生成有效音频');
    succeeded=true;
    return {file:output,name:options.name.replace(/\.(wav|mp3|aiff?)$/i,'')+'.wav',metadata,tts:{provider:options.provider,voice,speed:options.speed,preset:options.preset,target:options.target,style:options.style,ageGroup:selected.ageGroup??'unspecified',classification:selected.classification??'provider',characterId:options.provider==='gpt-sovits'?voice:null,characterName:options.provider==='gpt-sovits'?sovitsConfig(env,voice).name:null}};
  }finally{
    await rm(work,{recursive:true,force:true});
    if(!succeeded)await rm(output,{force:true});
  }
}

export function validateDialogue(input){
  if(!Array.isArray(input?.lines)||!input.lines.length||input.lines.length>200)throw new Error('多角色台词需要 1–200 段');
  if(input.provider&&input.provider!=='gpt-sovits')throw new Error('多角色配音需要 gpt-sovits');
  let total=0;
  const lines=input.lines.map((line,index)=>{
    if(typeof line?.characterId!=='string'||!/^[-a-zA-Z0-9_]{1,60}$/.test(line.characterId))throw new Error(`第 ${index+1} 段缺少有效角色 ID`);
    const valid=validateTTS({text:line.text,provider:'gpt-sovits',speed:line.speed??input.speed??1});total+=valid.text.length;
    if(total>10000)throw new Error('台词总长度最多 10000 字符');
    for(const key of ['start','duration'])if(line[key]!==undefined&&(typeof line[key]!=='number'||!Number.isFinite(line[key])||line[key]<0||(key==='duration'&&line[key]===0)||line[key]>86400))throw new Error(`第 ${index+1} 段的 ${key} 无效`);
    return {characterId:line.characterId,text:valid.text,speed:valid.speed,start:line.start,duration:line.duration};
  });
  return {lines,provider:'gpt-sovits',name:path.basename(String(input.name||'多角色配音.wav')).slice(0,120)};
}
export async function synthesizeDialogue(input,root,job,signal,dependencies={}){
  const options=validateDialogue(input),env={...(dependencies.env??process.env)};
  for(const line of options.lines)sovitsConfig(env,line.characterId);
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(10*60*1000)]),parts=[],output=path.join(root,'media',`tts-${job.id}.wav`);
  let succeeded=false,cursor=0;
  try{
    for(const [i,line] of options.lines.entries()){
      bounded.throwIfAborted();job.message=`正在生成 ${i+1}/${options.lines.length} 段 · ${sovitsConfig(env,line.characterId).name}`;job.progress=Math.round(i/options.lines.length*80);
      const part=await synthesizeSpeech({provider:'gpt-sovits',voice:line.characterId,text:line.text,speed:line.speed,preset:'natural',target:sovitsConfig(env,line.characterId).ageGroup==='child'?'child':'general'},root,{id:`${job.id}-line-${i}`},bounded,{...dependencies,env});
      parts.push({...part,line});
      if(line.duration!==undefined&&part.metadata.duration>line.duration+.001)throw new Error(`第 ${i+1} 段配音超出指定时长，请缩短台词或延长画面`);
      const start=line.start??cursor;
      if(start+(line.duration??part.metadata.duration)>86400)throw new Error('多角色音轨总时长最多 24 小时');
      parts.at(-1).start=start;cursor=start+(line.duration??part.metadata.duration)+.2;
    }
    const execute=dependencies.execute??run;
    const filters=parts.map((p,i)=>`[${i}:a]adelay=${Math.round(p.start*48000)}S:all=1[a${i}]`);
    const totalDuration=Math.max(...parts.map(p=>p.start+(p.line.duration??p.metadata.duration)));
    filters.push(parts.map((_,i)=>`[a${i}]`).join('')+`amix=inputs=${parts.length}:normalize=0:duration=longest,apad=whole_dur=${totalDuration},atrim=duration=${totalDuration}[out]`);
    job.message='合成多角色音轨';job.progress=85;
    await execute('ffmpeg',['-hide_banner','-loglevel','error','-y',...parts.flatMap(p=>['-i',p.file]),'-filter_complex_threads','1','-filter_complex',filters.join(';'),'-map','[out]','-t',String(totalDuration),'-ar','48000','-ac','1','-c:a','pcm_s16le',output],{signal:bounded});
    const metadata=await probe(output);bounded.throwIfAborted();succeeded=true;
    return {file:output,name:options.name.replace(/\.(wav|mp3)$/i,'')+'.wav',metadata,tts:{provider:'gpt-sovits',mode:'dialogue',preset:'natural',lines:parts.map(p=>({characterId:p.line.characterId,characterName:p.tts.characterName,text:p.line.text,start:p.start,duration:p.metadata.duration,slotDuration:p.line.duration??p.metadata.duration}))}};
  }finally{for(const p of parts)await rm(p.file,{force:true});if(!succeeded)await rm(output,{force:true});}
}
