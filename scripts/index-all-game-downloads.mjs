import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { canRetryArchive, isTransientIndexError } from "./source-index-errors.mjs";

// Checkpoints are separate from the existing source-index schema.
const app = path.join(process.env.APPDATA, "Tsuki Mod Manager");
const scratch = path.resolve(process.env.TSUKI_INDEX_SCRATCH || "D:/TsukiSourceIndexScratch");
const sevenZip = process.env.TSUKI_INDEX_7ZIP || "C:/Program Files/7-Zip/7z.exe";
const metadataOnly = process.argv.includes("--metadata-only");
const retry = process.argv.includes("--retry-errors");
const selected = process.argv.filter((arg) => arg.startsWith("builtin."));
const settings = JSON.parse(fs.readFileSync(path.join(app, "settings.json"), "utf8"));
const modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const module = { exports: {} };
  modules.set(file, module.exports);
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = (name) => /\.(png|jpg)$/.test(name) ? name : name.endsWith("profileArtwork") ? { profileImageReferenceFromValue: () => null } : load(path.resolve(path.dirname(file), `${name}.ts`));
  vm.runInNewContext(js, { module, exports: module.exports, require }, { filename: file });
  modules.set(file, module.exports);
  return module.exports;
}
const profiles = load("src/models/gameProfiles.ts").BUILTIN_GAME_PROFILES.filter((p) => p.profileId !== "builtin.cyberpunk2077" && (!selected.length || selected.includes(p.profileId)))
  .sort((a, b) => (a.profileId === "builtin.payday3" ? -1 : a.profileId === "builtin.payday2" ? 1 : 0) - (b.profileId === "builtin.payday3" ? -1 : b.profileId === "builtin.payday2" ? 1 : 0));
function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contents = JSON.stringify(value);
  const volume = fs.statfsSync(path.dirname(file));
  if (volume.bavail * volume.bsize < Buffer.byteLength(contents) + 512 * 1024 ** 2) throw new Error("Insufficient index storage disk space (512 MB reserve)");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, nexus = false, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers = { "User-Agent": "TsukiModManager/2.0", Accept: "application/json" };
    if (nexus) {
      if (!settings.nexusApiKey) throw new Error("Nexus API key missing");
      headers.apikey = settings.nexusApiKey;
    }
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetch(url, { headers, method: body ? "POST" : "GET", body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (response.status === 429) throw new Error("Provider rate limit reached; resume later with --retry-errors");
    if (response.status >= 500 && attempt < 2) { await pause(2000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    if (value.errors?.length) throw new Error(value.errors.map((e) => e.message).join("; "));
    await pause(120);
    return value;
  }
}
function summary(provider, source, mod, profile) {
  const workshop = provider === "modworkshop";
  const id = String(workshop ? mod.id : mod.modId);
  const tags = [workshop ? "ModWorkshop" : "Nexus", profile.displayName, ...(mod.tags || []).map((t) => t.name || t)];
  if (profile.profileId === "builtin.payday3") tags.push("UE5.5");
  return { source: provider, sourceId: id, uid: mod.uid == null ? null : String(mod.uid), gameId: String(source.providerGameId), name: mod.name,
    author: workshop ? mod.user?.name || null : mod.author || null, authorUsername: mod.user?.unique_name || null,
    version: mod.version || mod.custom_version || null,
    thumbnailUrl: workshop ? (mod.thumbnail?.file ? `https://storage.modworkshop.net/mods/images/${mod.thumbnail.file}` : null) : mod.thumbnailUrl || mod.pictureUrl || null,
    pageUrl: workshop ? `https://modworkshop.net/mod/${id}` : `https://www.nexusmods.com/${source.providerSlug}/mods/${id}`,
    updatedAt: mod.updatedAt || mod.updated_at || null, downloads: mod.downloads || null, likes: mod.endorsements || mod.likes || null,
    shortDescription: mod.summary || mod.short_desc || null, tags };
}
const query = `query TsukiFullCatalog($count: Int, $offset: Int, $filter: ModsFilter, $sort: [ModsSort!]) { mods(filter: $filter, sort: $sort, offset: $offset, count: $count) { nodes { modId uid gameId name summary version author updatedAt downloads endorsements pictureUrl thumbnailUrl } totalCount } }`;
async function page(source, number) {
  if (source.provider === "nexus") {
    const value = await request("https://api.nexusmods.com/v2/graphql", true, { query, variables: { count: 60, offset: (number - 1) * 60,
      filter: { gameDomainName: [{ value: source.providerSlug, op: "EQUALS" }] }, sort: [{ createdAt: { direction: "ASC" } }] } });
    return { mods: value.data.mods.nodes, total: value.data.mods.totalCount, last: Math.ceil(value.data.mods.totalCount / 60) };
  }
  const value = await request(`https://api.modworkshop.net/games/${source.providerSlug}/mods?limit=50&page=${number}&sort=published_at${source.providerSlug === "payday-3" ? "&block_tags%5B%5D=97" : ""}`);
  if (!Array.isArray(value.data) || !value.meta) throw new Error("Missing pagination metadata");
  return { mods: value.data, total: value.meta.total, last: value.meta.last_page };
}
async function filesFor(source, mod) {
  if (source.provider === "nexus") {
    return (await request(`https://api.nexusmods.com/v1/games/${source.providerSlug}/mods/${mod.modId}/files.json`, true)).files.filter((f) => ![6, 7].includes(f.category_id));
  }
  const files = [];
  for (let p = 1; ; p++) {
    const result = await request(`https://api.modworkshop.net/mods/${mod.id}/files?limit=50&page=${p}`);
    files.push(...result.data);
    if (p >= result.meta.last_page) break;
  }
  return files;
}
function legacy(text) { return /\bue4(?:[. _-]?27)?\b|unreal\s*engine\s*4/i.test(text); }
function ue5(text) { return /\bue5(?:[. _-]?5)?\b|unreal\s*engine\s*5/i.test(text); }
function compactMod(source, mod) {
  return source.provider === "modworkshop" ? {
    id: mod.id, game_id: mod.game_id, name: mod.name, custom_version: mod.custom_version,
    user: { name: mod.user?.name, unique_name: mod.user?.unique_name }, thumbnail: mod.thumbnail,
    tags: mod.tags?.map((t) => ({ id: t.id, name: t.name })), tag_ids: mod.tag_ids,
    downloads: mod.downloads, likes: mod.likes, short_desc: mod.short_desc, updated_at: mod.updated_at,
    files_are_versions: mod.files_are_versions,
  } : mod;
}
async function compatible(source, mod) {
  if (source.providerSlug !== "payday3" && source.providerSlug !== "payday-3") return true;
  if (source.provider === "modworkshop") return !mod.tag_ids?.includes(97) && !mod.tags?.some((t) => t.id === 97);
  const detail = await request(`https://api.nexusmods.com/v1/games/payday3/mods/${mod.modId}.json`, true);
  return ue5(`${detail.name} ${detail.summary} ${detail.description}`);
}
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
function removeScratch(folder) {
  const target = path.resolve(folder);
  if (!target.startsWith(`${scratch}${path.sep}`) || target === scratch) throw new Error("Unsafe scratch cleanup path");
  fs.rmSync(target, { recursive: true, force: true });
}
async function hashDownload(source, mod, file) {
  fs.mkdirSync(scratch, { recursive: true });
  const volume = fs.statfsSync(scratch);
  const free = volume.bavail * volume.bsize;
  const size = Number(file.size_in_bytes || file.size || 0);
  if (free < Math.max(size * 4, 2 * 1024 ** 3)) throw new Error("Insufficient scratch disk space (2 GB reserve)");
  const folder = path.join(scratch, randomUUID());
  fs.mkdirSync(folder);
  let idleTimer;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Download exceeded 20-minute deadline")), 20 * 60 * 1000);
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error("Download stalled for 60 seconds")), 60000);
  };
  try {
    let url = file.download_url;
    if (source.provider === "nexus") {
      const links = await request(`https://api.nexusmods.com/v1/games/${source.providerSlug}/mods/${mod.modId}/files/${file.file_id}/download_link.json`, true);
      url = links[0]?.URI;
    }
    if (!url) throw new Error("Provider supplied no direct download (external/manual-only)");
    armIdleTimer();
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
    if (/text\/html|application\/json/i.test(response.headers.get("content-type") || "")) throw new Error("Download returned a webpage or API error instead of a file");
    const name = path.basename(file.file_name || file.file || file.name || "download.bin").replace(/[<>:"|?*]/g, "_");
    const archive = path.join(folder, name);
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) { armIdleTimer(); done(null, chunk); } }), fs.createWriteStream(archive, { flags: "wx" }), { signal: controller.signal });
    clearTimeout(idleTimer); clearTimeout(deadline);
    const archiveHash = await hash(archive);
    const rows = [];
    if (/\.(zip|7z|rar|sdkmod|smpcmod|smmod|sm2pcmod)$/i.test(name)) {
      const listing = spawnSync(sevenZip, ["l", "-slt", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 ** 2 });
      if (listing.status !== 0) throw new Error("Cannot inspect archive with 7-Zip");
      const entries = listing.stdout.split("----------").slice(1).join("----------").split(/\r?\n\r?\n/).map((block) => Object.fromEntries(block.split(/\r?\n/).filter((l) => l.includes(" = ")).map((l) => { const i = l.indexOf(" = "); return [l.slice(0, i), l.slice(i + 3)]; })));
      if (entries.some((e) => e.Path && (path.isAbsolute(e.Path) || e.Path.split(/[\\/]/).some((part) => /[:<>|?*]/.test(part) || /^\.{1,2}[ .]*$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || e["Symbolic Link"] || e["Hard Link"] || /L/.test(e.Attributes || "")))) throw new Error("Archive contains unsafe paths or links");
      const expanded = entries.reduce((n, e) => n + Number(e.Size || 0), 0);
      if (expanded + fs.statSync(archive).size + 2 * 1024 ** 3 > free) throw new Error("Archive expansion exceeds free space reserve");
      const output = path.join(folder, "contents");
      const extraction = spawnSync(sevenZip, ["x", "-y", "-bd", `-o${output}`, archive], { encoding: "utf8", windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 1024 ** 2 });
      if (extraction.status !== 0) throw new Error("Archive extraction failed");
      async function visit(dir) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, item.name);
          if (item.isSymbolicLink()) throw new Error("Extracted link rejected");
          if (item.isDirectory()) await visit(full);
          else if (item.isFile()) rows.push({ fileName: path.relative(output, full).replaceAll("\\", "/"), fileSize: fs.statSync(full).size, sha256: await hash(full) });
        }
      }
      await visit(output);
    } else rows.push({ fileName: name, fileSize: fs.statSync(archive).size, sha256: archiveHash });
    return { archiveSha256: archiveHash, fileEntries: rows };
  } finally { clearTimeout(idleTimer); clearTimeout(deadline); removeScratch(folder); }
}

let failures = 0;
for (const profile of profiles) {
  const root = path.join(app, "profile-data", profile.profileId, "source-index");
  const catalogPath = path.join(root, "source-index.json");
  const statePath = path.join(root, "bulk-index-progress.json");
  const hashesPath = path.join(root, "file-hashes.json");
  const journalPath = path.join(root, "archive-results.ndjson");
  const catalog = read(catalogPath, { version: 1, records: {} });
  const state = read(statePath, { version: 1, sources: {} });
  const hashes = read(hashesPath, { version: 1, archives: {} });
  if (fs.existsSync(journalPath)) {
    for (const line of fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean)) {
      try { const row = JSON.parse(line); hashes.archives[row.key] = row.archive; } catch { /* A crash may leave one incomplete final line. */ }
    }
  }
  let archiveCheckpointCount = 0;
  if (!metadataOnly) {
    for (const archive of Object.values(hashes.archives)) {
      if (!canRetryArchive(archive)) continue;
      archive.status = "retry-later";
      for (const source of profile.sourceConfig.sources) {
        if (source.provider !== archive.source || source.providerSlug !== archive.game) continue;
        const mod = state.sources[source.id]?.mods[archive.modId];
        if (mod) { delete mod.indexed; delete mod.error; }
      }
    }
  }
  if (fs.existsSync(catalogPath) && !fs.existsSync(`${catalogPath}.before-bulk-index.bak`)) fs.copyFileSync(catalogPath, `${catalogPath}.before-bulk-index.bak`);
  for (const source of profile.sourceConfig.sources.filter((s) => s.enabled && s.browseMode === "api")) {
    const status = state.sources[source.id] ||= { nextPage: 1, mods: {}, complete: false };
    try {
      while (!status.complete) {
        const result = await page(source, status.nextPage);
        let added = 0;
        for (const mod of result.mods) {
          if (source.provider === "modworkshop" && String(mod.game_id) !== String(source.providerGameId)) throw new Error("Wrong-game provider response rejected");
          if (source.provider === "nexus" && String(mod.gameId) !== String(source.providerGameId)) throw new Error("Wrong-game provider response rejected");
          const id = String(mod.modId || mod.id);
          if (!status.mods[id]) added++;
          status.mods[id] = compactMod(source, mod);
        }
        status.total = result.total;
        status.complete = status.nextPage >= result.last;
        if (!status.complete && !added) throw new Error("Pagination repeated records; incomplete index retained");
        status.nextPage++;
        write(statePath, state);
        console.log(`${profile.displayName} / ${source.provider}: catalog ${Object.keys(status.mods).length}/${status.total}`);
      }
      if (!metadataOnly || Object.keys(status.mods).length < status.total) {
        const leading = await page(source, 1);
        status.total = leading.total;
        for (const mod of leading.mods) {
          if (String(mod.gameId || mod.game_id) !== String(source.providerGameId)) throw new Error("Wrong-game provider response rejected");
          const id = String(mod.modId || mod.id);
          status.mods[id] ||= compactMod(source, mod);
        }
        if (Object.keys(status.mods).length < status.total) {
          status.complete = false; status.nextPage = 1;
          throw new Error("Catalog totals changed while paging; another pass is required");
        }
        write(statePath, state);
      }
      let checkpointCount = 0;
      for (const [id, mod] of Object.entries(status.mods)) {
        if (metadataOnly && mod.indexed) continue;
        const refreshEnginePolicy = profile.profileId === "builtin.payday3" && source.provider === "modworkshop" && mod.engineFilePolicy !== 2;
        if (mod.indexed && mod.indexed !== "metadata-only" && !retry && !refreshEnginePolicy) continue;
        try {
          delete mod.error;
          if (!await compatible(source, mod)) { mod.indexed = "excluded-ue4-or-unverified"; continue; }
          const key = `${source.provider}-${source.providerSlug}-${id}`;
          const item = catalog.records[key] ||= { source: source.provider, sourceId: id, indexedAtUnix: Math.floor(Date.now() / 1000), summary: summary(source.provider, source, mod, profile), fileNames: [], fileIds: [], archiveFingerprint: null };
          if (metadataOnly) { mod.indexed = "metadata-only"; continue; }
          let files = await filesFor(source, mod);
          if (profile.profileId === "builtin.payday3") {
            files = files.filter((f) => !legacy(`${f.name} ${f.file_name} ${f.desc || ""}`));
            // Versioned PAYDAY packages can retain UE4 binaries without file-level tags.
            if (source.provider === "modworkshop") {
              const ordered = files.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
              // Untagged historical files can be UE4 even after the mod page is updated to UE5.
              files = ordered.filter((file, index) => index === 0 || ue5(`${file.name} ${file.file} ${file.desc || ""}`));
              const allowedIds = new Set(files.map((file) => String(file.id)));
              for (const [archiveKey, archive] of Object.entries(hashes.archives)) {
                if (archiveKey.startsWith(`${key}-`) && !allowedIds.has(archive.fileId)) delete hashes.archives[archiveKey];
              }
              item.archiveFingerprint = files.map((file) => hashes.archives[`${key}-${file.id}`]?.archiveSha256).find(Boolean) || null;
              mod.engineFilePolicy = 2;
              mod.unverifiedFilesExcluded = ordered.length - files.length;
            }
            if (source.provider === "nexus") {
              const candidates = files;
              files = candidates.filter((f) => ue5(`${f.name} ${f.file_name} ${f.description || ""}`));
              mod.unverifiedFilesExcluded = candidates.length - files.length;
            }
          }
          item.fileNames = [...new Set(files.map((f) => f.file_name || f.name || f.file).filter(Boolean))];
          item.fileIds = files.map((f) => String(f.file_id || f.id));
          for (const file of files) {
            const fileId = String(file.file_id || file.id);
            const archiveKey = `${key}-${fileId}`;
            if (hashes.archives[archiveKey]?.status === "hashed" || (hashes.archives[archiveKey]?.status === "unavailable" && !retry)) continue;
            if (metadataOnly) continue;
            try {
              const result = await hashDownload(source, mod, file);
              hashes.archives[archiveKey] = { source: source.provider, game: source.providerSlug, modId: id, fileId, version: file.version || file.mod_version || null, fileName: file.file_name || file.name || file.file, status: "hashed", ...result };
              item.archiveFingerprint ||= result.archiveSha256;
              item.fileNames = [...new Set([...item.fileNames, ...result.fileEntries.map((entry) => entry.fileName)])];
              console.log(`${profile.displayName}: hashed ${source.provider} ${id}/${fileId} (${result.fileEntries.length} contents)`);
            } catch (error) {
              const attempts = (hashes.archives[archiveKey]?.attempts || 0) + 1;
              const transient = isTransientIndexError(error.message);
              hashes.archives[archiveKey] = { source: source.provider, game: source.providerSlug, modId: id, fileId,
                status: transient && attempts < 3 ? "retry-later" : "unavailable", attempts, error: error.message };
              failures++;
              console.log(`${profile.displayName}: unavailable ${source.provider} ${id}/${fileId}: ${error.message}`);
              if (/rate limit|disk space|free space/i.test(error.message)) throw error;
            } finally {
              fs.mkdirSync(root, { recursive: true });
              fs.appendFileSync(journalPath, `${JSON.stringify({ key: archiveKey, archive: hashes.archives[archiveKey] })}\n`);
              if (++archiveCheckpointCount % 100 === 0) { write(hashesPath, hashes); fs.truncateSync(journalPath, 0); write(catalogPath, catalog); }
            }
          }
          mod.indexed = metadataOnly ? "metadata-only" : files.some((file) => hashes.archives[`${key}-${String(file.file_id || file.id)}`]?.status === "retry-later") ? undefined : "processed";
        } catch (error) {
          mod.error = error.message;
          failures++;
          if (/rate limit|disk space|free space/i.test(error.message)) throw error;
        } finally {
          if (++checkpointCount % (metadataOnly ? 1000 : 100) === 0) { write(catalogPath, catalog); write(statePath, state); }
        }
      }
      status.archivesProcessed = !metadataOnly;
      status.error = null;
    } catch (error) {
      status.error = error.message;
      failures++;
      console.log(`${profile.displayName} / ${source.provider}: paused: ${error.message}`);
    } finally { write(hashesPath, hashes); if (fs.existsSync(journalPath)) fs.truncateSync(journalPath, 0); write(catalogPath, catalog); write(statePath, state); }
  }
  console.log(`${profile.displayName}: ${Object.keys(catalog.records).length} indexed mods; ${Object.values(hashes.archives).filter((a) => a.status === "hashed").length} hashed archives`);
}
console.log(`Index pass finished with ${failures} unavailable/error events. Cyberpunk bulk indexing excluded. Check per-profile bulk-index-progress.json and file-hashes.json.`);
process.exitCode = failures ? 2 : 0;
