import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [rootArg, profile, phase] = process.argv.slice(2);
if (!["builtin.payday2", "builtin.payday3"].includes(profile) || !["install", "restore"].includes(phase)) {
  throw new Error("Usage: node scripts/profile-real-game-sample.mjs <sandbox-root> <profile-id> <install|restore>");
}
const root = fs.realpathSync(rootArg);
const approved = fs.realpathSync("src-tauri/target/profile-smoke");
if (!root.startsWith(`${approved}${path.sep}`)) throw new Error("Expected a sandbox report root");
const processes = spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process | Select-Object -ExpandProperty ProcessName"], { encoding: "utf8" });
if (processes.status !== 0) throw new Error("Could not establish whether games are closed");
if (/^PAYDAY(?:2|3.*)$/im.test(processes.stdout)) throw new Error("Close PAYDAY games before changing sample files");
const appdata = path.join(root, "real-appdata");
fs.mkdirSync(appdata, { recursive: true });
const result = spawnSync("cargo", ["test", "--lib", "real_game_sample_deployment", "--", "--ignored", "--nocapture", "--test-threads=1"], {
  cwd: "src-tauri", stdio: "inherit",
  env: { ...process.env, APPDATA: appdata, TSUKI_PROFILE_TEST_ROOT: root, TSUKI_REAL_TEST_PROFILE: profile, TSUKI_REAL_TEST_PHASE: phase },
});
process.exit(result.status ?? 1);
