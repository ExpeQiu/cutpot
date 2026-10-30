import { randomUUID } from 'node:crypto';
import { timeline, transitionTypes, normalizeTransitions } from '../public/timeline.js';

export const defaultProject = () => ({
  version: 1, id: randomUUID(), name: '未命名项目', fps: 25, width: 1920, height: 1080,
  clips: [], narration: null, music: null, musicVolume: 0.12, updatedAt: new Date().toISOString(),
});

export function validateProject(input, assets) {
  if (!input || input.version !== 1) throw new Error('不支持的工程版本');
  if (!Array.isArray(input.clips) || input.clips.length > 2000) throw new Error('镜头数量无效（最多 2000）');
  if (![24, 25, 30].includes(input.fps)) throw new Error('帧率仅支持 24 / 25 / 30');
  if (![[1920,1080], [1280,720], [1080,1920]].some(([w,h]) => w === input.width && h === input.height)) throw new Error('不支持的输出尺寸');
  if(input.burnSubtitles!==undefined&&typeof input.burnSubtitles!=='boolean')throw new Error('burnSubtitles 必须为布尔值');
  const project = structuredClone(input);
  project.name = String(input.name || '未命名项目').slice(0, 120);
  const ids = new Set();
  project.clips = input.clips.map((c, index) => {
    const asset = assets.find(a => a.id === c.assetId);
    if (!asset || !['video', 'image'].includes(asset.type)) throw new Error(`镜头 ${index + 1} 的画面素材不存在`);
    const frames = Math.round(Number(c.duration) * input.fps);
    const sourceIn = Number(c.sourceIn ?? 0);
    const speed = Number(c.speed ?? 1);
    if (!Number.isFinite(speed) || speed < .25 || speed > 4 || asset.type === 'image' && speed !== 1) throw new Error(`镜头 ${index + 1} 倍速无效（视频支持 0.25 至 4）`);
    if (!Number.isFinite(frames) || frames < 1 || frames > 3600 * input.fps) throw new Error(`镜头 ${index + 1} 时长无效`);
    if (!Number.isFinite(sourceIn) || sourceIn < 0) throw new Error(`镜头 ${index + 1} 入点无效`);
    const duration = frames / input.fps;
    if (asset.type === 'video' && sourceIn + duration * speed > asset.duration + 0.025) throw new Error(`镜头 ${index + 1} 超出素材可用时长，请裁短或替换`);
    if (c.transition != null && (!transitionTypes[c.transition.type] || !Number.isFinite(c.transition.duration) || c.transition.duration < 1/input.fps || c.transition.duration > 5)) throw new Error(`镜头 ${index + 1} 转场无效`);
    const id = String(c.id || randomUUID());
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('镜头 ID 格式无效');
    if (ids.has(id)) throw new Error('镜头 ID 重复');
    ids.add(id);
    return { id, assetId: asset.id, title: String(c.title || asset.name).slice(0,200), duration,
      sourceIn, speed, transition:c.transition ? {...c.transition} : null, subtitle: String(c.subtitle || '').slice(0,2000), muted: c.muted !== false, locked: Boolean(c.locked),
      ...(c.pipelineSegmentId && /^[a-f0-9-]{36}$/i.test(c.pipelineSegmentId) ? {pipelineSegmentId:c.pipelineSegmentId} : {}),
      ...(c.pipelineVersionId && /^[a-f0-9-]{36}$/i.test(c.pipelineVersionId) ? {pipelineVersionId:c.pipelineVersionId} : {}) };
  });
  normalizeTransitions(project);
  for (const key of ['narration','music']) {
    if (input[key] != null && !assets.some(a => a.id === input[key] && a.type === 'audio')) throw new Error('音轨素材不存在');
  }
  project.musicVolume = Number(input.musicVolume ?? 0.12);
  if (!Number.isFinite(project.musicVolume) || project.musicVolume < 0 || project.musicVolume > 1) throw new Error('音乐音量无效');
  project.updatedAt = new Date().toISOString();
  return project;
}

export function subtitles(project) {
  const stamp = frames => {
    const ms = Math.round(frames * 1000 / project.fps);
    return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
  };
  const lines = [];
  const items=timeline(project);
  for (const {clip,index,startFrame,endFrame} of items) {
    const end=items[index+1]?.startFrame ?? endFrame;
    if (clip.subtitle.trim()) lines.push(`${lines.length + 1}\n${stamp(startFrame)} --> ${stamp(end)}\n${clip.subtitle.trim()}\n`);
  }
  return lines.join('\n');
}

export function autoArrange(project, assets) {
  // Only reorder unlocked positions. Locked clips keep their exact slot.
  const rank = c => Number((assets.find(a=>a.id===c.assetId)?.name.match(/(?:shot[_ -]?|分镜)(\d+)/i) || [,'99999'])[1]);
  const sorted = project.clips.filter(c=>!c.locked).sort((a,b)=>rank(a)-rank(b));
  let i = 0;
  return { ...project, clips: project.clips.map(c=>c.locked ? c : sorted[i++]) };
}
