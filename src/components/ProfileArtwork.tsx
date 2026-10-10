import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  normalizeProfileImageReference,
  type ProfileImageReference,
} from "../models/profileArtwork";

interface ProfileArtworkImportResult {
  imageReference: ProfileImageReference;
  sourcePath: string;
  sourceExists: boolean;
  managedPath: string;
  managedExists: boolean;
}

interface ProfileArtworkResolveResult {
  finalSrc: string;
  sourcePath: string;
  sourceExists: boolean;
  managedRoot: string;
  resolver: string;
  byteLength: number;
}

interface ResolvedProfileImage {
  src: string | null;
  reference: ProfileImageReference;
  resolver: string;
  diagnostic?: ProfileArtworkResolveResult;
}

interface ProfileArtworkProps {
  imageReference?: ProfileImageReference | null;
  legacySrc?: string | null;
  profileId?: string;
  alt: string;
  fit?: "cover" | "contain";
  focalX?: number;
  focalY?: number;
  scale?: number;
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
  imageStyle?: CSSProperties;
  fallback?: ReactNode;
  onReferenceUpdated?: (reference: ProfileImageReference) => void;
}

function summarizeSrc(value?: string | null) {
  if (!value) return "";
  if (value.startsWith("data:")) return `${value.slice(0, 42)}... (${value.length} chars)`;
  return value.length > 180 ? `${value.slice(0, 180)}...` : value;
}

function localAssetPath(value: string) {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, "$1");
  } catch {
    return value.replace(/^file:\/+/i, "");
  }
}

export function logProfileArtwork(stage: string, details: Record<string, unknown>) {
  console.debug(`[ProfileArtwork] ${stage}`, details);
}

export async function resolveProfileImageSrc(imageReference: ProfileImageReference, profileId?: string): Promise<ResolvedProfileImage> {
  const reference = normalizeProfileImageReference(imageReference);
  logProfileArtwork("loaded reference", { profileId, reference });

  if (reference.kind === "none" || !reference.value.trim()) {
    return { src: null, reference, resolver: "none" };
  }

  if (reference.kind === "bundled") {
    logProfileArtwork("final img src", { profileId, kind: reference.kind, finalSrc: summarizeSrc(reference.value), resolver: "bundled" });
    return { src: reference.value, reference, resolver: "bundled" };
  }

  if (reference.kind === "remote_url") {
    if (!profileId) {
      logProfileArtwork("remote url blocked without profile id", { reference });
      return { src: null, reference, resolver: "remote_url_blocked" };
    }

    const cached = await invoke<ProfileArtworkImportResult>("cache_profile_artwork_remote_url", {
      profileId,
      url: reference.value,
    });
    logProfileArtwork("remote cached", cached as unknown as Record<string, unknown>);
    if (cached.imageReference.kind === "remote_url") {
      throw new Error("Profile artwork could not be cached. Check the image URL and connection.");
    }
    return resolveProfileImageSrc(cached.imageReference, profileId);
  }

  if (reference.kind === "managed_local" || reference.kind === "cached_remote") {
    const assetSrc = convertFileSrc(localAssetPath(reference.value));
    if (profileId) {
      const resolved = await invoke<ProfileArtworkResolveResult>("resolve_profile_artwork_image_src", {
        profileId,
        path: localAssetPath(reference.value),
      });
      logProfileArtwork("backend resolve", { ...resolved, finalSrc: summarizeSrc(resolved.finalSrc), assetSrc: summarizeSrc(assetSrc) });
      return { src: resolved.finalSrc, reference, resolver: resolved.resolver, diagnostic: resolved };
    }
    logProfileArtwork("final img src", { profileId, kind: reference.kind, finalSrc: summarizeSrc(assetSrc), resolver: "tauri_asset" });
    return { src: assetSrc, reference, resolver: "tauri_asset" };
  }

  const resolved = await invoke<ProfileArtworkResolveResult>("resolve_profile_artwork_image_src", { reference });
  logProfileArtwork("backend resolve", resolved as unknown as Record<string, unknown>);
  logProfileArtwork("final img src", {
    profileId,
    kind: reference.kind,
    sourcePath: resolved.sourcePath,
    sourceExists: resolved.sourceExists,
    resolver: resolved.resolver,
    finalSrc: summarizeSrc(resolved.finalSrc),
  });
  return {
    src: resolved.finalSrc || null,
    reference,
    resolver: resolved.resolver,
    diagnostic: resolved,
  };
}

export function ProfileArtwork({
  imageReference,
  legacySrc,
  profileId,
  alt,
  fit = "cover",
  focalX = 50,
  focalY = 50,
  scale = 1,
  className = "",
  imgClassName = "",
  style,
  imageStyle,
  fallback,
  onReferenceUpdated,
}: ProfileArtworkProps) {
  const reference = useMemo(
    () => normalizeProfileImageReference(imageReference, legacySrc),
    [imageReference, legacySrc],
  );
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const onReferenceUpdatedRef = useRef(onReferenceUpdated);
  const referenceKey = `${reference.kind}:${reference.value}:${reference.updatedAt}`;

  useEffect(() => {
    onReferenceUpdatedRef.current = onReferenceUpdated;
  }, [onReferenceUpdated]);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    setLoading(true);

    resolveProfileImageSrc(reference, profileId)
      .then((resolved) => {
        if (cancelled) return;
        setSrc(resolved.src);
        setLoading(false);
        if (
          resolved.reference.kind !== reference.kind ||
          resolved.reference.value !== reference.value ||
          resolved.reference.updatedAt !== reference.updatedAt
        ) {
          onReferenceUpdatedRef.current?.(resolved.reference);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        setFailed(true);
        logProfileArtwork("resolve error", {
          profileId,
          reference,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [referenceKey, profileId]);

  const canRender = Boolean(src && !failed);
  const shellClassName = ["profile-artwork", canRender ? "ready" : failed ? "failed" : loading ? "loading" : "empty", className].filter(Boolean).join(" ");

  return (
    <div className={shellClassName} style={style}>
      {canRender ? (
        <img
          className={imgClassName}
          src={src ?? ""}
          alt={alt}
          decoding="async"
          style={{
            objectFit: fit,
            objectPosition: `${focalX}% ${focalY}%`,
            transform: `scale(${scale})`,
            ...imageStyle,
          }}
          onLoad={() => logProfileArtwork("img onLoad", { profileId, reference, finalSrc: summarizeSrc(src) })}
          onError={(event) => {
            setFailed(true);
            logProfileArtwork("img onError", {
              profileId,
              reference,
              finalSrc: summarizeSrc(src),
              browserError: event.currentTarget.currentSrc || event.currentTarget.src,
            });
          }}
        />
      ) : (
        fallback !== undefined ? fallback : <div className="profile-artwork-placeholder">No image selected</div>
      )}
    </div>
  );
}
