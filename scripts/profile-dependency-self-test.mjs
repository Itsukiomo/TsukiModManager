const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function parseNexus(value) {
  const match = value.trim().match(/^https?:\/\/(?:www\.)?nexusmods\.com\/([^/?#]+)\/mods\/(\d+)/i);
  return match ? { sourceType: "nexus", gameDomain: match[1], modId: match[2] } : null;
}

function parseModWorkshop(value) {
  const clean = value.trim();
  if (!/^https?:\/\/(?:www\.)?modworkshop\.net\//i.test(clean)) return null;
  return {
    sourceType: "modworkshop",
    gameSlug: clean.match(/\/g\/([^/?#]+)/i)?.[1] ?? "",
    modId: clean.match(/\/(?:mod|mods)\/(\d+)/i)?.[1] ?? clean.match(/[?&](?:mod|mod_id|id)=(\d+)/i)?.[1] ?? "",
  };
}

function parseGithub(value) {
  const match = value.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)(?:\/releases(?:\/tag\/([^/?#]+))?)?/i);
  return match ? { sourceType: "github", owner: match[1], repo: match[2].replace(/\.git$/i, ""), channel: match[3] ? "Specific release" : "Latest stable" } : null;
}

function graphPlan(items) {
  const byName = new Map(items.map((item) => [item.name, item]));
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  const cycles = [];
  const visit = (name, path = []) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      cycles.push([...path, name].join(" -> "));
      return;
    }
    const item = byName.get(name);
    if (!item) return;
    visiting.add(name);
    for (const parent of item.requires ?? []) visit(parent, [...path, name]);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };
  for (const item of items) visit(item.name);
  return { order, cycles };
}

function chooseGithubAsset(assets, include = /\.(zip|7z|rar|dll)$/i, exclude = /source[ -]?code|src/i) {
  return assets.find((asset) => include.test(asset) && !exclude.test(asset));
}

const nexus = parseNexus("https://www.nexusmods.com/cyberpunk2077/mods/2380");
assert(nexus?.gameDomain === "cyberpunk2077" && nexus.modId === "2380", "Nexus URL parsing failed");

const modworkshop = parseModWorkshop("https://modworkshop.net/g/payday-3/mods/12345");
assert(modworkshop?.gameSlug === "payday-3" && modworkshop.modId === "12345", "ModWorkshop URL parsing failed");

const github = parseGithub("https://github.com/WopsS/RED4ext/releases/tag/v1.27.0");
assert(github?.owner === "WopsS" && github.repo === "RED4ext" && github.channel === "Specific release", "GitHub URL parsing failed");

const graph = graphPlan([{ name: "ArchiveXL", requires: ["RED4ext"] }, { name: "RED4ext" }]);
assert(graph.order.join(",") === "RED4ext,ArchiveXL", "Dependency graph order failed");

const cycle = graphPlan([{ name: "A", requires: ["B"] }, { name: "B", requires: ["A"] }]);
assert(cycle.cycles.length === 1, "Dependency cycle detection failed");

const asset = chooseGithubAsset(["Source code (zip)", "Source code (tar.gz)", "red4ext_1.27.0.zip"]);
assert(asset === "red4ext_1.27.0.zip", "GitHub source-code archive exclusion failed");

console.log("Dependency parser, resolver, and graph self-tests passed.");