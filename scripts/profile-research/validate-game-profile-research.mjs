import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultManifestPath = path.join(scriptDirectory, "game-profile-research.json");
const manifestPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : defaultManifestPath;

const expectedProfileIds = new Set([
  "builtin.cyberpunk2077",
  "builtin.outlast-trials",
  "builtin.payday-the-heist",
  "builtin.payday2",
  "builtin.payday3",
  "builtin.resident-evil-7",
  "builtin.resident-evil-village",
  "builtin.resident-evil-requiem",
  "builtin.borderlands",
  "builtin.borderlands2",
  "builtin.borderlands3",
  "builtin.borderlands4",
  "builtin.tiny-tinas-wonderlands",
  "builtin.spider-man-remastered",
  "builtin.spider-man-2",
  "builtin.monster-hunter-wilds",
]);

const requiredVerifiedFields = [
  "platforms",
  "detection",
  "engine",
  "sources",
  "otherMajorSources",
  "knownLoaders",
  "knownFrameworks",
  "knownModManagers",
  "knownDependencyFrameworks",
  "modTypes",
  "installRoots",
  "enableDisable",
  "loadOrder",
  "archiveHandling",
  "updateUninstall",
  "validation",
  "evidence",
  "unverified",
];

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string.`);
  }
}

function collectSourceRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceRefs(item, refs);
    return refs;
  }

  if (!isObject(value)) return refs;
  for (const [key, child] of Object.entries(value)) {
    if (key === "sourceRefs") {
      if (!Array.isArray(child) || child.length === 0) {
        fail("Every sourceRefs field must be a non-empty array.");
      }
      for (const ref of child) {
        requireNonEmptyString(ref, "source reference");
        refs.push(ref);
      }
    } else if (key !== "evidence") {
      collectSourceRefs(child, refs);
    }
  }
  return refs;
}

function validateRelativeInstallPath(value, label, allowRoot = false) {
  if (allowRoot && value === ".") return;
  requireNonEmptyString(value, label);
  if (path.isAbsolute(value) || value.includes("..") || /^[a-z]:/i.test(value)) {
    fail(`${label} must stay relative to the detected game root.`);
  }
}

function validateVerifiedGame(game, label) {
  if (game.lastVerified !== "2026-09-04") {
    fail(`${label}.lastVerified must record the date of this research pass.`);
  }

  for (const field of requiredVerifiedFields) {
    if (!Object.prototype.hasOwnProperty.call(game, field)) {
      fail(`${label} is verified but missing ${field}.`);
    }
  }

  if (!Array.isArray(game.sources) || game.sources.length === 0) {
    fail(`${label}.sources must contain at least one verified source.`);
  }
  if (!Array.isArray(game.modTypes) || game.modTypes.length === 0) {
    fail(`${label}.modTypes must contain at least one supported type.`);
  }
  if (!Array.isArray(game.installRoots) || game.installRoots.length === 0) {
    fail(`${label}.installRoots must contain at least one root.`);
  }
  if (!Array.isArray(game.evidence) || game.evidence.length === 0) {
    fail(`${label}.evidence must not be empty.`);
  }

  const evidenceIds = new Set();
  for (const [index, evidence] of game.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${index}]`;
    if (!isObject(evidence)) fail(`${evidenceLabel} must be an object.`);
    requireNonEmptyString(evidence.id, `${evidenceLabel}.id`);
    requireNonEmptyString(evidence.type, `${evidenceLabel}.type`);
    requireNonEmptyString(evidence.description, `${evidenceLabel}.description`);
    if (evidenceIds.has(evidence.id)) fail(`${label} has duplicate evidence id ${evidence.id}.`);
    evidenceIds.add(evidence.id);

    if (evidence.url !== undefined) {
      requireNonEmptyString(evidence.url, `${evidenceLabel}.url`);
      let parsed;
      try {
        parsed = new URL(evidence.url);
      } catch {
        fail(`${evidenceLabel}.url must be an absolute URL.`);
      }
      if (parsed.protocol !== "https:") fail(`${evidenceLabel}.url must use HTTPS.`);
    } else {
      requireNonEmptyString(evidence.locator, `${evidenceLabel}.locator`);
    }
  }

  for (const ref of collectSourceRefs(game)) {
    if (!evidenceIds.has(ref)) fail(`${label} references missing evidence id ${ref}.`);
  }

  const dependencyIds = new Set();
  for (const dependency of [
    ...game.knownLoaders,
    ...game.knownFrameworks.filter(isObject),
    ...game.knownModManagers.filter(isObject),
  ]) {
    requireNonEmptyString(dependency.dependencyId, `${label} dependencyId`);
    if (dependencyIds.has(dependency.dependencyId)) {
      fail(`${label} has duplicate dependency id ${dependency.dependencyId}.`);
    }
    dependencyIds.add(dependency.dependencyId);
    validateRelativeInstallPath(dependency.installRoot, `${label}.${dependency.dependencyId}.installRoot`, true);
  }

  for (const [index, source] of game.sources.entries()) {
    const sourceLabel = `${label}.sources[${index}]`;
    requireNonEmptyString(source.provider, `${sourceLabel}.provider`);
    requireNonEmptyString(source.domain, `${sourceLabel}.domain`);
    requireNonEmptyString(source.numericGameId, `${sourceLabel}.numericGameId`);
    requireNonEmptyString(source.gameUrl, `${sourceLabel}.gameUrl`);
    if (!/^\d+$/.test(source.numericGameId)) {
      fail(`${sourceLabel}.numericGameId must stay separate from its domain or slug.`);
    }
  }

  for (const [index, root] of game.installRoots.entries()) {
    validateRelativeInstallPath(root.path, `${label}.installRoots[${index}].path`, true);
  }

  for (const [index, modType] of game.modTypes.entries()) {
    if (modType.installRoot !== null) {
      validateRelativeInstallPath(modType.installRoot, `${label}.modTypes[${index}].installRoot`, true);
    }
    const requirements = [...(modType.requiresAll ?? []), ...(modType.requiresAny ?? [])];
    for (const dependencyId of requirements) {
      if (!dependencyIds.has(dependencyId)) {
        fail(`${label}.modTypes[${index}] references unknown dependency ${dependencyId}.`);
      }
    }
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1.");
  if (!Array.isArray(manifest.games)) fail("games must be an array.");

  const seen = new Set();
  let verified = 0;
  for (const [index, game] of manifest.games.entries()) {
    const label = `games[${index}]`;
    if (!isObject(game)) fail(`${label} must be an object.`);
    requireNonEmptyString(game.profileId, `${label}.profileId`);
    requireNonEmptyString(game.displayName, `${label}.displayName`);
    if (!expectedProfileIds.has(game.profileId)) fail(`${label} has unexpected profileId ${game.profileId}.`);
    if (seen.has(game.profileId)) fail(`Duplicate profileId ${game.profileId}.`);
    seen.add(game.profileId);

    if (game.researchStatus === "verified") {
      verified += 1;
      validateVerifiedGame(game, label);
    } else if (game.researchStatus === "pending") {
      if (game.lastVerified !== null) fail(`${label}.lastVerified must be null while pending.`);
      requireNonEmptyString(game.pendingReason, `${label}.pendingReason`);
    } else {
      fail(`${label}.researchStatus must be verified or pending.`);
    }
  }

  if (seen.size !== expectedProfileIds.size || [...expectedProfileIds].some((id) => !seen.has(id))) {
    fail(`Manifest must contain all ${expectedProfileIds.size} built-in profiles exactly once.`);
  }
  if (!isObject(manifest.completion)) fail("completion must be an object.");
  if (manifest.completion.verified !== verified || manifest.completion.total !== manifest.games.length) {
    fail("completion counts do not match the game records.");
  }

  console.log(`Game profile research manifest OK: ${verified}/${manifest.games.length} profiles verified (${manifestPath})`);
}

main().catch((error) => {
  console.error(`Game profile research validation failed: ${error.message}`);
  process.exitCode = 1;
});
