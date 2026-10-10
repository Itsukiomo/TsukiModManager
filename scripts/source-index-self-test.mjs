import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve("src-tauri/target/profile-smoke", `source-index-${Date.now()}`);
const appdata = path.join(root, "isolated-appdata");
fs.mkdirSync(appdata, { recursive: true });
const result = spawnSync("cargo", ["test", "--lib", "source_index_identification_sandbox", "--", "--ignored", "--nocapture", "--test-threads=1"], {
  cwd: "src-tauri", stdio: "inherit", env: { ...process.env, APPDATA: appdata },
});
console.log(`Source index identification fixtures: ${root}`);
process.exitCode = result.status ?? 1;
