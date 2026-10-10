const THUMBNAIL_FAIL_CACHE_KEY = "tsuki-thumbnail-failures:v2";
const THUMBNAIL_RETRY_AFTER_MS = 1000 * 60 * 60 * 24;

export function readThumbnailFailures(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(THUMBNAIL_FAIL_CACHE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

export function writeThumbnailFailures(value: Record<string, number>) {
  try {
    window.localStorage.setItem(THUMBNAIL_FAIL_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Optional thumbnail cache.
  }
}

export function thumbnailRecentlyFailed(url: string | null | undefined, failures: Record<string, number>) {
  if (!url) return true;

  const failedAt = failures[url];
  if (!failedAt) return false;

  return Date.now() - failedAt < THUMBNAIL_RETRY_AFTER_MS;
}
