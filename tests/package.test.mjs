import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const script=join(root,'scripts/check-package.mjs');
test('package verification compiles an isolated consumer and preserves previous artifacts',async()=>{
  const output=await mkdtemp(join(tmpdir(),'tunejs-package-test-'));
  try {
    await mkdir(join(output,'consumer'));
    await writeFile(join(output,'consumer/keep.txt'),'previous consumer');
    await writeFile(join(output,'package-results.json'),'previous results');
    await writeFile(join(output,'tunejs-0.0.1-dev.0.tgz'),'previous tarball');
    for(let i=0;i<2;i++) await exec(process.execPath,[script,'--output-root',output],{cwd:output});
    assert.equal(await readFile(join(output,'consumer/keep.txt'),'utf8'),'previous consumer');
    assert.equal(await readFile(join(output,'package-results.json'),'utf8'),'previous results');
    assert.equal(await readFile(join(output,'tunejs-0.0.1-dev.0.tgz'),'utf8'),'previous tarball');
    const runs=(await readdir(output)).filter(name=>name.startsWith('package-check-'));
    assert.equal(runs.length,2);
    for(const name of runs) {
      const run=join(output,name);
      const report=JSON.parse(await readFile(join(run,'package-results.json'),'utf8'));
      assert.equal(report.cleanConsumer,'pass');
      assert.equal(report.directory,run);
      assert.equal(report.tarball,join(run,report.filename));
      const installed=JSON.parse(await readFile(join(run,'consumer/node_modules/tunejs/package.json'),'utf8'));
      assert.equal(installed.name,'tunejs');
      assert.equal(installed.exports['.'].default,'./dist/index.js');
      assert.deepEqual(await readFile(join(run,'consumer/node_modules/tunejs/dist/engine.js')),await readFile(join(run,'package/dist/engine.js')));
      assert.deepEqual(await readFile(join(run,'consumer/first-sound.js')),await readFile(join(root,'examples/shared/first-sound.js')));
      const html=await readFile(join(run,'consumer.html'),'utf8');
      assert.ok(html.includes('./consumer/node_modules/tunejs/dist/index.js'));
      assert.ok(html.includes('./consumer/first-sound.js'));
      assert.ok(!html.includes('"tunejs":"/dist/'));
    }
  } finally { await rm(output,{recursive:true,force:true}); }
});
test('package and native preparation scripts reject unknown arguments',async()=>{
  for(const file of [script,join(root,'scripts/prepare-native.mjs')]) {
    await assert.rejects(exec(process.execPath,[file,'--unknown'],{cwd:root}),error=>error.code===1&&error.stderr.includes('Usage:'));
  }
});
