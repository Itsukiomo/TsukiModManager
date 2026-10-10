import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canRetryArchive, isTransientIndexError } from "./source-index-errors.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(process.env.APPDATA, "Tsuki Mod Manager");
const statusFile = path.join(app, "cache/all-games-index-job.json");
const lock = `${statusFile}.lock`;
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = e.code !== "ESRCH"; }
  if (alive) throw new Error(`The source index worker is already running (PID ${pid})`);
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
const startedAt = new Date().toISOString();
let currentPhase = "starting";
function counts() {
  const profiles = [];
  for (const dir of fs.readdirSync(path.join(app, "profile-data"), { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith("builtin.") || dir.name === "builtin.cyberpunk2077") continue;
    const root = path.join(app, "profile-data", dir.name, "source-index");
    const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(root, name), "utf8")); } catch { return fallback; } };
    const catalog = read("source-index.json", { records: {} });
    const hashes = read("file-hashes.json", { archives: {} });
    const progress = read("bulk-index-progress.json", { sources: {} });
    try {
      for (const line of fs.readFileSync(path.join(root, "archive-results.ndjson"), "utf8").split("\n").filter(Boolean)) {
        try { const row = JSON.parse(line); hashes.archives[row.key] = row.archive; } catch { /* Incomplete trailing journal record. */ }
      }
    } catch { /* No journal yet. */ }
    const archives = Object.values(hashes.archives);
    profiles.push({ profile: dir.name, mods: Object.keys(catalog.records).length,
      hashedArchives: archives.filter((a) => a.status === "hashed").length,
      hashedFiles: archives.reduce((n, a) => n + (a.fileEntries?.length || 0), 0),
      unavailableArchives: archives.filter((a) => a.status === "unavailable").length,
      retryableArchives: archives.filter(canRetryArchive).length,
      sources: Object.entries(progress.sources).map(([id, value]) => ({ id, catalogComplete: value.complete, seen: Object.keys(value.mods).length,
        providerTotal: value.total, excludedMods: Object.values(value.mods).filter((mod) => mod.indexed?.startsWith("excluded-")).length,
        unverifiedFilesExcluded: Object.values(value.mods).reduce((n, mod) => n + (mod.unverifiedFilesExcluded || 0), 0), error: value.error || null })) });
  }
  return profiles;
}
const status = (phase, extra = {}) => {
  currentPhase = phase;
  const value = { pid: process.pid, startedAt, updatedAt: new Date().toISOString(), phase, cyberpunk: "in-app-downloads-only", payday3: "UE5-only", profiles: counts(), ...extra };
  const tmp = `${statusFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, statusFile);
};
const timer = setInterval(() => { if (["catalogs", "downloading-and-hashing"].includes(currentPhase)) status(currentPhase); }, 30000);
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, "scripts/index-all-game-downloads.mjs"), ...args], { cwd: repo, stdio: "inherit", windowsHide: true });
    child.on("error", reject); child.on("exit", resolve);
  });
}
function pending() {
  const pending = [];
  const errors = [];
  for (const profile of counts()) {
    if (profile.retryableArchives) pending.push({ profile: profile.profile, source: "retryable-archives" });
  }
  for (const dir of fs.readdirSync(path.join(app, "profile-data"), { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith("builtin.") || dir.name === "builtin.cyberpunk2077") continue;
    const file = path.join(app, "profile-data", dir.name, "source-index/bulk-index-progress.json");
    if (!fs.existsSync(file)) continue;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [source, value] of Object.entries(state.sources)) {
      if (value.error) errors.push({ profile: dir.name, source, error: value.error });
      if (isTransientIndexError(value.error) || Object.values(value.mods).some((mod) => (!mod.indexed && !mod.error) || isTransientIndexError(mod.error))) pending.push({ profile: dir.name, source });
    }
  }
  return { pending, errors };
}
try {
  status("catalogs");
  await run(["--metadata-only"]);
  for (;;) {
    status("downloading-and-hashing");
    const code = await run([]);
    const work = pending();
    if (code === 1) { status("blocked", { ...work, error: "Index process stopped unexpectedly; see all-games-index-worker-errors.log" }); break; }
    if (!work.pending.length) { status(code === 0 ? "complete" : "finished-with-unavailable-files", work); break; }
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    status("waiting-to-retry", { ...work, resumeAt });
    await new Promise((resolve) => setTimeout(resolve, 60 * 60 * 1000));
  }
} catch (error) { status("blocked", { error: error.message }); process.exitCode = 1; }
finally { clearInterval(timer); fs.unlinkSync(lock); }
