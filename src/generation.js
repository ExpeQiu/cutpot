import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// All CLI calls use argument arrays. Prompts and file names never enter a shell.
export function command(binary, args, { signal, timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => execFile(binary, args, { signal, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${binary}：${(stderr || stdout || error.message).slice(-1800)}`));
    else resolve({ stdout, stderr });
  }));
}
export function parseResult(output) {
  try { return JSON.parse(output); } catch {}
  for (const line of output.trim().split('\n').reverse()) { try { return JSON.parse(line); } catch {} }
  try { return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)); } catch { throw new Error('生成服务没有返回有效 JSON，请检查 CLI 版本'); }
}
export function imageArgs(job) {
  const s = job.input;
  return [s.references.length ? 'image2image' : 'text2image', ...(s.references.length ? ['--images', s.references.join(',')] : []), '--prompt', s.prompt + (s.negativePrompt ? `\n避免：${s.negativePrompt}` : ''), '--resolution_type', s.resolution, '--ratio', s.ratio, '--generate_num', String(s.candidates), '--poll', '0'];
}
export function videoArgs(job) {
  const s = job.input;
  if (!s.firstPath || !s.lastPath) throw new Error('首尾帧均为必填，不能降级为其他模式');
  const [width, height] = s.ratio === '9:16' ? [432, 768] : s.ratio === '1:1' ? [768, 768] : [768, 432];
  return ['job', 'submit', '--modality', 'video', '--play', 'first_last_frame', '--image', s.firstPath, '--end-image', s.lastPath, '--prompt', s.prompt, '--duration', String(s.duration), '--width', String(width), '--height', String(height), '--fps', '24', '--format', 'json'];
}
function liveItem(result) {
  if (result.ok === false) throw new Error(result.error || 'AutoDL 调用失败');
  if (result.data_source !== 'live' || /mock|demo/i.test(result.items?.[0]?.provider || '')) throw new Error('AutoDL 返回模拟数据，请检查服务配置；未将其标记为真实生成');
  return result.items?.[0] || {};
}
export async function generate(job, dir, { signal, update, resume = false } = {}) {
  await mkdir(dir, { recursive: true });
  if (job.mode === 'mock') return mockGenerate(job, dir, signal);
  const cli = job.kind === 'image' ? (process.env.CUTPOT_DREAMINA_BIN || 'dreamina') : (process.env.CUTPOT_AUTODL_BIN || 'autodl-cli');
  if (!resume) {
    const args = job.kind === 'image' ? imageArgs(job) : videoArgs(job);
    await writeFile(path.join(dir, 'request.json'), JSON.stringify({ cli, args, createdAt: job.createdAt }, null, 2));
    const result = parseResult((await command(cli, args, { signal })).stdout);
    const externalId = job.kind === 'image' ? result.submit_id : liveItem(result).id;
    if (!externalId) throw new Error(result.fail_reason || '提交未返回任务编号，请检查服务任务列表后再重试，避免重复计费');
    job.externalId = externalId;
    await update({ externalId, message: '任务已提交，等待生成', progress: 20 });
  }
  for (;;) {
    signal?.throwIfAborted();
    let result;
    try {
      result = parseResult((await command(cli, job.kind === 'image' ? ['query_result', '--submit_id', job.externalId] : ['job', 'get', job.externalId, '--format', 'json'], { signal, timeout: 30000 })).stdout);
    } catch (error) {
      error.tracking = true; throw error;
    }
    await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    if (job.kind === 'image') {
      if (result.gen_status === 'fail') throw new Error(result.fail_reason || '即梦生成失败');
      if (result.gen_status === 'success') {
        await update({ progress: 85, message: '下载分镜图' });
        try { await command(cli, ['query_result', '--submit_id', job.externalId, '--download_dir', dir], { signal }); } catch(error) { error.tracking=true; throw error; }
        const files = (await readdir(dir)).filter(n => /\.(png|jpe?g|webp)$/i.test(n)).sort();
        if (!files.length) throw Object.assign(new Error('即梦任务已完成，但下载未发现图片；可继续查询重试下载'), { tracking: true });
        return files.map(n => path.join(dir, n));
      }
    } else {
      const item = liveItem(result);
      if (['failed', 'cancelled', 'error'].includes(item.status)) throw new Error(typeof item.error === 'string' ? item.error : 'AutoDL 视频生成失败');
      if (['succeeded', 'completed', 'success'].includes(item.status)) {
        await update({ progress: 85, message: '下载视频' });
        const file = path.join(dir, 'video.mp4');
        try { liveItem(parseResult((await command(cli, ['job', 'file', job.externalId, '-o', file, '--format', 'json'], { signal })).stdout)); }
        catch (error) { error.tracking = true; throw error; }
        return [file];
      }
    }
    await delay(8000, undefined, { signal });
  }
}
async function mockGenerate(job, dir, signal) {
  const size = job.input.ratio === '9:16' ? '360x640' : job.input.ratio === '1:1' ? '512x512' : '640x360';
  if (job.kind === 'image') {
    const files = [];
    for (let i = 0; i < job.input.candidates; i++) {
      const file = path.join(dir, `demo-${i + 1}.png`);
      const colors = ['0x263c38', '0x354353', '0x4d4136', '0x3e354b'];
      await command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colors[i % 4]}:s=${size}`, '-vf', `drawbox=x=iw*0.1:y=ih*0.2:w=iw*0.35:h=ih*0.6:color=0x8faba0:t=fill,drawbox=x=iw*0.55:y=ih*0.35:w=iw*0.3:h=ih*0.45:color=0xbad182:t=fill`, '-frames:v', '1', file], { signal });
      files.push(file);
    }
    return files;
  }
  const file = path.join(dir, 'demo.mp4'), duration = job.input.duration, transition = Math.min(.5, duration / 4);
  const [w, h] = size.split('x');
  const normalize = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
  await command('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', job.input.firstPath, '-loop', '1', '-i', job.input.lastPath, '-filter_complex_threads', '1', '-filter_complex', `[0:v]${normalize}[a];[1:v]${normalize}[b];[a][b]xfade=transition=fade:duration=${transition}:offset=${(duration - transition) / 2},format=yuv420p[v]`, '-map', '[v]', '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', file], { signal });
  return [file];
}
export async function endpointQuality(video, first, last, dir, signal) {
  const scores = [];
  for (const [i, reference] of [first, last].entries()) {
    const frame = path.join(dir, `endpoint-${i}.png`);
    await command('ffmpeg', ['-v', 'error', '-y', ...(i ? ['-sseof', '-0.25'] : []), '-i', video, ...(i ? ['-vf', 'reverse'] : []), '-frames:v', '1', frame], { signal });
    const norm = 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p';
    const { stderr } = await command('ffmpeg', ['-hide_banner', '-i', frame, '-i', reference, '-filter_complex_threads', '1', '-lavfi', `[0:v]${norm}[a];[1:v]${norm}[b];[a][b]psnr`, '-frames:v', '1', '-f', 'null', '-'], { signal });
    const match = /average:([\d.]+|inf)/.exec(stderr);
    scores.push(match ? (match[1] === 'inf' ? 100 : Number(Number(match[1]).toFixed(1))) : null);
  }
  return { firstPSNR: scores[0], lastPSNR: scores[1] };
}
