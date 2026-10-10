import assert from "node:assert/strict";
import { canRetryArchive, isTransientIndexError } from "./source-index-errors.mjs";

for (const error of ["terminated", "HTTP 503", "Download exceeded 20-minute deadline", "ECONNRESET", "Provider rate limit reached"]) {
  assert(isTransientIndexError(error), `${error} should be retryable`);
}
for (const error of ["HTTP 404", "Download HTTP 403", "Provider supplied no direct download (external/manual-only)", "Unsafe archive path"]) {
  assert(!isTransientIndexError(error), `${error} should not be automatically retried`);
}
assert(canRetryArchive({ status: "unavailable", attempts: 1, error: "terminated" }));
assert(!canRetryArchive({ status: "unavailable", attempts: 3, error: "terminated" }));
assert(!canRetryArchive({ status: "hashed" }));
assert(canRetryArchive({ status: "retry-later", attempts: 2, error: "HTTP 503" }));
console.log("Source index interrupted-download retry checks passed.");
