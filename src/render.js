import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { subtitles } from './project.js';

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
    await run(process.env.CUTPOT_SUBTITLE_PYTHON||'python3',[fileURLToPath(new URL('../scripts/render-subtitles.py',import.meta.url)),manifest],{signal});
  }
  const files = [];
  for (let i=0; i<project.clips.length; i++) {
    signal.throwIfAborted();
    const c = project.clips[i], a = get(c.assetId);
    const overlay=overlays.find(o=>o.index===i);
    const captionHash=overlay?createHash('sha256').update(await readFile(overlay.file)).digest('hex'):null;
    const key = createHash('sha256').update(JSON.stringify({version:3,captionHash,sha:a.sha256,c:{...c,subtitle:undefined,title:undefined,locked:undefined,id:undefined},fps:project.fps,w:project.width,h:project.height})).digest('hex');
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
      const scale=`scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${project.fps},format=yuv420p`;
      if(overlay){
        args.push('-i',overlay.file,'-filter_complex_threads','1','-filter_complex',`[0:v]${scale}[picture];[picture][${sound?1:2}:v]overlay=0:0:format=auto,format=yuv420p[captioned]`,'-map','[captioned]');
      }else args.push('-vf',scale,'-map','0:v:0');
      args.push('-map',sound?'0:a:0':'1:a:0','-af','aresample=48000,apad', '-t',String(c.duration),'-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-ar','48000','-ac','2','-video_track_timescale','90000',temp);
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
  const total = project.clips.reduce((n,c)=>n+Math.round(c.duration*project.fps),0)/project.fps;
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
