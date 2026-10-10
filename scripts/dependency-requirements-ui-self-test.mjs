import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto('http://localhost:1420/scripts/profile-card-layout-preview.html');
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { DependencyRequirements } = await import('/src/components/DependencyRequirements.tsx');
    window.requests = []; window.resolved = []; window.loading = [];
    window.failRequirements = false;
    const image = '/src/assets/tsuki-lunar-logo-v2-ui.png';
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.requests.push({ command, args });
      if (command === 'fetch_mod_requirements') {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (window.failRequirements) throw new Error('Test source offline');
        return [{ name: 'BeardLib', required: true, sourceKind: 'modworkshop', modId: '14924', url: 'https://modworkshop.net/mod/14924', thumbnailUrl: image }, { name: 'Optional sample', optional: true, required: false, sourceKind: 'nexus', modId: '123', gameDomain: 'payday2', url: 'https://www.nexusmods.com/payday2/mods/123' }];
      }
      if (command === 'fetch_dependency_metadata') return { name: args.source === 'nexus' ? 'Optional named dependency' : args.modId === '14924' ? 'BeardLib' : 'SuperBLT 64-bit Beta', thumbnailUrl: image, sourceId: args.modId, source: args.source, version: '1.0' };
      return { messages: ['Test only'] };
    }};
    const node = document.createElement('div'); document.body.replaceChildren(node);
    Object.assign(document.body.style, { margin: '20px', width: 'auto', background: '#101017', color: '#eee', fontFamily: 'Arial' });
    window.root = createRoot(node);
    window.renderRequirements = (id = 'test') => window.root.render(React.createElement(DependencyRequirements, { mod: { source: 'modworkshop', sourceId: id, name: 'Safe example', files: [] }, profileId: 'builtin.payday2', onResolved: value => window.resolved.push(value), onLoadingChange: value => window.loading.push(value) }));
    window.renderRequirements();
  });
  await page.getByRole('button', { name: 'Optional named dependency', exact: true }).waitFor();
  assert.equal(await page.locator('.dependency-requirement-card').count(), 3);
  assert.equal(await page.locator('.dependency-requirement-labels .required').count(), 2);
  assert.equal(await page.locator('.dependency-requirement-labels .optional').count(), 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.dependency-requirement-image img')].every(image => image.complete && image.naturalWidth > 0));
  assert.deepEqual(await page.evaluate(() => window.loading), [true, false]);
  assert.equal((await page.evaluate(() => window.resolved[0])).length, 2);
  assert.ok((await page.evaluate(() => window.requests)).every(request => request.args.profileId === 'builtin.payday2'));
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth).map(element => ({ class: element.className, right: element.getBoundingClientRect().right })) }));
    assert.ok(layout.scroll <= width, JSON.stringify(layout));
  }
  await page.screenshot({ path: 'D:/TsukiReleaseQualification/dependency-requirements-mobile.png', fullPage: true });
  await page.evaluate(() => { window.failRequirements = true; window.renderRequirements('error'); });
  await page.getByText('Test source offline', { exact: false }).waitFor();
  await page.evaluate(() => { window.failRequirements = false; });
  await page.getByRole('button', { name: 'Retry requirements', exact: true }).click();
  await page.getByRole('button', { name: 'Optional named dependency', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.dependency-requirements-error'));
  console.log('Requirements UI passed: names, thumbnails, Required/Optional, transitive parents, profile isolation, loading, error/retry, desktop/mobile layout.');
} finally { await browser.close(); }
