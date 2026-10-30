import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultProject, validateProject, subtitles, autoArrange } from '../src/project.js';

const assets=[{id:'a',name:'shot_10.mp4',type:'video',duration:5},{id:'b',name:'分镜02.png',type:'image'},{id:'c',name:'shot_01.mp4',type:'video',duration:2},{id:'voice',type:'audio',duration:10}];
const clip=(assetId,duration=1)=>({id:randomUUID(),assetId,duration,sourceIn:0,subtitle:'',locked:false,muted:true});
test('frame quantization and SRT use the same integer frame clock',()=>{
  const p={...defaultProject(),clips:[{...clip('a',1.51),subtitle:'第一句'},{...clip('b',1.49),subtitle:'第二句'}]};
  const v=validateProject(p,assets);
  assert.deepEqual(v.clips.map(c=>c.duration),[1.52,1.48]);
  assert.equal(subtitles(v),'1\n00:00:00,000 --> 00:00:01,520\n第一句\n\n2\n00:00:01,520 --> 00:00:03,000\n第二句\n');
});
test('reject missing assets, source overruns and invalid IDs; narration may be trimmed at export',()=>{
  for(const c of [clip('missing'),{...clip('a',3),sourceIn:3},{...clip('a'),id:'"><img src=x onerror=alert(1)>'},clip('a',NaN)]){
    assert.throws(()=>validateProject({...defaultProject(),clips:[c]},assets));
  }
  assert.equal(validateProject({...defaultProject(),clips:[clip('a')],narration:'voice'},assets).narration,'voice');
});
test('arrange sorts numbered shots while retaining locked slots',()=>{
  const p={...defaultProject(),clips:[clip('a'),{...clip('b'),locked:true},clip('c')]};
  assert.deepEqual(autoArrange(p,assets).clips.map(c=>c.assetId),['c','b','a']);
  assert.equal(p.clips[0].assetId,'a');
});
test('subtitles do not accumulate rounding drift across long timelines',()=>{
  const p=validateProject({...defaultProject(),clips:Array.from({length:1000},()=>({...clip('b',.04),subtitle:'一帧'}))},assets);
  assert.match(subtitles(p),/00:00:39,960 --> 00:00:40,000/);
});
