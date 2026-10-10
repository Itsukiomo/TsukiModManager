import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface LazyThumbnailProps {
  src?: string | null;
  alt?: string;
  fallback: ReactNode;
  className?: string;
  disabled?: boolean;
  onError?: () => void;
}

export function LazyThumbnail({
  src,
  alt = "",
  fallback,
  className = "",
  disabled = false,
  onError,
}: LazyThumbnailProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || visible) return;

    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting || entry.intersectionRatio > 0) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setResolvedSrc(null);
    const value = src?.trim();
    if (!value) return;
    if (/^(https?:|data:|blob:)/i.test(value)) {
      setResolvedSrc(value);
      return;
    }
    invoke<string>("load_managed_thumbnail_data_url", { path: value })
      .then((dataUrl) => {
        if (!cancelled) setResolvedSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setResolvedSrc(convertFileSrc(value));
      });
    return () => { cancelled = true; };
  }, [src]);

  const canLoad = Boolean(resolvedSrc && visible && !disabled && !failed);

  return (
    <div ref={rootRef} className={`lazy-thumbnail-shell ${className}`.trim()}>
      {canLoad ? (
        <img
          src={resolvedSrc ?? ""}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => {
            setFailed(true);
            onError?.();
          }}
        />
      ) : fallback}
    </div>
  );
}
