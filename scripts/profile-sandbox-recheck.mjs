import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.argv[2] ?? "");
const approved = path.resolve("src-tauri/target/profile-smoke") + path.sep;
if (!root.startsWith(approved) || !fs.existsSync(path.join(root, "report.json"))) {
  throw new Error("Pass an existing target/profile-smoke run directory.");
}
const appdata = path.join(root, "isolated-appdata");
fs.mkdirSync(appdata, { recursive: true });
const result = spawnSync("cargo", ["test", "--lib", "recheck_profile_sandbox_receipts", "--", "--ignored", "--nocapture", "--test-threads=1"], {
  cwd: "src-tauri", stdio: "inherit", env: { ...process.env, APPDATA: appdata, TSUKI_PROFILE_TEST_ROOT: root },
});
console.log(`Verified routing/receipt report: ${path.join(root, "recheck-report.json")}`);
process.exitCode = result.status ?? 1;
