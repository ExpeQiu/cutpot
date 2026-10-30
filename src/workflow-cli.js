import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Keep workflow actions and optimistic revision checks in the existing pipeline API.
export async function workflowCommand(base, command, args, options, { request, send }) {
  let action;
  if (command === 'workflow apply') {
    action = JSON.parse(await readFile(path.resolve(args[0]), 'utf8'));
    if (!action || Array.isArray(action) || typeof action !== 'object' || typeof action.action !== 'string') {
      throw new Error('操作文件必须是含 action 的 JSON 对象');
    }
    if (action.authorizeLive === true && !options['authorize-live']) {
      throw new Error('真实生成须在命令行明确添加 --authorize-live');
    }
  }
  const state = await request(base, '/api/pipeline');
  if (command === 'workflow show') return state;
  if (command === 'workflow wait') {
    const ids = new Set(args);
    const projectId = state.projectId;
    const timeout = options.timeout === undefined ? Infinity : Number(options.timeout);
    if (!(timeout > 0) || (options.timeout !== undefined && !Number.isFinite(timeout))) throw new Error('超时秒数须为正数');
    const deadline = Date.now() + timeout * 1000;
    let current = state;
    while (true) {
      if (current.projectId !== projectId) throw new Error('等待期间当前工程已切换');
      const jobs = [...ids].map(id => {
        const job = current.jobs.find(j => j.id === id);
        if (!job) throw new Error(`生成任务不存在：${id}`);
        return job;
      });
      const failed = jobs.find(j => ['failed', 'cancelled', 'interrupted'].includes(j.status));
      if (failed) throw new Error(`生成任务 ${failed.id} ${failed.status}：${failed.message || '请查询工作流'}`);
      if (jobs.every(j => j.status === 'completed')) return { projectId, jobs };
      if (Date.now() >= deadline) throw new Error('等待生成超时，任务继续运行；可用相同 ID 再次等待');
      await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
      current = await request(base, '/api/pipeline');
    }
  }
  if (command === 'workflow handoff') action = { action: 'handoff' };
  if (command === 'workflow generate') {
    const [kind, ...targets] = args;
    if (!['image', 'video'].includes(kind)) throw new Error('生成类型须为 image 或 video');
    const items = kind === 'image' ? state.shots : state.segments;
    if (targets.includes('all') && targets.length !== 1) throw new Error('all 不能与 ID 同用');
    action = { action: 'generate', kind, ids: targets[0] === 'all' ? items.map(x => x.id) : targets };
  }
  if (action.action === 'generate') action.authorizeLive = Boolean(options['authorize-live']);
  // An explicit revision in an action file remains authoritative: never silently retry conflicts.
  const payload = { projectId: state.projectId, revision: state.revision, ...action };
  if (payload.action === 'handoff' && payload.editorRevision === undefined) payload.editorRevision = state.editorRevision;
  const result = await send(base, '/api/pipeline', payload);
  if (payload.action !== 'generate') return result;
  const previousIds = new Set(state.jobs.map(j => j.id));
  return { projectId: result.projectId, revision: result.revision, jobs: result.jobs.filter(j => !previousIds.has(j.id)) };
}
