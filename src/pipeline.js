import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { generate, endpointQuality } from './generation.js';

const now = () => new Date().toISOString();
const text = (v, max = 12000) => String(v ?? '').slice(0, max);
function number(v, min, max, label) { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}须为 ${min} 至 ${max}`); return n; }
export const selectedVersion = item => item?.versions.find(v => v.id === item.selectedVersionId);
export function splitScript(script, count) {
  if (!String(script).trim()) throw new Error('请先输入脚本');
  count = Math.round(number(count, 1, 100, '分镜数量'));
  let parts = script.trim().split(/\n\s*\n|\n(?=\s*(?:\d+[.、）)]|镜头|分镜))/).map(s => s.trim()).filter(Boolean);
  if (parts.length < count) parts = script.trim().match(/[^。！？!?\n]+[。！？!?]?/g)?.map(s => s.trim()).filter(Boolean) || [script.trim()];
  // Preserve the entire script, never invent missing story content to fill a count.
  const groups = Math.min(count, parts.length);
  return Array.from({ length: groups }, (_, i) => parts.slice(Math.floor(i * parts.length / groups), Math.floor((i + 1) * parts.length / groups)).join('\n'));
}
export function syncSegments(state) {
  const old = new Map(state.segments.map(s => [`${s.fromShotId}:${s.toShotId}`, s]));
  state.segments = state.shots.slice(0, -1).map((shot, i) => {
    const end = state.shots[i + 1], key = `${shot.id}:${end.id}`;
    return old.get(key) || { id: randomUUID(), fromShotId: shot.id, toShotId: end.id, prompt: `从「${shot.title}」自然过渡到「${end.title}」，保持人物、服装与场景一致，动作连贯，镜头平稳。`, duration: 3, versions: [], selectedVersionId: null };
  });
}
export function segmentStale(state, segment) {
  const v = selectedVersion(segment);
  return Boolean(v && (v.firstAssetId !== selectedVersion(state.shots.find(s => s.id === segment.fromShotId))?.assetId || v.lastAssetId !== selectedVersion(state.shots.find(s => s.id === segment.toShotId))?.assetId || v.prompt !== segment.prompt || v.duration !== segment.duration));
}
function fresh(projectId) { return { version: 1, projectId, revision: 0, script: '', style: '', references: [], settings: { mode: 'mock', ratio: '16:9', resolution: '2k', candidates: 4, videoProvider: 'autodl' }, shots: [], segments: [], jobs: [], archives: [] }; }
function normalizeSettings(settings = {}) {
  const videoProvider = settings.videoProvider || 'autodl';
  if (!['mock', 'live'].includes(settings.mode) || !['16:9', '9:16', '1:1'].includes(settings.ratio) || !['2k', '4k'].includes(settings.resolution) || !['autodl', 'dreamina'].includes(videoProvider)) {
    throw new Error('生成设置无效');
  }
  return { mode: settings.mode, ratio: settings.ratio, resolution: settings.resolution, candidates: Math.round(number(settings.candidates, 1, 10, '候选数量')), videoProvider };
}
const active = j => ['queued', 'running'].includes(j.status);
export async function createPipeline({ root, getProject, getAssets, addAsset, saveAssets, setProject, editorRevision, workspace }) {
  const file = path.join(root, 'pipeline.json');
  let store = { version: 1, projects: {} }, queue = Promise.resolve(), busy = false, closed = false;
  const abort = new AbortController();
  try { store = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  async function save() {
    const snapshot = JSON.stringify(store, null, 2);
    const next = queue.then(async () => { await writeFile(`${file}.tmp`, snapshot); await rename(`${file}.tmp`, file); });
    queue = next.catch(() => {}); return next;
  }
  /** Drop version entries whose media file is gone (e.g. AppleDouble sidecars cleaned up). */
  function scrubMissingVersions() {
    let removed = 0;
    for (const s of Object.values(store.projects)) {
      for (const item of [...(s.shots || []), ...(s.segments || [])]) {
        const before = item.versions?.length || 0;
        item.versions = (item.versions || []).filter(v => {
          const a = getAssets().find(x => x.id === v.assetId);
          return a && existsSync(a.path);
        });
        removed += before - item.versions.length;
        if (!item.versions.some(v => v.id === item.selectedVersionId)) {
          item.selectedVersionId = item.versions[0]?.id ?? null;
        }
      }
    }
    if (removed) console.warn('[pipeline] scrubbed versions with missing media', { removed });
    return removed;
  }
  if (scrubMissingVersions()) await save();
  function current() { const id = getProject().id; return store.projects[id] ||= fresh(id); }
  function asset(id, type) { const a = getAssets().find(a => a.id === id); if (!a || (type && a.type !== type)) throw new Error(`请选择有效的${type === 'image' ? '图片' : '视频'}素材`); return a; }
  function target(s, kind, id) { const item = (kind === 'image' ? s.shots : s.segments).find(x => x.id === id); if (!item) throw new Error('分镜或片段不存在，请刷新'); return item; }
  function status(s, item) { const job = [...s.jobs].reverse().find(j => j.targetId === item.id); return job && ['queued', 'running', 'interrupted', 'failed'].includes(job.status) ? job.status : selectedVersion(item) ? 'completed' : 'pending'; }
  function view() {
    const s = current();
    if (!s.settings.videoProvider) s.settings.videoProvider = 'autodl';
    return { ...structuredClone(s), name: getProject().name, editorRevision: editorRevision(), editorClips: getProject().clips.length, assets: getAssets().map(({ path: hidden, ...a }) => a), shots: s.shots.map(x => ({ ...x, status: status(s, x) })), segments: s.segments.map(x => ({ ...x, status: status(s, x), stale: segmentStale(s, x) })) };
  }
  async function updateJob(s, job, patch) { Object.assign(job, patch, { updatedAt: now() }); await save(); }
  async function execute(s, job, resume = false) {
    try {
      await updateJob(s, job, { status: 'running', message: resume ? '恢复任务查询' : '准备生成', progress: 5 });
      const dir = path.join(root, 'generation', job.id);
      const files = await generate(job, dir, { signal: abort.signal, resume, update: patch => updateJob(s, job, patch) });
      const item = target(s, job.kind, job.targetId), versions = [];
      for (const [i, output] of files.entries()) {
        const a = await addAsset(output, `${job.kind === 'image' ? '分镜' : '片段'}_${job.targetId.slice(0, 6)}_${i + 1}${path.extname(output)}`);
        const expected = job.kind === 'image' ? 'image' : 'video';
        if (a.type !== expected) throw new Error('生成服务返回的媒体类型不正确');
        const v = { id: randomUUID(), assetId: a.id, jobId: job.id, externalId: job.externalId || null, mode: job.mode, prompt: job.input.prompt, createdAt: now(), size: (await stat(output)).size };
        if (job.kind === 'video') {
          Object.assign(v, { firstAssetId: job.input.firstAssetId, lastAssetId: job.input.lastAssetId, duration: job.input.duration, actualDuration: a.duration, review: 'pending' });
          try { Object.assign(v, await endpointQuality(output, job.input.firstPath, job.input.lastPath, dir, abort.signal)); }
          catch (error) { v.qualityError = error.message; }
        }
        versions.push(v);
      }
      await saveAssets();
      item.versions.push(...versions);
      // A returning task must not silently replace a version chosen while it ran.
      if (item.selectedVersionId === job.previousSelection) item.selectedVersionId = versions[0].id;
      s.revision++;
      await updateJob(s, job, { status: 'completed', progress: 100, message: job.mode === 'mock' ? '模拟素材已生成' : '生成完成，素材已保存' });
    } catch (error) {
      if (closed) return;
      await updateJob(s, job, { status: error.tracking || (!job.externalId && job.mode === 'live' && job.status === 'running' && /超时|timed out/i.test(error.message)) ? 'interrupted' : 'failed', message: error.message });
    }
  }
  async function pump() {
    if (busy || closed) return;
    busy = true;
    try {
      for (;;) {
        const s = Object.values(store.projects).find(s => s.jobs.some(j => j.status === 'queued'));
        if (!s) break;
        await execute(s, s.jobs.find(j => j.status === 'queued'));
      }
    } catch (error) { console.error('创作队列保存失败：', error.message); }
    finally { busy = false; }
  }
  // A restart only resumes known task IDs. It never resubmits a paid task.
  for (const s of Object.values(store.projects)) for (const j of s.jobs) if (active(j)) {
    j.status = 'interrupted'; j.message = j.externalId ? '服务已重启，可继续查询已有任务' : '服务已重启；请核对服务任务列表后重新生成';
  }
  await save();
  async function act(input) {
    const s = current();
    if (input.projectId !== s.projectId || input.revision !== s.revision) throw Object.assign(new Error('项目已在其他页面更新。请刷新数据后重试，当前输入仍保留在页面。'), { statusCode: 409 });
    const action = input.action;
    if (action === 'script') { s.script = text(input.script, 50000); s.style = text(input.style, 4000); }
    else if (action === 'settings') {
      s.settings = normalizeSettings(input.settings || {});
    } else if (action === 'references') {
      if (!Array.isArray(input.assetIds) || input.assetIds.length > 10) throw new Error('主体参考图最多 10 张');
      input.assetIds.forEach(id => asset(id, 'image')); s.references = [...new Set(input.assetIds)];
    } else if (action === 'split') {
      if (s.jobs.some(active)) throw new Error('请等待当前任务完成再拆分脚本');
      const script = text(input.script, 50000), parts = splitScript(script, input.count);
      if (s.shots.length && !input.replace) throw new Error('重新拆分需要明确确认，已有分镜会存入历史');
      if (s.shots.length) s.archives.push({ id: randomUUID(), createdAt: now(), script: s.script, shots: structuredClone(s.shots), segments: structuredClone(s.segments) });
      s.script = script;
      s.shots = parts.map((description, i) => ({ id: randomUUID(), title: `分镜 ${String(i + 1).padStart(2, '0')} · ${description.replace(/^\d+[.、）)]\s*/, '').slice(0, 16)}`, description, prompt: description, negativePrompt: '', versions: [], selectedVersionId: null }));
      syncSegments(s);
    } else if (action === 'restore') {
      if (s.jobs.some(active)) throw new Error('请等待当前任务完成再恢复');
      const archive = s.archives.find(a => a.id === input.id); if (!archive) throw new Error('历史分镜不存在');
      const previous = { id: randomUUID(), createdAt: now(), script: s.script, shots: structuredClone(s.shots), segments: structuredClone(s.segments) };
      Object.assign(s, structuredClone({ script: archive.script, shots: archive.shots, segments: archive.segments })); s.archives.push(previous);
    } else if (action === 'shot') {
      const shot = target(s, 'image', input.id);
      Object.assign(shot, { title: text(input.title, 200).trim() || '未命名分镜', description: text(input.description), prompt: text(input.prompt), negativePrompt: text(input.negativePrompt, 4000) });
    } else if (action === 'add-shot') {
      s.shots.push({ id: randomUUID(), title: `分镜 ${s.shots.length + 1}`, description: '', prompt: '', negativePrompt: '', versions: [], selectedVersionId: null }); syncSegments(s);
    } else if (action === 'move-shot') {
      if (s.jobs.some(active)) throw new Error('请等待当前任务完成再调整顺序');
      const i = s.shots.findIndex(x => x.id === input.id), to = i + (input.direction === 'up' ? -1 : 1);
      if (i < 0 || to < 0 || to >= s.shots.length) throw new Error('分镜已在边界');
      // Keep historical segment data for removed adjacency pairs as an archive.
      s.archives.push({ id: randomUUID(), createdAt: now(), script: s.script, shots: structuredClone(s.shots), segments: structuredClone(s.segments) });
      [s.shots[i], s.shots[to]] = [s.shots[to], s.shots[i]]; syncSegments(s);
    } else if (action === 'segment') {
      const seg = target(s, 'video', input.id);
      seg.prompt = text(input.prompt); seg.duration = number(input.duration, 1, 10, '片段时长');
    } else if (action === 'select-version') {
      const item = target(s, input.kind, input.id);
      if (!item.versions.some(v => v.id === input.versionId)) throw new Error('版本不存在');
      item.selectedVersionId = input.versionId;
    } else if (action === 'attach') {
      const item = target(s, input.kind, input.id), a = asset(input.assetId, input.kind === 'image' ? 'image' : 'video');
      const v = { id: randomUUID(), assetId: a.id, mode: 'imported', createdAt: now(), prompt: item.prompt, size: (await stat(a.path)).size };
      if (input.kind === 'video') {
        const first = selectedVersion(target(s, 'image', item.fromShotId)), last = selectedVersion(target(s, 'image', item.toShotId));
        if (!first || !last) throw new Error('请先为片段选择首尾帧');
        if (a.duration < item.duration - .05) throw new Error('导入视频短于片段设定时长，请先调整时长');
        Object.assign(v, { firstAssetId: first.assetId, lastAssetId: last.assetId, duration: item.duration, actualDuration: a.duration, review: 'pending' });
      }
      item.versions.push(v); item.selectedVersionId = v.id;
    } else if (action === 'review') {
      const version = selectedVersion(target(s, 'video', input.id));
      if (!version || !['approved', 'rejected', 'pending'].includes(input.review)) throw new Error('请选择视频版本和检查结论');
      version.review = input.review;
    } else if (action === 'generate') {
      if (!['image', 'video'].includes(input.kind) || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100) throw new Error('请选择需要生成的分镜或片段');
      if (s.settings.mode === 'live' && input.authorizeLive !== true) throw new Error('真实生成需要明确授权，可能消耗积分或算力');
      const pending = [];
      for (const id of new Set(input.ids)) {
        const item = target(s, input.kind, id);
        if (s.jobs.some(j => j.targetId === id && (active(j) || j.status === 'interrupted' && j.externalId))) throw new Error('所选项已有任务，请先完成或继续查询');
        const common = { ratio: s.settings.ratio, prompt: `${s.style ? `${s.style}\n` : ''}${item.prompt}`.trim() };
        if (!item.prompt.trim()) throw new Error('请填写每个选中项的提示词');
        const videoProvider = s.settings.videoProvider || 'autodl';
        const data = input.kind === 'image' ? { ...common, negativePrompt: item.negativePrompt, candidates: s.settings.candidates, resolution: s.settings.resolution, references: s.references.map(id => asset(id, 'image').path) } : (() => {
          const first = selectedVersion(target(s, 'image', item.fromShotId)), last = selectedVersion(target(s, 'image', item.toShotId));
          if (!first || !last) throw new Error('每个片段都必须具备首帧和尾帧');
          if (s.settings.mode === 'live' && [first, last].some(v => v.mode === 'mock')) throw new Error('真实视频不能使用模拟帧，请先导入或生成正式分镜图');
          if (videoProvider === 'dreamina') {
            const duration = Math.round(item.duration);
            if (duration < 4 || duration > 15) throw new Error('即梦首尾帧视频时长须为 4–15 秒，请先调整片段时长');
          }
          return { ...common, prompt: item.prompt, duration: item.duration, videoResolution: '720p', firstAssetId: first.assetId, lastAssetId: last.assetId, firstPath: asset(first.assetId, 'image').path, lastPath: asset(last.assetId, 'image').path };
        })();
        const provider = input.kind === 'image' ? 'dreamina' : videoProvider;
        pending.push({ id: randomUUID(), kind: input.kind, targetId: id, mode: s.settings.mode, provider, status: 'queued', progress: 0, message: '等待生成', input: data, previousSelection: item.selectedVersionId, createdAt: now() });
      }
      s.jobs.push(...pending);
    } else if (action === 'stop-queue') { s.jobs.filter(j => j.status === 'queued').forEach(j => Object.assign(j, { status: 'cancelled', message: '已停止排队，未提交生成' })); }
    else if (action === 'resume') {
      const job = s.jobs.find(j => j.id === input.id && j.status === 'interrupted');
      if (!job?.externalId) throw new Error('没有已知任务编号，请先在服务任务列表中核对，避免重复提交');
      if (busy) throw new Error('当前有任务运行，请稍后继续查询');
      busy = true; execute(s, job, true).finally(() => { busy = false; pump(); });
    } else if (action === 'handoff') {
      const selected = s.segments.filter(seg => selectedVersion(seg));
      if (!selected.length || selected.length !== s.segments.length) throw new Error('请先为所有片段生成或导入视频');
      if (selected.some(seg => segmentStale(s, seg))) throw new Error('有片段的首尾帧或参数已变更，请更新或重新选择对应视频版本');
      if (selected.some(seg => selectedVersion(seg).review === 'rejected')) throw new Error('请先替换已标记需返工的片段');
      const project = structuredClone(getProject());
      if (project.id !== s.projectId) throw new Error('当前项目已变更');
      const chosen = new Map(selected.map(seg=>[seg.id,{seg,v:selectedVersion(seg)}]));
      // Preserve each editorial cut, speed, transition, title and subtitle, even after a clip was split.
      project.clips = project.clips.map(clip=>{
        const entry=chosen.get(clip.pipelineSegmentId);
        if(!entry || clip.pipelineVersionId===entry.v.id)return clip;
        if(clip.locked)throw new Error('对应剪辑镜头已锁定，请先在 CutPot 解锁');
        const a=asset(entry.v.assetId,'video');
        if(clip.sourceIn+clip.duration*(clip.speed??1)>a.duration+.025)throw new Error('新视频短于已剪辑的素材范围，请先在 CutPot 调整对应镜头再更新版本');
        return {...clip,assetId:a.id,pipelineVersionId:entry.v.id};
      });
      if(!project.clips.length && s.settings.ratio==='9:16'){project.width=1080;project.height=1920;}
      for(const [i,seg] of selected.entries()){
        if(project.clips.some(c=>c.pipelineSegmentId===seg.id))continue;
        const v=selectedVersion(seg),a=asset(v.assetId,'video');
        const duration=Math.floor(Math.min(seg.duration,a.duration)*project.fps)/project.fps;
        if(duration<1/project.fps)throw new Error('视频时长不足一帧');
        project.clips.push({id:randomUUID(),title:`片段 ${String(i+1).padStart(2,'0')}`,assetId:a.id,duration,sourceIn:0,subtitle:'',muted:true,locked:false,pipelineSegmentId:seg.id,pipelineVersionId:v.id});
      }
      await setProject(project, input.editorRevision);
      s.handoffAt = now();
    } else if (action === 'demo') {
      if (s.shots.length) throw new Error('当前已有分镜，请在新建工程中体验示例');
      const dir = path.join(workspace, 'storyboard', '乐乐安全教育', '全片分镜_01-23');
      const descriptions = ['乐乐在学校门口向大家打招呼。', '课间，乐乐在教室门口观察同学。', '同学们一起玩翻花绳。', '两位同学坐在桌旁下飞行棋。', '乐乐在操场和同学跳绳。', '乐乐弯腰观察春天的新叶。'];
      const numbers = [1, 3, 4, 5, 7, 9];
      const shots = [];
      for (const [i, n] of numbers.entries()) {
        const a = await addAsset(path.join(dir, `分镜${String(n).padStart(2, '0')}.png`), `分镜${String(i + 1).padStart(2, '0')}.png`);
        const v = { id: randomUUID(), assetId: a.id, mode: 'imported', createdAt: now() };
        shots.push({ id: randomUUID(), title: descriptions[i].slice(0, 18), description: descriptions[i], prompt: descriptions[i], negativePrompt: '', versions: [v], selectedVersionId: v.id });
      }
      s.script = descriptions.join('\n\n'); s.shots = shots; s.references = [shots[0].versions[0].assetId]; syncSegments(s); await saveAssets();
    } else throw new Error('不支持的创作操作');
    s.revision++; s.updatedAt = now(); await save();
    if (action === 'generate') setImmediate(pump);
    return view();
  }
  // Serialize user mutations, including awaits in imports and handoff, to keep revision checks atomic.
  let actions = Promise.resolve();
  const hasActive=()=>Object.values(store.projects).some(s=>s.jobs.some(j=>active(j)||j.status==='interrupted'&&j.externalId));
  function serialize(fn){const result=actions.then(fn);actions=result.catch(()=>{});return result;}
  async function importSnapshot(data,expected,creationRevision){
    if(!expected||expected!==editorRevision()||creationRevision!==current().revision)throw Object.assign(new Error('工程已在其他页面更新，请刷新后重新导入'),{statusCode:409});
    if(hasActive())throw Object.assign(new Error('有生成任务正在运行或等待查询，请完成任务后再导入工程'),{statusCode:409});
    const before=structuredClone(getProject()),id=data.project.id,previous=store.projects[id];
    const next=structuredClone(data.creation||previous||fresh(id));next.revision=(previous?.revision||0)+1;next.updatedAt=now();
    await setProject(data.project,expected);
    try{store.projects[id]=next;await save();}
    catch(error){if(previous)store.projects[id]=previous;else delete store.projects[id];await setProject(before,editorRevision());throw error;}
    return view();
  }
  return {view,snapshot:()=>structuredClone(current()),act:input=>serialize(()=>act(input)),importSnapshot:(...args)=>serialize(()=>importSnapshot(...args)),hasActive,close(){closed=true;abort.abort();},flush:()=>queue};
}
