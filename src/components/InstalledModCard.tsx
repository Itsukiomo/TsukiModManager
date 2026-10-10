import type { ReactNode } from "react";
import { ModCard } from "./ModCard";

export interface InstalledModCardProps {
  title: string;
  source: string;
  sourceLabel: string;
  author?: string | null;
  version?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  tags?: string[];
  updatedLabel?: string | null;
  enabled?: boolean | null;
  stateLabel?: string | null;
  showStateBadge?: boolean;
  selected?: boolean;
  loadingLabel?: string | null;
  imageFallback?: ReactNode;
  selectionControl?: ReactNode;
  action?: ReactNode;
  moreActions?: ReactNode;
  canUseThumbnail?: (url: string | null | undefined) => boolean;
  onThumbnailFailed?: (url: string | null | undefined) => void;
  onOpen?: () => void;
  className?: string;
}

function installedCardClassName(className: string) {
  const tokens = className
    .split(/\s+/)
    .filter(Boolean)
    // Old Installed-only rules made these cards behave like horizontal/list cards.
    .filter((token) => token !== "installed-library-card" && token !== "local-unpaired-card");

  if (!tokens.includes("installed-card-shell")) tokens.push("installed-card-shell");
  return tokens.join(" ");
}

export function InstalledModCard({
  title,
  source,
  sourceLabel,
  author,
  version,
  thumbnailUrl,
  bannerUrl,
  tags = [],
  updatedLabel,
  enabled = null,
  stateLabel = null,
  showStateBadge = true,
  selected = false,
  loadingLabel = null,
  imageFallback,
  selectionControl,
  action,
  moreActions,
  canUseThumbnail,
  onThumbnailFailed,
  onOpen,
  className = "",
}: InstalledModCardProps) {
  return (
    <ModCard
      title={title}
      source={source}
      sourceLabel={sourceLabel}
      author={author}
      version={version}
      thumbnailUrl={thumbnailUrl}
      bannerUrl={bannerUrl}
      tags={tags}
      updatedLabel={updatedLabel}
      installed
      enabled={enabled}
      stateLabel={stateLabel}
      showStateBadge={showStateBadge}
      selected={selected}
      loadingLabel={loadingLabel}
      imageFallback={imageFallback}
      selectionControl={selectionControl}
      inlineActions={action}
      moreActions={moreActions}
      canUseThumbnail={canUseThumbnail}
      onThumbnailFailed={onThumbnailFailed}
      onOpen={onOpen}
      className={installedCardClassName(className)}
      installedDebugMarker
    />
  );
}
