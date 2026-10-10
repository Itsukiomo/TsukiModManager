import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/jeffe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/runtime.cjs');
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:1420/scripts/profile-card-layout-preview.html');
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { DependencyActions } = await import('/src/components/DependencyActions.tsx');
    const { DEPENDENCY_CATALOG } = await import('/src/models/dependency.ts');
    window.requests = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.requests.push({ command, args }); return { messages: ['Verified test response'] };
    }};
    const node = document.createElement('div'); document.body.replaceChildren(node);
    createRoot(node).render(React.createElement(React.Fragment, null,
      React.createElement(DependencyActions, { dependency: DEPENDENCY_CATALOG.find(d => d.id === 'pd2-beardlib'), profileId: 'builtin.payday2' }),
      React.createElement(DependencyActions, { dependency: DEPENDENCY_CATALOG.find(d => d.id === 'outlast-iris'), profileId: 'builtin.outlast-trials' }),
    ));
  });
  await page.getByRole('button', { name: 'Install / Update', exact: true }).click();
  await page.getByRole('button', { name: 'Download / Update Tool', exact: true }).click();
  await page.waitForFunction(() => window.requests.length === 2);
  const requests = await page.evaluate(() => window.requests);
  assert.deepEqual(requests, [
    { command: 'install_profile_dependency', args: { profileId: 'builtin.payday2', dependencyId: 'pd2-beardlib' } },
    { command: 'download_profile_dependency_tool', args: { profileId: 'builtin.outlast-trials', dependencyId: 'outlast-iris' } },
  ]);
  console.log('Dependency action UI passed: explicit game profile and separate tool download command.');
} finally { await browser.close(); }
