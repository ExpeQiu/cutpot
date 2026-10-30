import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { run } from '../src/render.js';
import { manifestSchema, validateManifestFile, dryRunManifest } from '../src/manifest.js';

test('manifest schema exposes versioned fields and example',()=>{
  const schema=manifestSchema();
  assert.equal(schema.kind,'cutpot.render.manifest');
  assert.equal(schema.schemaVersion,1);
  assert.ok(schema.fields.clips);
  assert.equal(schema.example.clips.length,2);
});

test('validate and dry-run inspect local media without requiring a workbench',async t=>{
  try{await run('ffmpeg',['-version']);await run('ffprobe',['-version']);}catch{t.skip('FFmpeg/ffprobe not installed');return;}
  const temp=await mkdtemp(path.join(os.tmpdir(),'cutpot-manifest-'));
  try{
    const video=path.join(temp,'shot.mp4'),image=path.join(temp,'still.png');
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=red:s=160x120:r=25:d=1','-c:v','libx264',video]);
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=120x160','-frames:v','1',image]);
    const manifest=path.join(temp,'film.json');
    await writeFile(manifest,JSON.stringify({
      name:'dry',resolution:'1280x720',fps:25,
      clips:[{file:'shot.mp4',sourceIn:0.12,duration:0.4,subtitle:'开场'},{file:'still.png',duration:0.6}],
    }));
    const validated=await validateManifestFile(manifest);
    assert.equal(validated.ok,true);
    assert.equal(validated.summary.clips,2);
    assert.equal(validated.summary.frames,25);
    const plan=await dryRunManifest(manifest,{output:path.join(temp,'out.mp4')});
    assert.equal(plan.ok,true);
    assert.equal(plan.dryRun,true);
    assert.equal(plan.imported,false);
    assert.equal(plan.rendered,false);
    assert.equal(plan.duration,1);
    assert.equal(plan.clips[0].startFrame,0);
    assert.equal(plan.clips[0].endFrame,10);
    assert.equal(plan.clips[1].startFrame,10);
    assert.equal(plan.clips[1].endFrame,25);
    assert.match(plan.output,/out\.mp4$/);

    const missing=path.join(temp,'bad.json');
    await writeFile(missing,JSON.stringify({clips:[{file:'nope.mp4',duration:1}]}));
    const failed=await validateManifestFile(missing);
    assert.equal(failed.ok,false);
    assert.equal(failed.issues[0].code,'MANIFEST_FILE_MISSING');
    assert.equal(failed.issues[0].clip,1);

    const tooLong=path.join(temp,'long.json');
    await writeFile(tooLong,JSON.stringify({resolution:'1280x720',fps:25,clips:[{file:'shot.mp4',sourceIn:0,duration:5}]}));
    const overflow=await dryRunManifest(tooLong);
    assert.equal(overflow.ok,false);
    assert.equal(overflow.issues[0].code,'MANIFEST_PROJECT');
    assert.equal(overflow.issues[0].clip,1);
  }finally{
    await rm(temp,{recursive:true,force:true});
  }
});
