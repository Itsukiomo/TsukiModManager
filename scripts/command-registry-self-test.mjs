import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const backend = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const registry = backend.slice(backend.indexOf('tauri::generate_handler!['));
const registered = new Set([...registry.matchAll(/\b([a-z][a-z0-9_]+)\s*[,\]]/g)].map(match => match[1]));
const missing = new Map();
function inspect(directory) {
  for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) inspect(file);
    else if (/\.tsx?$/.test(file)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\binvoke(?:<[^;]*?>)?\s*\(\s*["']([a-z][a-z0-9_]+)["']/g)) {
        if (!registered.has(match[1])) missing.set(match[1], file);
      }
    }
  }
}
inspect('src');
assert.equal(missing.size, 0, `Unregistered commands: ${JSON.stringify([...missing])}`);
console.log(`Tauri command registry passed (${registered.size} registered commands).`);
