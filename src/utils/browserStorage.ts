const CURRENT_CACHE_PREFIXES = [
  "tsuki-source-cache:v2.0.1-gallery-browse-cache:",
  "tsuki-source-cache:v0.44:installed:index",
  "tsuki-source-detail:v2.0.0-fast-detail-cache:",
  "tsuki-home-live-state:v2.0.0:",
  "tsuki-installed-pair-ledger:v1:",
];

const CACHE_PREFIXES = [
  "tsuki-source-cache:",
  "tsuki-source-detail:",
  "tsuki-home-live-state:",
  "tsuki-installed-pair-state:",
  "tsuki-installed-pair-ledger:",
  "tsuki-thumbnail-failures:",
];

function storageKeys(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key));
}

function isCacheKey(key: string) {
  return CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isCurrentCacheKey(key: string) {
  return CURRENT_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function clearTemporaryLocalStorageCaches(includeCurrent = true) {
  if (typeof window === "undefined") return 0;

  let removed = 0;
  try {
    for (const key of storageKeys(window.localStorage)) {
      if (!isCacheKey(key) || (!includeCurrent && isCurrentCacheKey(key))) continue;
      window.localStorage.removeItem(key);
      removed += 1;
    }
  } catch (error) {
    console.warn("Temporary cache cleanup was interrupted:", error);
  }
  return removed;
}

export function pruneLegacyLocalStorageCaches() {
  return clearTemporaryLocalStorageCaches(false);
}

export function safeLocalStorageSet(key: string, value: string) {
  if (typeof window === "undefined") return false;

  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") {
      console.warn(`Could not persist ${key}:`, error);
      return false;
    }
  }

  clearTemporaryLocalStorageCaches(true);
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`Could not persist ${key} after clearing temporary caches:`, error);
    return false;
  }
}

export function safeSessionStorageSet(key: string, value: string) {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`Could not persist session value ${key}:`, error);
    return false;
  }
}
