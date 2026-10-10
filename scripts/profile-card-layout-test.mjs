import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const {chromium} = require('playwright');
const output = 'D:/TsukiReleaseQualification/profile-card-layout';
fs.mkdirSync(output, {recursive: true});
const browser = await chromium.launch({headless: true, channel: 'msedge'});
try {
  const page = await browser.newPage();
  for (const width of [1500, 1100, 800, 390]) {
    await page.setViewportSize({width, height: 950});
    await page.goto('http://localhost:1420/scripts/profile-card-layout-preview.html');
    await page.locator('article.game-profile-card').first().waitFor();
    const versions = page.getByRole('combobox', {name: 'PAYDAY 3 game version'});
    for (const version of ['UE5.5', 'UE4.27', 'UE5.5']) {
      await versions.selectOption(version);
      const boxes = await page.locator('article.game-profile-card').evaluateAll(nodes => nodes.map(node => {
        const card = node.getBoundingClientRect(), surface = node.querySelector('.game-profile-select-surface').getBoundingClientRect();
        const select = node.querySelector('select')?.getBoundingClientRect();
        const image = node.querySelector('.game-profile-artwork-frame').getBoundingClientRect();
        const spans = [...node.querySelectorAll('.game-profile-card-meta > span')].map(span => span.getBoundingClientRect());
        return {height: card.height, width: card.width, imageHeight: image.height, imageWidth: image.width, titleBottom: spans[0].bottom - card.bottom, versionTop: spans[1].top - card.bottom, fills: Math.abs(image.height - node.clientHeight) < 1.1 && Math.abs(image.width - node.clientWidth) < 1.1, contained: !select || (select.bottom <= card.bottom && select.top >= Math.max(...spans.map(span => span.bottom)) && select.left >= card.left && select.right <= card.right)};
      }));
      assert(boxes.length > 3);
      assert(Math.max(...boxes.map(box => box.height)) - Math.min(...boxes.map(box => box.height)) < 1, `Card heights differ at ${width}/${version}`);
      assert(Math.max(...boxes.map(box => box.imageHeight)) - Math.min(...boxes.map(box => box.imageHeight)) < 1, `Image heights differ at ${width}/${version}`);
      assert(boxes.every(box => box.fills), `Cover does not fill the card at ${width}/${version}`);
      assert(Math.max(...boxes.map(box => box.titleBottom)) - Math.min(...boxes.map(box => box.titleBottom)) < 1, `Title baselines differ at ${width}/${version}`);
      assert(Math.max(...boxes.map(box => box.versionTop)) - Math.min(...boxes.map(box => box.versionTop)) < 1, `Metadata rows differ at ${width}/${version}`);
      assert(boxes.every(box => box.contained), `Version picker overflows or overlaps the selection surface at ${width}/${version}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow at ${width}`);
    }
    await page.screenshot({path: path.join(output, `profiles-${width}.png`), fullPage: true});
  }
  console.log('Profile card dimensions and contained version controls passed at four widths and both engine versions.');
} finally { await browser.close(); }
