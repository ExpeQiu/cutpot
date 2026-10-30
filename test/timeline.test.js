import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {timeline,timelineDuration,activeAt,splitAt,trimEdge,sourceOut,normalizeTransitions} from '../public/timeline.js';
import {defaultProject,validateProject,subtitles} from '../src/project.js';
const video={id:'v',name:'source.mp4',type:'video',duration:12};
const clip=(duration=4)=>({id:randomUUID(),assetId:'v',sourceIn:1,duration,speed:1,subtitle:'字幕'});
const project=(clips)=>({...defaultProject(),clips});

test('speed validation uses the consumed source range and keeps old projects compatible',()=>{
  const p=validateProject(project([{...clip(3),speed:2}]),[video]);
  assert.equal(sourceOut(p.clips[0]),7);
  assert.throws(()=>validateProject(project([{...clip(6),speed:2}]),[video]),/超出/);
  for(const speed of [0,.24,4.01,NaN])assert.throws(()=>validateProject(project([{...clip(),speed}]),[video]),/倍速/);
  const legacy=clip();delete legacy.speed;
  assert.equal(validateProject(project([legacy]),[video]).clips[0].speed,1);
  assert.throws(()=>validateProject(project([{...clip(),transition:{type:'unknown',duration:.4}}]),[video]),/转场/);
});
test('overlaps, preview and SRT share an integer frame clock',()=>{
  const p=project([{...clip(2),transition:{type:'dissolve',duration:.4}},clip(3),clip(1)]);
  assert.deepEqual(timeline(p).map(i=>[i.start,i.end]),[[0,2],[1.6,4.6],[4.6,5.6]]);
  assert.equal(timelineDuration(p),5.6);
  assert.equal(activeAt(p,1.8).previous.clip.id,p.clips[0].id);
  assert.equal(activeAt(p,2).previous,null);
  assert.match(subtitles(p),/00:00:00,000 --> 00:00:01,600/);
  assert.match(subtitles(p),/00:00:01,600 --> 00:00:04,600/);
});
test('short clips clamp adjacent transitions and the last clip cannot have an outgoing transition',()=>{
  const p=project(Array.from({length:3},()=>({...clip(.12),transition:{type:'dissolve',duration:1}})));
  normalizeTransitions(p);
  assert.deepEqual(p.clips.map(c=>c.transition?.duration??0),[.04,.04,0]);
  assert.equal(timelineDuration(p),.28);
});
test('split keeps sped source continuous and transfers the outgoing transition',()=>{
  const p=project([{...clip(4),speed:2,transition:{type:'fadeblack',duration:.4}},clip(2)]);
  const right=splitAt(p,p.clips[0].id,1.6,randomUUID());
  assert.equal(p.clips[0].duration,1.6);assert.equal(right.duration,2.4);
  assert.equal(sourceOut(p.clips[0]),right.sourceIn);
  assert.equal(right.transition.type,'fadeblack');assert.equal(p.clips[0].transition,null);
  assert.equal(timelineDuration(p),5.6);
  assert.throws(()=>splitAt(p,right.id,3.8,randomUUID()),/转场/);
  assert.throws(()=>splitAt(p,right.id,3.4,randomUUID()),/转场/);
  p.clips[0].locked=true;assert.throws(()=>splitAt(p,p.clips[0].id,.4,randomUUID()),/解锁/);
});
test('edge trims respect source boundaries, speed and one frame minimum',()=>{
  const p=project([{...clip(4),speed:2}]),id=p.clips[0].id;
  trimEdge(p,id,'in',1,video);assert.equal(p.clips[0].sourceIn,3);assert.equal(p.clips[0].duration,3);
  trimEdge(p,id,'out',100,video);assert.equal(p.clips[0].duration,4.48);
  trimEdge(p,id,'in',100,video);assert.equal(p.clips[0].duration,.04);
  assert.ok(sourceOut(p.clips[0])<=video.duration);
  trimEdge(p,id,'in',-100,video);assert.ok(p.clips[0].sourceIn>=0);
});
