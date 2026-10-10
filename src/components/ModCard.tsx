import type { KeyboardEvent, ReactNode } from "react";
import { CardMoreMenu } from "./CardMoreMenu";
import { LazyThumbnail } from "./LazyThumbnail";
import { ModTagList } from "./ModTagList";
import { Download, RefreshCw, Check, Trash2 } from "lucide-react";
import "./ModCard.css";

export interface ModCardAction {
  title?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger" | "update" | "installed";
}

export interface ModCardProps {
  title: string;
  source: string;
  sourceLabel: string;
  author?: string | null;
  version?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  tags?: string[];
  likes?: number | null;
  downloads?: number | null;
  views?: number | null;
  updatedLabel?: string | null;
  installed?: boolean;
  enabled?: boolean | null;
  stateLabel?: string | null;
  showStateBadge?: boolean;
  selected?: boolean;
  loadingLabel?: string | null;
  imageFallback?: ReactNode;
  selectionControl?: ReactNode;
  inlineActions?: ReactNode;
  primaryAction?: ModCardAction;
  secondaryAction?: ModCardAction;
  moreActions?: ReactNode;
  canUseThumbnail?: (url: string | null | undefined) => boolean;
  onThumbnailFailed?: (url: string | null | undefined) => void;
  onOpen?: () => void;
  className?: string;
  installedDebugMarker?: boolean;
}

const HIDDEN_TAGS = new Set([
  "nexus",
  "nexus mods",
  "modworkshop",
  "mod workshop",
  "payday3",
  "payday 3",
]);

function normalizedTagKey(tag: string) {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function visibleTags(tags: string[] = []) {
  const seen = new Set<string>();
  const clean = [];

  for (const tag of tags) {
    const text = String(tag ?? "").trim();
    if (!text) continue;

    const key = normalizedTagKey(text);
    if (!key || seen.has(key) || HIDDEN_TAGS.has(key)) continue;

    seen.add(key);
    clean.push(text);
  }

  return clean;
}

function fallbackInitials(title: string) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "MOD";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
}

function compactNumber(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString();
}

function actionClassName(action?: ModCardAction, primary = false) {
  const variant = action?.variant ?? "default";
  return [
    primary ? "primary-button" : "ghost-button",
    "compact",
    "tsuki-mod-card-action",
    variant === "danger" ? "danger-button" : "",
    variant === "update" ? "update-button" : "",
    variant === "installed" ? "installed" : "",
  ].filter(Boolean).join(" ");
}

type ModStatIconName = "likes" | "downloads" | "views" | "updated" | "version";

function ModStatIcon({ name }: { name: ModStatIconName }) {
  const common = { vectorEffect: "non-scaling-stroke" as const };

  return (
    <svg className="tsuki-stat-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === "likes" && <path {...common} d="M12 20s-7-4.4-9.2-8.6C1 8 3 4.8 6.5 4.8c2 0 3.3 1 4.1 2.2.8-1.2 2.2-2.2 4.1-2.2 3.5 0 5.5 3.2 3.7 6.6C16.9 15.6 12 20 12 20Z" />}
      {name === "downloads" && <path {...common} d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14" />}
      {name === "views" && (
        <>
          <path {...common} d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle {...common} cx="12" cy="12" r="2.5" />
        </>
      )}
      {name === "updated" && (
        <>
          <path {...common} d="M7 3v3m10-3v3M4.5 9h15M6 5.5h12a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 18 19.5H6A1.5 1.5 0 0 1 4.5 18V7A1.5 1.5 0 0 1 6 5.5Z" />
          <path {...common} d="M9 14h6" />
        </>
      )}
      {name === "version" && <path {...common} d="m4 12 8-8 8 8-8 8-8-8Zm8-3v6" />}
    </svg>
  );
}

function ModStat({ title, icon, children }: { title: string; icon: ModStatIconName; children: ReactNode }) {
  return (
    <span className="tsuki-mod-card-stat" title={title} aria-label={`${title}: ${children}`}>
      <ModStatIcon name={icon} />
      <span>{children}</span>
    </span>
  );
}
export function ModCard({
  title,
  source,
  sourceLabel,
  author,
  version,
  thumbnailUrl,
  bannerUrl,
  tags = [],
  likes,
  downloads,
  views,
  updatedLabel,
  installed = false,
  enabled = null,
  stateLabel = null,
  showStateBadge = true,
  selected = false,
  loadingLabel = null,
  imageFallback,
  selectionControl,
  inlineActions,
  primaryAction,
  secondaryAction,
  moreActions,
  canUseThumbnail,
  onThumbnailFailed,
  onOpen,
  className = "",
  installedDebugMarker = false,
}: ModCardProps) {
  const imageUrl = thumbnailUrl || bannerUrl || null;
  const canLoadImage = canUseThumbnail ? canUseThumbnail(imageUrl) : Boolean(imageUrl);
  const filteredTags = visibleTags(tags);
  const likesText = compactNumber(likes);
  const downloadsText = compactNumber(downloads);
  const viewsText = compactNumber(views);
  const cardClassName = [
    "tsuki-mod-card",
    "image-led-card",
    `source-${source}`,
    installed ? "installed" : "",
    enabled === false ? "disabled" : "",
    selected ? "selected" : "",
    className,
  ].filter(Boolean).join(" ");
  const stateBadge = installed && showStateBadge ? (stateLabel ?? (enabled === false ? "Off" : "Installed")) : null;

  function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (!onOpen) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  }

  return (
    <article
      className={cardClassName}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={(event) => {
        if (!onOpen) return;
        if ((event.target as HTMLElement).closest("button, summary, details, input, select, a, label")) return;
        onOpen();
      }}
      onKeyDown={openFromKeyboard}
      data-installed-card={installedDebugMarker && import.meta.env.DEV ? "real" : undefined}
    >
      {selectionControl && <div className="tsuki-mod-card-select">{selectionControl}</div>}

      <button className="tsuki-mod-card-hero" type="button" onClick={onOpen} disabled={!onOpen}>
        <LazyThumbnail
          src={imageUrl}
          disabled={!canLoadImage}
          onError={() => onThumbnailFailed?.(imageUrl)}
          fallback={imageFallback ?? (
            <span className="tsuki-mod-card-fallback" aria-hidden="true">
              <strong>{fallbackInitials(title)}</strong>
              <small>{sourceLabel}</small>
            </span>
          )}
        />
        <span className="tsuki-mod-card-source">{sourceLabel}</span>
        {stateBadge && <span className="tsuki-mod-card-state">{stateBadge}</span>}
        {loadingLabel && <em className="tsuki-mod-card-loading">{loadingLabel}</em>}
      </button>

      <div className="tsuki-mod-card-body">
        <h3 title={title}>{title}</h3>
        <p className="tsuki-mod-card-author">{author ? `by ${author}` : "Unknown author"}</p>

        <ModTagList tags={filteredTags} limit={installed ? 2 : 3} />

        <div className="tsuki-mod-card-footer">
          <div className="tsuki-mod-card-stats" aria-label="Mod stats">
            {likesText && <ModStat title="Likes" icon="likes">{likesText}</ModStat>}
            {downloadsText && <ModStat title="Downloads" icon="downloads">{downloadsText}</ModStat>}
            {viewsText && <ModStat title="Views" icon="views">{viewsText}</ModStat>}
            {updatedLabel && <ModStat title="Updated" icon="updated">{updatedLabel.replace(/^Updated\s+/i, "")}</ModStat>}
            {version && <ModStat title="Version" icon="version">{version}</ModStat>}
          </div>

          <div className="tsuki-mod-card-actions">
            {inlineActions}
            {secondaryAction && (
              <button
                className={actionClassName(secondaryAction)}
                type="button"
                disabled={secondaryAction.disabled}
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </button>
            )}
            {primaryAction && (
              <button
                className={`${actionClassName(primaryAction, true)} tsuki-mod-card-primary`}
                type="button"
                disabled={primaryAction.disabled}
                title={primaryAction.title}
                onClick={primaryAction.onClick}
              >
                {primaryAction.variant === "danger" ? <Trash2 size={14} aria-hidden="true" /> : primaryAction.variant === "update" ? <RefreshCw size={14} aria-hidden="true" /> : primaryAction.variant === "installed" ? <Check size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                {primaryAction.label}
              </button>
            )}
            {moreActions && (
              <CardMoreMenu>
                <div>{moreActions}</div>
              </CardMoreMenu>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
