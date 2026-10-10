import assert from "node:assert/strict";
import fs from "node:fs";

function parseGitHubSourceUrl(value) {
  const raw = value.trim();
  if (!raw) return null;
  const clean = /^https?:\/\//i.test(raw) ? raw : raw.replace(/^(?:www\.)?github\.com\//i, "https://github.com/");
  try {
    const url = new URL(clean);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const tagIndex = parts.findIndex((part, index) => part.toLowerCase() === "tag" && index > 0);
    return {
      owner: parts[0],
      repository: parts[1].replace(/\.git$/i, ""),
      fixedTag: tagIndex >= 0 && parts[tagIndex + 1] ? decodeURIComponent(parts[tagIndex + 1]) : "",
      releaseChannel: tagIndex >= 0 ? "Specific tag" : "Latest stable",
    };
  } catch {
    return null;
  }
}

function normalizeNexusDomainInput(value) {
  const raw = value.trim();
  if (!raw) return { domain: "", converted: false };
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (/nexusmods\.com$/i.test(url.hostname) || /(^|\.)nexusmods\.com$/i.test(url.hostname)) {
      const domain = url.pathname.split("/").filter(Boolean)[0] ?? "";
      return { domain: domain.toLowerCase().replace(/[^a-z0-9._-]+/gi, "-"), converted: Boolean(domain) && domain !== raw };
    }
  } catch {}
  const withoutHost = raw.replace(/^www\.nexusmods\.com[\\/]/i, "").replace(/^nexusmods\.com[\\/]/i, "");
  const clean = withoutHost.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean)[0] ?? withoutHost;
  return { domain: clean.toLowerCase().replace(/[^a-z0-9._-]+/gi, "-"), converted: clean !== raw };
}

function patternList(value) {
  return value.split(/[|,;\n\r]/).map((part) => part.trim().replace(/^\*+|\*+$/g, "").toLowerCase()).filter(Boolean);
}

function assetAllowed(name, allowedExtensions, includePatterns, excludePatterns) {
  const lower = name.toLowerCase();
  if (excludePatterns.some((pattern) => lower.includes(pattern))) return false;
  if (allowedExtensions.length && !allowedExtensions.some((extension) => lower.endsWith(extension))) return false;
  return includePatterns.length === 0 || includePatterns.some((pattern) => lower.includes(pattern));
}

const repo = parseGitHubSourceUrl("https://github.com/owner/repository/releases/latest");
assert.deepEqual(repo, { owner: "owner", repository: "repository", fixedTag: "", releaseChannel: "Latest stable" });

const tagged = parseGitHubSourceUrl("https://github.com/owner/repository/releases/tag/v1.4.2");
assert.equal(tagged?.owner, "owner");
assert.equal(tagged?.repository, "repository");
assert.equal(tagged?.fixedTag, "v1.4.2");
assert.equal(tagged?.releaseChannel, "Specific tag");

assert.equal(normalizeNexusDomainInput("https://www.nexusmods.com/payday2/mods/123").domain, "payday2");
assert.equal(normalizeNexusDomainInput("payday2").domain, "payday2");

const allowed = patternList(".zip|.7z|.rar|.dll");
const excluded = patternList("Source code (zip)|Source code (tar.gz)|source-code|source_code");
assert.equal(assetAllowed("mod-release.zip", allowed, [], excluded), true);
assert.equal(assetAllowed("mod-loader.dll", allowed, [], excluded), true);
assert.equal(assetAllowed("Source code (zip).zip", allowed, [], excluded), false);
assert.equal(assetAllowed("source-code.zip", allowed, [], excluded), false);

const backend = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
assert(!backend.includes("authentication may be required"), "Old 401/403 success wording must not return");
const sourceTestStart = backend.indexOf("fn test_profile_source_config");
const sourceTestEnd = backend.indexOf("\nfn mod_profiles_dir_for_game_profile", sourceTestStart);
assert(sourceTestStart >= 0 && sourceTestEnd > sourceTestStart, "Profile source test function could not be isolated");
const sourceTestBody = backend.slice(sourceTestStart, sourceTestEnd);
assert(!/http_get_|reqwest|\.send\s*\(/.test(sourceTestBody), "Profile source validation must remain local and must not probe website pages");
assert(backend.includes("https://api.nexusmods.com/v1/users/validate.json"), "Nexus auth test endpoint missing");
assert(backend.includes("https://api.github.com/repos/{}/{}"), "GitHub public repo API test missing");

const exportedProfile = JSON.stringify({ sections: { sources: [{ title: "Nexus Mods", fields: [{ label: "Nexus Domain", value: "payday2" }] }] } });
assert(!/api[_-]?key|apikey|token|secret/i.test(exportedProfile), "Profile source export mock must not contain credentials");

console.log("source-auth self-test passed");
