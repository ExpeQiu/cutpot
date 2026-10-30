import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { subtitles } from './project.js';
import { timeline, timelineDuration, speedOf } from '../public/timeline.js';

// atempo accepts 0.5..2 on older FFmpeg builds. Chain it for the full editor range.
export function tempoFilter(speed) {
  const chain=[];
  while(speed<.5){chain.push('atempo=0.5');speed/=.5;}
  while(speed>2){chain.push('atempo=2');speed/=2;}
  chain.push(`atempo=${speed}`);
  return chain.join(',');
}

export function run(binary, args, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { signal, stdio: ['ignore','pipe','pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', b => { output = (output + b).slice(-200000); onProgress?.(String(b)); });
    child.stderr.on('data', b => { errors = (errors + b).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${binary} 运行失败 (${code})：${errors.slice(-1800)}`)));
  });
}

export async function probe(file) {
  const data = JSON.parse(await run('ffprobe', ['-v','error','-show_format','-show_streams','-of','json',file]));
  const video = data.streams.find(s=>s.codec_type==='video' && !s.disposition?.attached_pic);
  const audio = data.streams.find(s=>s.codec_type==='audio');
  const image = /\.(png|jpe?g|webp)$/i.test(file);
  if (!video && !audio) throw new Error('文件没有可用的画面或音频');
  return { type: image ? 'image' : video ? 'video' : 'audio', duration: Number(data.format.duration || video?.duration || audio?.duration || 0),
    width: video?.width || 0, height: video?.height || 0, hasAudio: Boolean(audio), codec: video?.codec_name || audio?.codec_name };
}

export async function renderProject(project, assets, root, job, signal) {
  const dir = path.join(root, 'exports', job.id);
  const cache = path.join(root,'cache');
  await mkdir(dir,{recursive:true}); await mkdir(cache,{recursive:true});
  const get = id => assets.find(a=>a.id===id);
  const burned=project.burnSubtitles===true;
  const overlays=burned?project.clips.flatMap((clip,i)=>clip.subtitle.trim()?[{index:i,text:clip.subtitle.trim(),file:path.join(dir,`caption-${i}.png`)}]:[]):[];
  if(overlays.length){
    job.message='制作中文字幕图层';
    const manifest=path.join(dir,'captions.json');
    await writeFile(manifest,JSON.stringify({width:project.width,height:project.height,clips:overlays}));
    const managedPython=fileURLToPath(new URL(`../.cutpot/subtitle-runtime/${process.platform==='win32'?'Scripts/python.exe':'bin/python'}`,import.meta.url));
    await run(process.env.CUTPOT_SUBTITLE_PYTHON||(existsSync(managedPython)?managedPython:'python3'),[fileURLToPath(new URL('../scripts/render-subtitles.py',import.meta.url)),manifest],{signal});
  }
  const files = [];
  for (let i=0; i<project.clips.length; i++) {
    signal.throwIfAborted();
    const c = project.clips[i], a = get(c.assetId);
    const overlay=overlays.find(o=>o.index===i);
    const captionHash=overlay?createHash('sha256').update(await readFile(overlay.file)).digest('hex'):null;
    const key = createHash('sha256').update(JSON.stringify({version:4,captionHash,sha:a.sha256,c:{...c,transition:undefined,subtitle:undefined,title:undefined,locked:undefined,id:undefined},fps:project.fps,w:project.width,h:project.height})).digest('hex');
    const file = path.join(cache, `${key}.mp4`);
    let cached = false;
    try { const p = await probe(file); cached = Math.abs(p.duration - c.duration) < .06; } catch {}
    job.message = `处理镜头 ${i+1} / ${project.clips.length}${cached ? ' · 复用缓存' : ''}`;
    if (!cached) {
      const temp = path.join(cache,`${key}-${job.id}.partial.mp4`);
      const args = ['-hide_banner','-loglevel','error','-y'];
      if (a.type==='image') args.push('-loop','1','-framerate',String(project.fps));
      else args.push('-ss',String(c.sourceIn));
      args.push('-i',a.path);
      const sound = a.hasAudio && !c.muted && a.type !== 'image';
      if (!sound) args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
      const scale=`setpts=(PTS-STARTPTS)/${speedOf(c)},scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${project.fps},format=yuv420p`;
      if(overlay){
        args.push('-i',overlay.file,'-filter_complex_threads','1','-filter_complex',`[0:v]${scale}[picture];[picture][${sound?1:2}:v]overlay=0:0:format=auto,format=yuv420p[captioned]`,'-map','[captioned]');
      }else args.push('-vf',scale,'-map','0:v:0');
      args.push('-map',sound?'0:a:0':'1:a:0','-af',`${sound?tempoFilter(speedOf(c))+',':''}aresample=48000,apad`, '-t',String(c.duration),'-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-ar','48000','-ac','2','-video_track_timescale','90000',temp);
      try { await run('ffmpeg',args,{signal}); await rename(temp,file); }
      finally { await rm(temp,{force:true}); }
    }
    files.push(file);
    job.progress = Math.round((i+1)/project.clips.length*80);
  }
  signal.throwIfAborted();
  job.message = '合并画面与混音';
  const list = path.join(dir,'concat.txt');
  // Cache paths consist only of controlled directory names and hex hashes.
  await writeFile(list,files.map((f,i)=>`file '${f.replaceAll("'", "'\\''")}'\nduration ${project.clips[i].duration}`).join('\n'));
  const total = timelineDuration(project), items=timeline(project);
  // Render only the overlap windows and each remaining body once. This avoids
  // re-encoding the growing film for every joint on long timelines.
  const intermediates=[];
  if(items.some(item=>item.transition)){
    const pieces=[];
    for(let i=0;i<files.length;i++){
      signal.throwIfAborted();
      const incoming=items[i-1]?.transition?.duration||0, outgoing=items[i].transition?.duration||0;
      const bodyFrames=Math.round((project.clips[i].duration-incoming-outgoing)*project.fps);
      if(bodyFrames>0){
        const file=path.join(dir,`body-${i}.mp4`),duration=bodyFrames/project.fps;
        await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(incoming),'-i',files[i],'-t',String(duration),'-vf','setpts=PTS-STARTPTS','-af','asetpts=PTS-STARTPTS,apad','-c:v','libx264','-preset','veryfast','-crf','18','-c:a','aac','-ar','48000','-ac','2','-video_track_timescale','90000',file],{signal});
        intermediates.push(file);pieces.push({file,duration});
      }
      const transition=items[i].transition;
      if(!transition)continue;
      const d=transition.duration,file=path.join(dir,`transition-${i}.mp4`);
      job.message=`合成接缝 ${i+1} / ${files.length-1}`;
      const filter=`[0:v]settb=AVTB,setpts=PTS-STARTPTS[v0];[1:v]settb=AVTB,setpts=PTS-STARTPTS[v1];[v0][v1]xfade=transition=${transition.type==='dissolve'?'fade':transition.type}:duration=${d}:offset=0[v];[0:a]aresample=48000,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a0];[1:a]aresample=48000,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a1];[a0][a1]acrossfade=d=${d}:c1=tri:c2=tri[a]`;
      await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(project.clips[i].duration-d),'-t',String(d),'-i',files[i],'-t',String(d),'-i',files[i+1],'-filter_complex_threads','1','-filter_complex',filter,'-map','[v]','-map','[a]','-r',String(project.fps),'-t',String(d),'-c:v','libx264','-preset','veryfast','-crf','18','-c:a','aac','-ar','48000','-ac','2','-video_track_timescale','90000',file],{signal});
      intermediates.push(file);pieces.push({file,duration:d});
    }
    await writeFile(list,pieces.map(({file,duration})=>`file '${file.replaceAll("'", "'\\''")}'\nduration ${duration}`).join('\n'));
  }
  const output = path.join(dir,'film.mp4');
  // Keep video at t=0 instead of shifting it by the first AAC priming packet.
  const args = ['-hide_banner','-loglevel','error','-y','-copyts','-f','concat','-safe','0','-i',list];
  let index = 1;
  const tracks = ['[base]'];
  const filters = [`[0:a]aresample=48000,apad,atrim=duration=${total}[base]`];
  if (project.narration) { args.push('-i',get(project.narration).path); filters.push(`[${index++}:a]aresample=48000,apad,atrim=duration=${total}[voice]`); tracks.push('[voice]'); }
  if (project.music) { args.push('-stream_loop','-1','-i',get(project.music).path); filters.push(`[${index++}:a]aresample=48000,volume=${project.musicVolume},afade=t=out:st=${Math.max(0,total-1)}:d=${Math.min(1,total)},atrim=duration=${total}[music]`); tracks.push('[music]'); }
  if (tracks.length > 1) {
    filters.push(`${tracks.join('')}amix=inputs=${tracks.length}:duration=first:normalize=0,alimiter=limit=0.95:level=false[mix]`);
    args.push('-filter_complex',filters.join(';'),'-map','0:v:0','-map','[mix]','-c:a','aac');
  } else args.push('-filter_complex',filters.join(';'),'-map','0:v:0','-map','[base]','-c:a','aac');
  args.push('-c:v','copy','-t',String(total),'-movflags','+faststart',output);
  await run('ffmpeg',args,{signal});
  await Promise.all(intermediates.map(file=>rm(file,{force:true})));
  job.progress = 95; job.message='校验导出文件';
  const metadata = await probe(output);
  signal.throwIfAborted();
  if (Math.abs(metadata.duration-total) > .005) throw new Error('输出时长校验失败');
  await writeFile(path.join(dir,'subtitles.srt'),subtitles(project));
  await writeFile(path.join(dir,'project.json'),JSON.stringify(project,null,2));
  await writeFile(path.join(dir,'report.json'),JSON.stringify({expectedDuration:total,burnSubtitles:burned,...metadata},null,2));
  signal.throwIfAborted();
  job.progress=100; job.status='completed'; job.message=burned?'导出完成 · 字幕已烧录至画面，附独立 SRT':'导出完成 · MP4 与独立字幕';
  job.burnSubtitles=burned;
  job.output=`/api/exports/${job.id}/film.mp4`;
  job.srt=`/api/exports/${job.id}/subtitles.srt`;
}
