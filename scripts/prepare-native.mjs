import {cp,mkdir,readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length && (args.length!==1 || args[0]!=='--check')) throw new Error('Usage: node scripts/prepare-native.mjs [--check]');
const pairs=[['examples/shared/first-sound.js','examples/native/generated/first-sound.js'],['examples/shared/living-loop.js','examples/native/generated/living-loop.js'],['examples/shared/spatial-playground.js','examples/native/generated/spatial-playground.js'],['examples/shared/record-reuse.js','examples/native/generated/record-reuse.js'],['experiments/fixtures.js','examples/native/generated/fixtures.js'],['experiments/live-probes.js','examples/native/generated/live-probes.js']];
if(args[0]==='--check') {
  for(const [source,target] of pairs) {
    const expected=await readFile(join(root,source));
    let actual;
    try { actual=await readFile(join(root,target)); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    if(!actual || !expected.equals(actual)) {
      console.error(`Generated native file is missing or stale: ${target}. Run npm run prepare:native.`);
      process.exitCode=1;
    }
  }
  if(!process.exitCode) console.log('Generated native files match their sources. Installed package and device behavior are not checked.');
} else {
  await mkdir(join(root,'examples/native/generated'),{recursive:true});
  for(const [source,target] of pairs) await cp(join(root,source),join(root,target));
}
