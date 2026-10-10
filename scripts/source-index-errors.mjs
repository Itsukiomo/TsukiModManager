export function isTransientIndexError(message = "") {
  return /rate limit|timeout|timed out|deadline|stalled|abort|terminated|fetch failed|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket|network|catalog totals changed/i.test(message);
}

export function canRetryArchive(archive) {
  return archive?.status === "retry-later" || (archive?.status === "unavailable" && (archive.attempts || 0) < 3 && isTransientIndexError(archive.error));
}
