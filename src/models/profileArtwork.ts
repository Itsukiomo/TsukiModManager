export type ProfileImageKind = "bundled" | "managed_local" | "remote_url" | "cached_remote" | "none";

export interface ProfileImageReference {
  kind: ProfileImageKind;
  value: string;
  updatedAt: string;
}

export function profileArtworkTimestamp() {
  return new Date().toISOString();
}

export function noneProfileImageReference(): ProfileImageReference {
  return { kind: "none", value: "", updatedAt: profileArtworkTimestamp() };
}

function looksLikeLocalImagePath(value: string) {
  return /^file:\/\//i.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

export function profileImageReferenceFromValue(value?: string | null, kind: ProfileImageKind = "bundled"): ProfileImageReference {
  const clean = value?.trim() ?? "";
  if (!clean) return noneProfileImageReference();
  if (/^https?:\/\//i.test(clean)) return { kind: "remote_url", value: clean, updatedAt: profileArtworkTimestamp() };
  if (looksLikeLocalImagePath(clean)) return { kind: "managed_local", value: clean, updatedAt: profileArtworkTimestamp() };
  return { kind, value: clean, updatedAt: profileArtworkTimestamp() };
}

export function normalizeProfileImageReference(input: unknown, legacyValue?: string | null, fallbackKind: ProfileImageKind = "bundled"): ProfileImageReference {
  if (input && typeof input === "object") {
    const candidate = input as Partial<ProfileImageReference>;
    if (candidate.kind && typeof candidate.kind === "string" && typeof candidate.value === "string") {
      const kind = candidate.kind as ProfileImageKind;
      if (["bundled", "managed_local", "remote_url", "cached_remote", "none"].includes(kind)) {
        return {
          kind,
          value: candidate.value,
          updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt ? candidate.updatedAt : profileArtworkTimestamp(),
        };
      }
    }
  }

  return profileImageReferenceFromValue(legacyValue, fallbackKind);
}

export function profileImageHasValue(reference?: ProfileImageReference | null, legacyValue?: string | null) {
  const normalized = normalizeProfileImageReference(reference, legacyValue);
  return normalized.kind !== "none" && Boolean(normalized.value.trim());
}