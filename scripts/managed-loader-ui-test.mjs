import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium}=require('playwright');
const output=path.resolve('src-tauri/target/managed-loader-ui');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
let count=0;
try{
  for(const viewport of [{width:1200,height:800},{width:390,height:844}]){
    const page=await browser.newPage({viewport});
    for(const mode of ['disclosure','ready','missing','failure','unconfigured']){
      await page.goto(`http://localhost:1420/scripts/managed-loader-preview.html?mode=${mode}`,{waitUntil:'networkidle'});
      await page.getByRole('region',{name:'Native PAK support'}).waitFor();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
      if(mode==='disclosure'){
        assert.equal(await page.evaluate(()=>loaderCalls.filter(c=>c.command==='managed_loader_action').length),0,'Download ran without consent');
        await page.getByRole('button',{name:'Enable Support'}).click();
        await page.getByRole('button',{name:'Repair',exact:true}).waitFor();
      }
      if(mode==='missing'){
        await page.getByRole('button',{name:'Repair',exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>loaderCalls.filter(c=>c.args?.action==='ensure').length),1);
      }
      if(mode==='failure'){
        await page.getByRole('alert').waitFor();
        assert(await page.getByRole('button',{name:'Retry',exact:true}).isEnabled());
      }
      if(mode==='unconfigured')assert.equal(await page.getByRole('button').count(),0);
      await page.screenshot({path:path.join(output,`${mode}-${viewport.width}.png`)});count++;
    }
    await page.goto('http://localhost:1420/scripts/managed-loader-preview.html?mode=ready',{waitUntil:'networkidle'});
    await page.evaluate(()=>{switchLoaderProfile('builtin.payday2');});
    await page.waitForTimeout(50);
    assert.equal(await page.getByRole('region',{name:'Native PAK support'}).count(),0,'Loader status leaked into another game');
    await page.evaluate(()=>{switchLoaderProfile('builtin.outlast-trials');});
    await page.getByRole('button',{name:'Repair',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>loaderCalls.filter(c=>c.command==='managed_loader_action').length),0,'Reopening an intact profile downloaded a runtime');count++;
    await page.close();
  }
}finally{await browser.close();}
console.log(`Managed loader UI: ${count} scenarios passed.`);
