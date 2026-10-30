import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../bin/cutpot-cli.js', import.meta.url));
const server = fileURLToPath(new URL('../src/server.js', import.meta.url));
test('workflow CLI: split, generate frames/video, select, review, conflict and handoff', { timeout: 120000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cutpot-workflow-cli-'));
  const port = String(24000 + Math.floor(Math.random() * 15000));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [server], { env: { ...process.env, PORT: port, CUTPOT_DATA: temp }, stdio: ['ignore','pipe','pipe'] });
  async function cli(args, expected = 0) {
    const result = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [entry, '--url', base, '--json', ...args]);
      let out = '', err = ''; p.stdout.on('data', b => out += b); p.stderr.on('data', b => err += b);
      p.once('error', reject); p.once('exit', code => resolve({ code, out, err }));
    });
    assert.equal(result.code, expected, JSON.stringify(result));
    return JSON.parse(result.out);
  }
  const file = path.join(temp, '操作 with space.json');
  async function apply(action, expected = 0) { await writeFile(file, JSON.stringify(action)); return cli(['workflow','apply',file], expected); }
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`))); child.stdout.once('data', resolve); });
    let s = await apply({ action: 'split', script: '人物走进教室。\n\n人物走出教室。', count: 2 });
    assert.equal(s.shots.length, 2); assert.equal(s.segments.length, 1);
    assert.match((await apply({ action: 'add-shot', revision: s.revision - 1 }, 1)).error, /更新/);
    s = await apply({ action: 'settings', settings: { ...s.settings, candidates: 1 } });
    const images = await cli(['workflow','generate','image','all']);
    assert.equal(images.jobs.length, 2);
    await cli(['workflow','wait', ...images.jobs.map(j => j.id), '--timeout','60']);
    s = await cli(['workflow','show']);
    assert.ok(s.shots.every(x => x.selectedVersionId));
    await apply({ action: 'segment', id: s.segments[0].id, prompt: '人物平稳走出教室', duration: 1 });
    const videos = await cli(['workflow','generate','video',s.segments[0].id]);
    assert.equal(videos.jobs.length, 1);
    await cli(['workflow','wait',videos.jobs[0].id,'--timeout','60']);
    s = await cli(['workflow','show']);
    assert.equal(s.segments[0].stale, false);
    await apply({ action: 'select-version', kind: 'video', id: s.segments[0].id, versionId: s.segments[0].selectedVersionId });
    await apply({ action: 'review', id: s.segments[0].id, review: 'rejected' });
    assert.match((await cli(['workflow','handoff'], 1)).error, /返工/);
    await apply({ action: 'review', id: s.segments[0].id, review: 'approved' });
    assert.equal((await cli(['workflow','handoff'])).editorClips, 1);
    assert.equal((await cli(['workflow','handoff'])).editorClips, 1);
    assert.match((await cli(['workflow','wait','missing'], 1)).error, /不存在/);
    assert.match((await cli(['workflow','generate','image','all',s.shots[0].id], 1)).error, /不能/);
    await apply({ action: 'settings', settings: { ...s.settings, mode: 'live' } });
    assert.match((await cli(['workflow','generate','image','all'], 1)).error, /授权/);
    assert.match((await apply({ action: 'generate', kind: 'image', ids: [s.shots[0].id], authorizeLive: true }, 1)).error, /authorize-live/);
    assert.match((await cli(['workflow','generate','video','all','--authorize-live'], 1)).error, /模拟帧/);
  } finally {
    if (child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; }
    await rm(temp, { recursive: true, force: true });
  }
});
