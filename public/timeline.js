// Shared by the browser, project validation and FFmpeg. All edit points use frames.
export const transitionTypes = Object.freeze({__proto__:null,dissolve:'叠化',fadeblack:'淡入黑场',fadewhite:'淡入白场',wipeleft:'向左擦除'});
export const frames = (seconds, fps) => Math.round(seconds * fps);
export const speedOf = clip => clip.speed ?? 1;
export const sourceOut = clip => clip.sourceIn + clip.duration * speedOf(clip);

export function timeline(project) {
  let cursor = 0;
  return project.clips.map((clip, i, clips) => {
    const length = frames(clip.duration, project.fps), next = clips[i + 1];
    const requested = clip.transition;
    const overlap = next && transitionTypes[requested?.type]
      ? Math.max(0, Math.min(frames(requested.duration, project.fps), Math.floor(length / 2), Math.floor(frames(next.duration, project.fps) / 2))) : 0;
    const startFrame = cursor, endFrame = cursor + length;
    cursor = endFrame - overlap;
    return {clip, index:i, start:startFrame/project.fps, end:endFrame/project.fps, startFrame, endFrame,
      transition:overlap ? {type:requested.type,duration:overlap/project.fps} : null};
  });
}
export const timelineDuration = project => timeline(project).at(-1)?.end ?? 0;
export function normalizeTransitions(project) {
  for (const item of timeline(project)) item.clip.transition = item.transition;
}
export function activeAt(project, position) {
  const items = timeline(project);
  const index = items.findLastIndex(item => position >= item.start - 0.000001);
  const item = items[Math.max(0,index)];
  if (!item) return null;
  const previous = items[item.index-1];
  return {...item, previous:previous?.transition && position < previous.end ? previous : null};
}
export function splitAt(project, id, position, newId) {
  const item = timeline(project).find(item=>item.clip.id===id);
  if (!item || item.clip.locked) throw new Error('请先选择并解锁镜头');
  const offset = frames(position,project.fps)-item.startFrame;
  const length = frames(item.clip.duration,project.fps);
  if (offset < 1 || offset >= length) throw new Error('将播放头移到镜头内部再分割');
  const previous = timeline(project)[item.index-1];
  if (previous?.endFrame > item.startFrame+offset || item.transition && item.endFrame-offset-item.startFrame < frames(item.transition.duration,project.fps))
    throw new Error('请在转场区间之外分割，或先移除转场');
  if (previous?.transition && offset < 2*frames(previous.transition.duration,project.fps) || item.transition && length-offset < 2*frames(item.transition.duration,project.fps))
    throw new Error('切点太靠近转场，请移远一些或先移除转场，以保留转场时长');
  const right = {...item.clip,id:newId,sourceIn:item.clip.sourceIn+offset/project.fps*speedOf(item.clip),duration:(length-offset)/project.fps};
  item.clip.duration=offset/project.fps;
  item.clip.transition=null;
  project.clips.splice(item.index+1,0,right);
  normalizeTransitions(project);
  return right;
}

export function trimEdge(project, id, edge, delta, media) {
  const clip=project.clips.find(c=>c.id===id);
  if (!clip || clip.locked) throw new Error('请先选择并解锁镜头');
  const fps=project.fps, speed=speedOf(clip), length=frames(clip.duration,fps);
  let amount=frames(delta,fps);
  if (edge==='in') {
    amount=Math.max(-Math.floor(clip.sourceIn/speed*fps+1e-7),Math.min(length-1,amount));
    clip.sourceIn+=amount/fps*speed;
    clip.duration=(length-amount)/fps;
  } else {
    const maximum=media.type==='video'?Math.floor((media.duration-clip.sourceIn)/speed*fps+1e-7):3600*fps;
    clip.duration=Math.max(1,Math.min(maximum,length+amount))/fps;
  }
  normalizeTransitions(project);
  return clip;
}
