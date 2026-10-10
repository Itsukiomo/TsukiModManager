import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium}=require('playwright');
const output=path.resolve('src-tauri/target/home-carousel-ui');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const documentBox=card=>card.evaluate(node=>{
  const rect=node.getBoundingClientRect();let x=rect.x+scrollX,y=rect.y+scrollY;
  for(let parent=node.parentElement;parent;parent=parent.parentElement){if(parent!==document.scrollingElement){x+=parent.scrollLeft;y+=parent.scrollTop;}}
  return {x,y,width:rect.width,height:rect.height};
});
try{
  for(const viewport of [{width:2274,height:1100},{width:1500,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport});
    await page.goto('http://localhost:1420/scripts/ui-regression-preview.html?mode=home-carousel',{waitUntil:'networkidle'});
    const featured=page.locator('.home-feature-panels .image-led-card');
    const lower=page.locator('.home-trending-mini-grid .image-led-card');
    const titles=await lower.locator('h3').allTextContents();
    const boxes=await Promise.all((await lower.all()).map(documentBox));
    await lower.evaluateAll(cards=>cards.forEach(card=>card.dataset.originalNode='true'));
    for(const card of await featured.all()){
      assert.equal((await card.boundingBox()).height,viewport.width<700?420:480);
      assert(await card.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0));
    }
    await page.getByRole('button',{name:'Next trending mods'}).click();
    await page.waitForTimeout(80);
    assert.deepEqual(await lower.locator('h3').allTextContents(),titles);
    assert(await lower.evaluateAll(cards=>cards.every(card=>card.dataset.originalNode==='true')));
    assert.deepEqual(await Promise.all((await lower.all()).map(documentBox)),boxes);
    await page.waitForTimeout(7100);
    assert.deepEqual(await lower.locator('h3').allTextContents(),titles);
    assert.deepEqual(await Promise.all((await lower.all()).map(documentBox)),boxes);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(output,`${viewport.width}.png`),fullPage:true});
    await page.close();
  }
}finally{await browser.close();}
console.log('Featured cards: height, manual/automatic rotation, stable lower cards and responsive layout passed at 3 viewports.');
