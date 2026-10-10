import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/utils/homeTrendingSlots.ts',import.meta.url),'utf8');
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const {homeTrendingSlots}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
for(let length=0;length<=12;length++){
  const mods=Array.from({length},(_,index)=>({id:index}));
  const {featured,secondary}=homeTrendingSlots(mods);
  assert.deepEqual(secondary,mods.slice(2,6));
  assert.equal(new Set([...featured,...secondary]).size,length);
  const lowerIds=secondary.map(mod=>mod.id);
  for(let offset=0;offset<featured.length;offset++){
    const pair=[0,1].map(step=>featured[(offset+step)%featured.length]);
    assert(pair.every(mod=>!secondary.includes(mod)));
    assert.deepEqual(secondary.map(mod=>mod.id),lowerIds);
  }
}
console.log('Trending slots: 13 data sizes passed; static cards remain disjoint from rotating cards.');
