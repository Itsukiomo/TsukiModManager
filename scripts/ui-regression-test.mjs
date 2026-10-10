import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire("C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs");
const { chromium } = require("playwright");
const output = path.resolve("src-tauri/target/profile-smoke/ui-verification");
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({headless:true,channel:"msedge"});
const results = [];
try {
  const page = await browser.newPage();
  for (const viewport of [{width:1500,height:900},{width:1100,height:700},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    for (const mode of ["startup","cards","home-cards","installed","titlebar","detail","sidebar"]) {
      if (mode === "sidebar" && viewport.width < 1100) continue;
      await page.goto(`http://localhost:1420/scripts/ui-regression-preview.html?mode=${mode}`, {waitUntil:"networkidle"});
      const key = `${mode}-${viewport.width}`;
      await page.screenshot({path:path.join(output,`${key}.png`),fullPage:true});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1), `${key} overflows horizontally`);
      if (mode === "startup") {
        const box = await page.locator(".boot-screen").boundingBox();
        assert.equal(box.width,viewport.width); assert.equal(box.height,viewport.height);
        const brand = await page.locator(".boot-brand").boundingBox();
        assert(brand.y+brand.height < viewport.height, "Startup brand is clipped");
      }
      if (mode === "sidebar") {
        const progress = page.getByRole("progressbar");
        assert.equal(await progress.getAttribute("aria-valuenow"),null);
        const box = await progress.boundingBox();
        assert(box && box.width > 100 && box.y >= 44 && box.y + box.height <= viewport.height, "Sidebar progress is clipped");
      }
      if (mode === "cards") {
        const colors = await page.locator(".tsuki-mod-card-tags .tag-color-dynamic").evaluateAll(nodes=>nodes.slice(0,4).map(node=>getComputedStyle(node).backgroundColor));
        assert(new Set(colors).size >= 3,"Tag colors were overwritten");
        const install = page.getByRole("button",{name:"Install",exact:true}).first();
        assert.equal(await install.evaluate(node=>getComputedStyle(node).backgroundColor),"rgb(114, 223, 189)","Install color was overwritten");
        await install.focus(); await page.keyboard.press("Enter");
        assert.deepEqual(await page.evaluate(()=>qaClicks),["install"],"Nested card keyboard input also opened the card");
      }
      if (mode === "cards" || mode === "home-cards" || mode === "installed") {
        const expand = page.getByRole("button",{name:/Show all .* tags/}).first();
        await expand.focus(); await page.keyboard.press("Enter");
        const popup = page.getByRole("dialog",{name:"All mod tags"});
        assert(await popup.isVisible(), "Tag overflow did not open");
        const bounds = await popup.boundingBox();
        assert(bounds.x >= 0 && bounds.x+bounds.width <= viewport.width && bounds.y+bounds.height <= viewport.height, "Tag popup is clipped");
        assert.equal(await popup.locator(".mod-tags-expanded-list > span").count(), mode === "installed" ? 5 : 4);
        await page.screenshot({path:path.join(output,`${key}-tags.png`),fullPage:true});
        await page.keyboard.press("Escape");
        assert.equal(await popup.count(), 0, "Escape did not close tag popup");
        assert(await expand.evaluate(node => node === document.activeElement), "Focus not restored to tag button");
        await expand.click();
        await page.mouse.click(1,1);
        assert.equal(await popup.count(), 0, "Outside click did not close tag popup");
        assert(!(await page.evaluate(()=>qaClicks)).includes("open"), "Tag interaction opened the mod");
      }
      if (mode === "cards" || mode === "home-cards") {
        for (const card of await page.locator(".image-led-card").all()) {
          const frame = await card.boundingBox();
          const art = await card.locator(".tsuki-mod-card-hero").boundingBox();
          assert.equal(frame.height,370,"Shared card dimensions regressed");
          assert(art.height >= frame.height-3,"Shared card image does not fill the tile");
          for (const child of ["h3", ".tsuki-mod-card-author", ".mod-tag-list", ".tsuki-mod-card-footer", ".tsuki-mod-card-actions"]) {
            const box = await card.locator(child).boundingBox();
            assert(box.y >= frame.y && box.y+box.height <= frame.y+frame.height+1 && box.x >= frame.x && box.x+box.width <= frame.x+frame.width+1, `${mode} ${child} is clipped`);
          }
        }
        if (mode === "home-cards") {
          const card = page.locator(".image-led-card").first();
          assert(await card.locator(".tsuki-mod-card-hero img").evaluate(node=>node.complete && node.naturalWidth>0));
          assert.equal(await card.locator(".tsuki-mod-card-stat").count(),5,"Shared stats disappeared");
          await card.getByRole("button",{name:"Install",exact:true}).focus();
          await page.keyboard.press("Enter");
          assert.deepEqual(await page.evaluate(()=>qaClicks),["install"]);
        }
      }
      if (mode === "installed") {
        const card = page.locator(".installed-card-shell").first();
        assert(await card.locator(".tsuki-mod-card-hero img").evaluate(node => node.complete && node.naturalWidth > 0), "Installed artwork did not load");
        const outer = await card.boundingBox();
        const image = await card.locator(".tsuki-mod-card-hero").boundingBox();
        assert(image.height >= outer.height - 3, "Installed art does not fill the tile");
        const body = await card.locator(".tsuki-mod-card-body").boundingBox();
        assert(body.height < outer.height * .36, "Installed information panel is too large");
        const tagBounds = await card.locator(".mod-tag-list > span, .mod-tags-expand").evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect(); return {y:r.y,h:r.height}}));
        assert(tagBounds.every(box=>Math.abs(box.y-tagBounds[0].y)<1 && box.h===22), "Plus button and tag badges are misaligned");
        const plusContents = await card.locator(".mod-tags-expand > svg, .mod-tags-expand > span").evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect(); return r.y+r.height/2}));
        assert(Math.abs(plusContents[0]-plusContents[1])<1,"Plus count is not vertically centered");
        assert((await card.locator(".tsuki-mod-card-body").evaluate(node=>getComputedStyle(node).backgroundImage)).includes("0.68"),"Installed overlay is opaque");
        const on = card.getByRole("button",{name:"On",exact:true});
        const off = page.getByRole("button",{name:"Off",exact:true}).first();
        assert.equal(await on.getAttribute("aria-pressed"),"true");
        assert.equal(await off.getAttribute("aria-pressed"),"false");
        assert.equal((await on.boundingBox()).width,62);
        assert.equal((await off.boundingBox()).width,62);
        assert.notEqual(await on.evaluate(node=>getComputedStyle(node).backgroundImage), await off.evaluate(node=>getComputedStyle(node).backgroundImage));
        assert(await page.locator(".mod-state-toggle[aria-busy=true]").isDisabled());
        for (const child of ["h3", ".tsuki-mod-card-author", ".mod-tag-list", ".tsuki-mod-card-footer"]) {
          const box = await card.locator(child).boundingBox();
          assert(box.y >= outer.y && box.y+box.height <= outer.y+outer.height+1, `${child} clipped in installed card`);
        }
        await card.getByRole("button",{name:"On",exact:true}).click();
        assert.deepEqual(await page.evaluate(()=>qaClicks),["toggle"]);
      }
      if (mode === "titlebar") {
        const logo = page.locator(".window-logo-image");
        assert(await logo.evaluate(node => node.complete && node.naturalWidth > 0), "Logo is not loaded");
        assert.equal((await page.locator(".window-titlebar").boundingBox()).height,58);
        if (viewport.width >= 1100) {
          assert(await page.getByRole("button",{name:"Launch Modded",exact:true}).isVisible());
          assert(await page.getByRole("button",{name:"Launch Modded",exact:true}).isDisabled());
          await page.getByRole("button",{name:"Check Updates",exact:true}).click();
          assert.deepEqual(await page.evaluate(()=>qaClicks),["check-update"]);
        }
      }
      if (mode === "detail") {
        assert.equal(await page.locator(".unified-hero-media").count(),0,"Missing media must not reserve an empty hero");
        await page.getByRole("button",{name:/^Files/}).click();
        await page.getByRole("button",{name:"Install file",exact:true}).click();
        assert.deepEqual(await page.evaluate(()=>qaClicks),["file-install"]);
        const safe = await page.evaluate(()=>qaSanitize('<img src=x onerror=alert(1)><svg><script>alert(1)</script></svg><a href="javascript:alert(1)">link</a><table><tr><td>safe</td></tr></table>'));
        assert(!/onerror|javascript:|<script|<svg/.test(safe)); assert(safe.includes("<table>"));
      }
      results.push({mode,viewport,status:"passed"});
    }
  }
  for (const theme of ["polar-day","true-dark","sakura-night"]) {
    await page.setViewportSize({width:1500,height:900});
    await page.goto(`http://localhost:1420/scripts/ui-regression-preview.html?theme=${theme}`,{waitUntil:"networkidle"});
    await page.screenshot({path:path.join(output,`cards-${theme}.png`)});
    results.push({theme,status:"rendered"});
    await page.goto(`http://localhost:1420/scripts/ui-regression-preview.html?mode=installed&theme=${theme}`,{waitUntil:"networkidle"});
    await page.screenshot({path:path.join(output,`installed-${theme}.png`)});
    const height = (await page.locator(".installed-card-shell").first().boundingBox()).height;
    assert.equal(height,370, "Installed card theme changed dimensions");
    results.push({mode:"installed",theme,status:"passed"});
  }
  await page.setViewportSize({width:1100,height:700});
  for (const state of ["ready&long", "ready&switching&long", "busy", "update"]) {
    await page.goto(`http://localhost:1420/scripts/ui-regression-preview.html?mode=titlebar&${state}`,{waitUntil:"networkidle"});
    const modded = page.getByRole("button",{name:"Launch Modded",exact:true});
    assert.equal(await modded.isDisabled(), state !== "ready&long");
    assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1));
    const buttons = await page.locator(".window-titlebar button:visible").evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}}));
    for(let i=1;i<buttons.length;i++) assert(buttons[i].x >= buttons[i-1].x+buttons[i-1].w-1,"Titlebar controls overlap");
    if (state === "update") { await page.getByRole("button",{name:/Update Available/}).click(); assert.deepEqual(await page.evaluate(()=>qaClicks),["install-update"]); }
    await page.screenshot({path:path.join(output,`titlebar-${state.replaceAll("&","-")}.png`)});
    results.push({mode:"titlebar",state,status:"passed"});
  }
  await page.goto("http://localhost:1420/scripts/ui-regression-preview.html?mode=sidebar&progress=72",{waitUntil:"networkidle"});
  assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"),"72");
  fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(results,null,2));
  console.log(`UI checks passed: ${results.length} viewport/theme cases. Screenshots: ${output}`);
} finally { await browser.close(); }
