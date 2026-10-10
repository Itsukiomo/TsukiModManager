const STORAGE_MIGRATION_KEY = "tsuki-text-encoding-migration:v1";
const STORAGE_BACKUP_PREFIX = "tsuki-text-encoding-backup:v1:";

const WINDOWS_1252_REVERSE = new Map<number, number>([
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

export interface TextEncodingMigrationSummary {
  migratedAt: number;
  scanned: number;
  repaired: number;
  backups: number;
}

export function hasMojibakeEvidence(text: string): boolean {
  if (!text) return false;
  return STRONG_EVIDENCE.some((needle) => text.includes(needle))
    || STRONG_EVIDENCE_PAIRS.some((needle) => text.includes(needle))
    || /[\u0080-\u009f]/u.test(text);
}

function mojibakeScore(text: string): number {
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

function windows1252ByteFor(char: string): number | null {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return null;
  if (codePoint <= 0xff) return codePoint;
  return WINDOWS_1252_REVERSE.get(codePoint) ?? null;
}

function startsMojibakeRun(chars: string[], index: number): boolean {
  const current = chars[index];
  const next = chars[index + 1] ?? "";
  if (current === "\u00c3" || current === "\u00c2" || current === "\u00e2" || current === "\ufffd") return true;
  if (current === "\u00f0" && next === "\u0178") return true;
  if (current === "\u00e3" && (next === "\u0192" || next === "\u201a")) return true;
  const codePoint = current.codePointAt(0) ?? 0;
  return codePoint >= 0x80 && codePoint <= 0x9f;
}

function decodeBytes(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bestRepairAt(chars: string[], start: number): { consumed: number; text: string } | null {
  const bytes: number[] = [];
  let best: { consumed: number; text: string; improvement: number } | null = null;
  const maxLength = Math.min(chars.length - start, 96);

  for (let length = 1; length <= maxLength; length += 1) {
    const byte = windows1252ByteFor(chars[start + length - 1]);
    if (byte === null) break;
    bytes.push(byte);
    if (length < 2) continue;

    const candidate = chars.slice(start, start + length).join("");
    if (!hasMojibakeEvidence(candidate)) continue;

    const decoded = decodeBytes(Uint8Array.from(bytes));
    if (!decoded || decoded === candidate || decoded.includes("\ufffd")) continue;

    const improvement = mojibakeScore(candidate) - mojibakeScore(decoded);
    if (improvement <= 0) continue;
    if (!best || improvement > best.improvement || (improvement === best.improvement && length > best.consumed)) {
      best = { consumed: length, text: decoded, improvement };
    }
  }

  return best;
}

function repairMojibakePass(input: string): string {
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

export function repairMojibakeText(input: string): string {
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

export function repairMojibakeValue<T>(value: T, depth = 0): T {
  if (depth > 40) return value;
  if (typeof value === "string") return repairMojibakeText(value) as T;
  if (Array.isArray(value)) return value.map((item) => repairMojibakeValue(item, depth + 1)) as T;
  if (!value || typeof value !== "object") return value;

  const repaired: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    repaired[key] = repairMojibakeValue(item, depth + 1);
  }
  return repaired as T;
}

export function migrateLocalStorageTextEncoding(): TextEncodingMigrationSummary | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  if (window.localStorage.getItem(STORAGE_MIGRATION_KEY)) return null;

  let scanned = 0;
  let repaired = 0;
  let backups = 0;
  const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
    .filter((key): key is string => Boolean(key))
    .filter((key) => key.startsWith("tsuki-") && key !== STORAGE_MIGRATION_KEY && !key.startsWith(STORAGE_BACKUP_PREFIX));

  for (const key of keys) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    scanned += 1;
    if (!hasMojibakeEvidence(raw)) continue;

    let nextRaw = raw;
    try {
      nextRaw = JSON.stringify(repairMojibakeValue(JSON.parse(raw)));
    } catch {
      nextRaw = repairMojibakeText(raw);
    }

    if (nextRaw === raw) continue;

    const backupKey = `${STORAGE_BACKUP_PREFIX}${key}`;
    if (!window.localStorage.getItem(backupKey)) {
      window.localStorage.setItem(backupKey, raw);
      backups += 1;
    }
    window.localStorage.setItem(key, nextRaw);
    repaired += 1;
  }

  const summary: TextEncodingMigrationSummary = {
    migratedAt: Date.now(),
    scanned,
    repaired,
    backups,
  };
  window.localStorage.setItem(STORAGE_MIGRATION_KEY, JSON.stringify(summary));
  return summary;
}