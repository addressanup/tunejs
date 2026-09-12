import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TuneError} from '../dist/index.js';
import {poseFromMatrix,poseFromObject,positionFromObject} from '../dist/three.js';
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const close=(a,b,tol=1e-12)=>Math.abs(a-b)<=tol;
const v3close=(a,b)=>{assert.ok(close(a.x,b.x)&&close(a.y,b.y)&&close(a.z,b.z),`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);};

// column-major 4x4: [xx,xy,xz,0, yx,yy,yz,0, zx,zy,zz,0, tx,ty,tz,1]
const translation=(x,y,z)=>[1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];

test('poseFromMatrix reads translation and applies metersPerUnit',()=>{
  const pose=poseFromMatrix(translation(2,0,-3));
  v3close(pose.position,{x:2,y:0,z:-3});
  v3close(pose.forward,{x:0,y:0,z:-1});
  v3close(pose.up,{x:0,y:1,z:0});
  v3close(poseFromMatrix(translation(2,0,-3),{metersPerUnit:0.5}).position,{x:1,y:0,z:-1.5});
});

test('poseFromMatrix extracts orientation from a rotation about Y',()=>{
  // +90° about Y: local X→-Z, local Z→+X, so forward (local -Z) reads as -X
  const r90=[0,0,-1,0, 0,1,0,0, 1,0,0,0, 0,0,0,1];
  const pose=poseFromMatrix(r90);
  v3close(pose.forward,{x:-1,y:0,z:0});
  v3close(pose.up,{x:0,y:1,z:0});
});

test('poseFromMatrix uses the world matrix as given (parent scale composed)',()=>{
  // parent scale 2 on a child translation of (1,0,0) composes to (2,0,0) in the world matrix
  const scaled=[2,0,0,0, 0,2,0,0, 0,0,2,0, 2,0,0,1];
  v3close(poseFromMatrix(scaled).position,{x:2,y:0,z:0});
});

test('poseFromObject refreshes the world matrix and never writes to the object',()=>{
  let calls=0;
  const object=new Proxy({
    matrixWorld:{elements:translation(4,5,6)},
    updateWorldMatrix(parents,children){calls++;assert.equal(parents,true);assert.equal(children,false);},
  },{set(){throw new Error('pose adapter must not write to the object');}});
  const pose=poseFromObject(object);
  assert.equal(calls,1);
  v3close(pose.position,{x:4,y:5,z:6});
  poseFromObject(object,{update:false});
  assert.equal(calls,1,'update:false skips the refresh');
  v3close(positionFromObject(object),{x:4,y:5,z:6});
  assert.equal(calls,2);
});

test('degenerate and non-finite matrices are rejected',()=>{
  assert.throws(()=>poseFromMatrix(new Array(16).fill(0)),code('INVALID_VALUE'));
  const nan=translation(0,0,0);nan[8]=NaN;
  assert.throws(()=>poseFromMatrix(nan),code('INVALID_VALUE'));
  const noZ=translation(0,0,0);noZ[8]=noZ[9]=noZ[10]=0;
  assert.throws(()=>poseFromMatrix(noZ),code('INVALID_VALUE'));
  assert.throws(()=>poseFromMatrix(translation(0,0,0),{metersPerUnit:0}),code('INVALID_VALUE'));
});
