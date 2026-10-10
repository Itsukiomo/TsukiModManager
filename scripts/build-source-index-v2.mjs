import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultIndexPath = path.join(repoRoot, "source-index-v2.json");
const indexPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultIndexPath;
const sha256Pattern = /^[a-f0-9]{64}$/i;

function fail(message) {
  throw new Error(message);
}

function requireField(object, field, label) {
  if (!Object.prototype.hasOwnProperty.call(object, field)) {
    fail(`${label} is missing required field "${field}".`);
  }
}

function stringOrNull(value) {
  return typeof value === "string" || value === null || value === undefined;
}

function validateRecords(records) {
  if (!records || (typeof records !== "object" && !Array.isArray(records))) {
    fail('Top-level "records" must be an object or array.');
  }

  const values = Array.isArray(records) ? records : Object.values(records);
  for (const [index, record] of values.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      fail(`records[${index}] must be an object.`);
    }

    for (const field of ["source", "game", "modId", "modName"]) {
      requireField(record, field, `records[${index}]`);
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        fail(`records[${index}].${field} must be a non-empty string.`);
      }
    }

    for (const field of ["author", "category", "version", "updatedAt", "publishedAt"]) {
      requireField(record, field, `records[${index}]`);
      if (!stringOrNull(record[field])) {
        fail(`records[${index}].${field} must be a string or null.`);
      }
    }
  }

  return values.length;
}

function validateFileEntries(fileEntries) {
  if (!Array.isArray(fileEntries)) {
    fail('Top-level "file_entries" must be an array.');
  }

  const seen = new Set();
  for (const [index, entry] of fileEntries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`file_entries[${index}] must be an object.`);
    }

    for (const field of ["source", "game", "modId", "fileName", "sha256"]) {
      requireField(entry, field, `file_entries[${index}]`);
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        fail(`file_entries[${index}].${field} must be a non-empty string.`);
      }
    }

    if (!sha256Pattern.test(entry.sha256)) {
      fail(`file_entries[${index}].sha256 must be a 64-character SHA256 hash.`);
    }

    if (!stringOrNull(entry.fileId)) {
      fail(`file_entries[${index}].fileId must be a string or null.`);
    }

    if (entry.fileSize !== null && entry.fileSize !== undefined) {
      if (!Number.isSafeInteger(entry.fileSize) || entry.fileSize < 0) {
        fail(`file_entries[${index}].fileSize must be a non-negative safe integer or null.`);
      }
    }

    for (const field of ["version", "archiveFingerprint", "updatedAt", "publishedAt"]) {
      requireField(entry, field, `file_entries[${index}]`);
      if (!stringOrNull(entry[field])) {
        fail(`file_entries[${index}].${field} must be a string or null.`);
      }
    }

    const duplicateKey = [
      entry.source,
      entry.game,
      entry.modId,
      entry.fileId ?? "",
      entry.sha256.toLowerCase(),
    ].join("|").toLowerCase();

    if (seen.has(duplicateKey)) {
      fail(`Duplicate file entry key: ${duplicateKey}`);
    }

    seen.add(duplicateKey);
  }

  return fileEntries.length;
}

async function main() {
  const raw = await readFile(indexPath, "utf8");
  const index = JSON.parse(raw);

  for (const field of ["indexVersion", "generatedAt", "records", "file_entries"]) {
    requireField(index, field, "source-index-v2.json");
  }

  if (typeof index.indexVersion !== "string" || index.indexVersion.trim() === "") {
    fail('Top-level "indexVersion" must be a non-empty string.');
  }

  if (typeof index.generatedAt !== "string" || index.generatedAt.trim() === "") {
    fail('Top-level "generatedAt" must be a non-empty string.');
  }

  const recordCount = validateRecords(index.records);
  const fileEntryCount = validateFileEntries(index.file_entries);

  console.log(`Source Index v2 OK: ${recordCount} records, ${fileEntryCount} file entries (${indexPath})`);
}

main().catch((error) => {
  console.error(`Source Index v2 validation failed: ${error.message}`);
  process.exitCode = 1;
});
