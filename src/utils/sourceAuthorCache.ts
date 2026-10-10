import type { SourceModDetail, SourceModSummary } from "../models/source";

const SOURCE_AUTHOR_CACHE_KEY = "tsuki-source-author-cache:v2.0.1";

export interface SourceAuthorCacheRecord {
  displayName?: string | null;
  username?: string | null;
  userId?: string | null;
  profileUrl?: string | null;
  avatarUrl?: string | null;
}

type SourceAuthorLike = Pick<
  SourceModSummary | SourceModDetail,
  "source" | "sourceId" | "name" | "author" | "authorUsername" | "authorUserId" | "authorProfileUrl" | "authorAvatarUrl"
>;

function normalizeAuthorValue(value?: string | null, source?: string | null) {
  const text = String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  if (/^(unknown|unknown author|anonymous|n\/a|none|null|undefined)$/i.test(text)) return null;
  if (source?.toLowerCase() === "modworkshop" && /^[#@]?\d+$/.test(text)) return null;
  return text;
}

function inferAuthorFromModName(name?: string | null) {
  const value = String(name ?? "").replace(/&#x2F;/gi, "/").replace(/&amp;/gi, "&").trim();
  const patterns = [
    /\s+by\s+([^()\[\]{}|/\\<>]+)$/i,
    /\s+by\s+([^()\[\]{}|/\\<>]+)\s*(?:\(|\[|{|$)/i,
  ];

  for (const pattern of patterns) {
    const author = normalizeAuthorValue(value.match(pattern)?.[1], "modworkshop");
    if (author && author.length <= 48) return author;
  }

  return null;
}

export function sourceAuthorKey(source: string, sourceId: string) {
  return `${source.toLowerCase()}-${sourceId}`;
}

function sourceAuthorUserKey(source: string, userId: string) {
  return `${source.toLowerCase()}-user-${userId}`;
}

function normalizeRecord(value: unknown, source?: string | null): SourceAuthorCacheRecord | null {
  if (typeof value === "string") {
    const displayName = normalizeAuthorValue(value, source);
    return displayName ? { displayName } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const displayName = normalizeAuthorValue(
    typeof record.displayName === "string" ? record.displayName : typeof record.author === "string" ? record.author : null,
    source,
  );
  const username = normalizeAuthorValue(
    typeof record.username === "string" ? record.username : typeof record.authorUsername === "string" ? record.authorUsername : null,
    source,
  );
  const userId = normalizeAuthorValue(
    typeof record.userId === "string" ? record.userId : typeof record.authorUserId === "string" ? record.authorUserId : null,
  );
  const profileUrl = normalizeAuthorValue(
    typeof record.profileUrl === "string" ? record.profileUrl : typeof record.authorProfileUrl === "string" ? record.authorProfileUrl : null,
  );
  const avatarUrl = normalizeAuthorValue(
    typeof record.avatarUrl === "string" ? record.avatarUrl : typeof record.authorAvatarUrl === "string" ? record.authorAvatarUrl : null,
  );

  if (!displayName && !username && !userId && !profileUrl && !avatarUrl) return null;
  return { displayName, username, userId, profileUrl, avatarUrl };
}

export function displaySourceAuthor(mod: SourceAuthorLike) {
  return normalizeAuthorValue(mod.author, mod.source)
    ?? normalizeAuthorValue(mod.authorUsername, mod.source)
    ?? inferAuthorFromModName(mod.name);
}

export function displaySourceTitle(mod: SourceAuthorLike) {
  const author = displaySourceAuthor(mod);
  if (!author) return mod.name;
  const escapedAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return mod.name.replace(new RegExp(`\\s+by\\s+${escapedAuthor}\\s*$`, "i"), "").trim() || mod.name;
}

export function readSourceAuthorCache(): Record<string, SourceAuthorCacheRecord> {
  if (typeof window === "undefined") return {};

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SOURCE_AUTHOR_CACHE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const result: Record<string, SourceAuthorCacheRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const record = normalizeRecord(value, key.split("-")[0]);
      if (record) result[key] = record;
    }
    return result;
  } catch {
    return {};
  }
}

function writeSourceAuthorCache(cache: Record<string, SourceAuthorCacheRecord>) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(SOURCE_AUTHOR_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Author cache is optional metadata.
  }
}

function mergeAuthorRecord(existing: SourceAuthorCacheRecord | undefined, incoming: SourceAuthorCacheRecord): SourceAuthorCacheRecord {
  return {
    displayName: incoming.displayName ?? existing?.displayName ?? null,
    username: incoming.username ?? existing?.username ?? null,
    userId: incoming.userId ?? existing?.userId ?? null,
    profileUrl: incoming.profileUrl ?? existing?.profileUrl ?? null,
    avatarUrl: incoming.avatarUrl ?? existing?.avatarUrl ?? null,
  };
}

export function rememberSourceAuthorMetadata(mod: SourceAuthorLike) {
  const displayName = displaySourceAuthor(mod);
  const record = normalizeRecord({
    displayName,
    username: mod.authorUsername,
    userId: mod.authorUserId,
    profileUrl: mod.authorProfileUrl,
    avatarUrl: mod.authorAvatarUrl,
  }, mod.source);
  if (!record) return;

  const cache = readSourceAuthorCache();
  const bySource = sourceAuthorKey(mod.source, mod.sourceId);
  cache[bySource] = mergeAuthorRecord(cache[bySource], record);

  if (record.userId) {
    const byUser = sourceAuthorUserKey(mod.source, record.userId);
    cache[byUser] = mergeAuthorRecord(cache[byUser], record);
  }

  writeSourceAuthorCache(cache);
}

export function applyKnownSourceAuthor<T extends SourceModSummary>(mod: T): T {
  const cache = readSourceAuthorCache();
  const sourceRecord = cache[sourceAuthorKey(mod.source, mod.sourceId)];
  const userRecord = mod.authorUserId ? cache[sourceAuthorUserKey(mod.source, mod.authorUserId)] : undefined;
  const cached = sourceRecord ?? userRecord;
  const directDisplayName = displaySourceAuthor(mod);
  const displayName = directDisplayName ?? cached?.displayName ?? cached?.username ?? null;

  const next = {
    ...mod,
    author: displayName ?? mod.author ?? null,
    authorUsername: mod.authorUsername ?? cached?.username ?? null,
    authorUserId: mod.authorUserId ?? cached?.userId ?? null,
    authorProfileUrl: mod.authorProfileUrl ?? cached?.profileUrl ?? null,
    authorAvatarUrl: mod.authorAvatarUrl ?? cached?.avatarUrl ?? null,
  };

  if (displayName || next.authorUsername || next.authorUserId || next.authorProfileUrl || next.authorAvatarUrl) {
    rememberSourceAuthorMetadata(next);
  }

  return next;
}
