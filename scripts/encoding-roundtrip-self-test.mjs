import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_1252_REVERSE = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

const STRONG_EVIDENCE = ["\u00c3", "\u00c2", "\u00e2", "\ufffd"];
const STRONG_EVIDENCE_PAIRS = ["\u00f0\u0178", "\u00e3\u0192", "\u00e3\u201a"];

function hasMojibakeEvidence(text) {
  return STRONG_EVIDENCE.some((needle) => text.includes(needle))
    || STRONG_EVIDENCE_PAIRS.some((needle) => text.includes(needle))
    || /[\u0080-\u009f]/u.test(text);
}

function mojibakeScore(text) {
  let score = 0;
  for (const needle of STRONG_EVIDENCE) {
    let index = text.indexOf(needle);
    while (index !== -1) {
      score += needle === "\ufffd" ? 3 : 1;
      index = text.indexOf(needle, index + needle.length);
    }
  }
  for (const needle of STRONG_EVIDENCE_PAIRS) {
    let index = text.indexOf(needle);
    while (index !== -1) {
      score += 2;
      index = text.indexOf(needle, index + needle.length);
    }
  }
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x80 && codePoint <= 0x9f) score += 2;
  }
  return score;
}

function windows1252ByteFor(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return null;
  if (codePoint <= 0xff) return codePoint;
  return WINDOWS_1252_REVERSE.get(codePoint) ?? null;
}

function startsMojibakeRun(chars, index) {
  const current = chars[index];
  const next = chars[index + 1] ?? "";
  if (current === "\u00c3" || current === "\u00c2" || current === "\u00e2" || current === "\ufffd") return true;
  if (current === "\u00f0" && next === "\u0178") return true;
  if (current === "\u00e3" && (next === "\u0192" || next === "\u201a")) return true;
  const codePoint = current.codePointAt(0) ?? 0;
  return codePoint >= 0x80 && codePoint <= 0x9f;
}

function decodeBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

function bestRepairAt(chars, start) {
  const bytes = [];
  let best = null;
  const maxLength = Math.min(chars.length - start, 96);

  for (let length = 1; length <= maxLength; length += 1) {
    const byte = windows1252ByteFor(chars[start + length - 1]);
    if (byte === null) break;
    bytes.push(byte);
    if (length < 2) continue;

    const candidate = chars.slice(start, start + length).join("");
    if (!hasMojibakeEvidence(candidate)) continue;

    const decoded = decodeBytes(bytes);
    if (!decoded || decoded === candidate || decoded.includes("\ufffd")) continue;

    const improvement = mojibakeScore(candidate) - mojibakeScore(decoded);
    if (improvement <= 0) continue;
    if (!best || improvement > best.improvement || (improvement === best.improvement && length > best.consumed)) {
      best = { consumed: length, text: decoded, improvement };
    }
  }

  return best;
}

function repairMojibakePass(input) {
  const chars = Array.from(input);
  let output = "";
  let index = 0;

  while (index < chars.length) {
    if (startsMojibakeRun(chars, index)) {
      const repair = bestRepairAt(chars, index);
      if (repair) {
        output += repair.text;
        index += repair.consumed;
        continue;
      }
    }
    output += chars[index];
    index += 1;
  }

  return output;
}

function repairMojibakeText(input) {
  if (!hasMojibakeEvidence(input)) return input;
  let current = input;
  let currentScore = mojibakeScore(current);
  for (let pass = 0; pass < 3 && currentScore > 0; pass += 1) {
    const next = repairMojibakePass(current);
    if (next === current) break;
    const nextScore = mojibakeScore(next);
    if (nextScore > currentScore) break;
    current = next;
    currentScore = nextScore;
  }
  return current;
}

function repairValue(value, depth = 0) {
  if (depth > 40) return value;
  if (typeof value === "string") return repairMojibakeText(value);
  if (Array.isArray(value)) return value.map((item) => repairValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairValue(item, depth + 1)]));
}

function walkFiles(root, output = []) {
  if (!fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules", "target", "migration-backups"].includes(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, output);
    } else if (/\.(css|html|js|json|mjs|rs|ts|tsx)$/i.test(entry.name)) {
      output.push(fullPath);
    }
  }
  return output;
}

assert.equal(repairMojibakeText("Tsuki\u00e2\u20ac\u2122s"), "Tsuki\u2019s");
assert.equal(repairMojibakeText("PAYDAY 2 \u00e2\u20ac\u201c Mods"), "PAYDAY 2 \u2013 Mods");
assert.equal(repairMojibakeText("Pok\u00c3\u00a9mon"), "Pok\u00e9mon");
assert.equal(repairMojibakeText("Pok\u00c3\u0192\u00c2\u00a9mon"), "Pok\u00e9mon");
assert.equal(repairMojibakeText("\u00e3\u0192\u201e\u00e3\u201a\u00ad"), "\u30c4\u30ad");
assert.equal(repairMojibakeText("\u00f0\u0178\u2018\u0081"), "\u{1f441}");
assert.equal(repairMojibakeText("Caf\u00e9 \u00e2\u20ac\u201c test"), "Caf\u00e9 \u2013 test");

const healthy = "\ud55c\uad6d\uc5b4 \u30c4\u30ad \u{1f600} Fish &amp; Chips \u00c2ngela";
assert.equal(repairMojibakeText(healthy), healthy);
assert.deepEqual(repairValue({ title: "Tsuki\u00e2\u20ac\u2122s", tags: ["\u30c4\u30ad", "Audio"] }), { title: "Tsuki\u2019s", tags: ["\u30c4\u30ad", "Audio"] });

const roots = ["src", path.join("src-tauri", "src"), "scripts", "package.json"];
const signatures = ["\u00c3", "\u00c2", "\u00e2", "\ufffd"];
const offenders = [];
for (const root of roots) {
  const stat = fs.existsSync(root) ? fs.statSync(root) : null;
  const files = stat?.isDirectory() ? walkFiles(root) : stat?.isFile() ? [root] : [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const signature of signatures) {
      if (text.includes(signature)) offenders.push(`${file}: contains U+${signature.codePointAt(0).toString(16).padStart(4, "0")}`);
    }
  }
}
assert.deepEqual(offenders, []);

console.log("Encoding self-test passed.");