import "./UnifiedModPage.css";
import { isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, WheelEvent } from "react";
import { sanitizeRichHtml } from "../utils/richHtmlSanitizer";
import { tagColorClass, tagColorStyle } from "../utils/tagRegistry";
export { sanitizeRichHtml } from "../utils/richHtmlSanitizer";

export interface UnifiedBadge {
  label: ReactNode;
  tone?: "good" | "warning" | "danger" | "neutral";
}

export interface UnifiedInfoItem {
  label: string;
  value?: ReactNode;
  detail?: ReactNode;
  tone?: "good" | "warning" | "danger" | "neutral";
}

export interface UnifiedAction {
  title?: string;
  key: string;
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "install" | "update" | "danger" | "neutral";
}

export interface UnifiedGalleryImage {
  id: string;
  title?: string | null;
  imageUrl: string;
  thumbnailUrl?: string | null;
}

export interface UnifiedFileRow {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  tone?: "good" | "warning" | "danger" | "neutral";
  actions?: ReactNode;
  progress?: ReactNode;
}

export interface UnifiedFileGroup {
  id: string;
  title: string;
  subtitle?: ReactNode;
  rows: UnifiedFileRow[];
  emptyLabel?: ReactNode;
}

export interface UnifiedTimelineItem {
  id: string;
  title: ReactNode;
  detail?: ReactNode;
  date?: ReactNode;
  status?: ReactNode;
  tone?: "good" | "warning" | "danger" | "neutral";
  actions?: ReactNode;
}

export interface UnifiedDependencyItem {
  id: string;
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  tone?: "good" | "warning" | "danger" | "neutral";
  actions?: ReactNode;
}

export interface UnifiedTab {
  id: string;
  label: string;
  badge?: ReactNode;
  content: ReactNode;
}

interface UnifiedModPageProps {
  className?: string;
  backLabel: string;
  onBack: () => void;
  source: string;
  sourceLabel: string;
  sourceAccent: string;
  sourceId?: string | null;
  title: string;
  summary?: ReactNode;
  description?: string | null;
  author?: string | null;
  version?: string | null;
  game?: string | null;
  category?: string | null;
  fileSize?: string | null;
  installDate?: string | null;
  lastUpdate?: string | null;
  installStatus?: ReactNode;
  verificationStatus?: ReactNode;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  pageUrl?: string | null;
  tags?: string[];
  badges?: UnifiedBadge[];
  actions?: UnifiedAction[];
  metadata?: UnifiedInfoItem[];
  statistics?: UnifiedInfoItem[];
  galleryImages?: UnifiedGalleryImage[];
  fileGroups?: UnifiedFileGroup[];
  installedFileGroups?: UnifiedFileGroup[];
  dependencies?: UnifiedDependencyItem[];
  conflicts?: UnifiedDependencyItem[];
  versionHistory?: UnifiedTimelineItem[];
  receiptItems?: UnifiedInfoItem[];
  updateItems?: UnifiedTimelineItem[];
  comments?: ReactNode[];
  settingsContent?: ReactNode;
  developerItems?: UnifiedInfoItem[];
  developerMode?: boolean;
  initialTab?: string;
  extraTabs?: UnifiedTab[];
  filesUnavailableMessage?: ReactNode;
  onOpenExternal?: (url?: string | null) => void;
  onImageError?: (url?: string | null) => void;
}

function isPresent(value: ReactNode | null | undefined) {
  return value !== null && value !== undefined && value !== "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function markdownTableToHtml(block: string) {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3 || !lines[0].startsWith("|") || !/^\|?[\s:|-]+\|?$/.test(lines[1])) return null;
  const cellsFor = (line: string) => line.replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(cell.trim()));
  const head = cellsFor(lines[0]);
  const body = lines.slice(2).filter((line) => line.includes("|")).map(cellsFor);
  if (!head.length || !body.length) return null;
  return [
    "<table><thead><tr>",
    head.map((cell) => `<th>${cell}</th>`).join(""),
    "</tr></thead><tbody>",
    body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join(""),
    "</tbody></table>",
  ].join("");
}

function markdownToHtml(raw: string) {
  const text = raw.trim();
  if (!text) return "<p>No description loaded.</p>";
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return text;

  const fencedBlocks: string[] = [];
  const withCodeTokens = text.replace(/```([\s\S]*?)```/g, (_, code: string) => {
    const token = `@@TSUKI_CODE_${fencedBlocks.length}@@`;
    fencedBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return token;
  });

  const blocks = escapeHtml(withCodeTokens)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const codeIndex = block.match(/^@@TSUKI_CODE_(\d+)@@$/)?.[1];
      if (codeIndex !== undefined) return fencedBlocks[Number(codeIndex)] ?? "";
      const table = markdownTableToHtml(block);
      if (table) return table;
      if (/^&gt;!\s*[\s\S]*!&lt;$/.test(block)) {
        const spoiler = block.replace(/^&gt;!\s*/, "").replace(/!&lt;$/, "");
        return `<details><summary>Spoiler</summary><p>${inlineMarkdown(spoiler)}</p></details>`;
      }
      if (/^(?:[-*]\s+.+\n?)+$/m.test(block)) {
        const items = block.split("\n").filter(Boolean).map((line) => line.replace(/^[-*]\s+/, ""));
        return `<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`;
      }
      const heading = block.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = Math.min(3, heading[1].length + 1);
        return `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      }
      return `<p>${inlineMarkdown(block).replace(/\n/g, "<br />")}</p>`;
    });

  return blocks.join("");
}

function formatGameLabel(value?: string | null) {
  const clean = String(value ?? "").trim();
  if (!clean) return null;
  const normalized = clean.toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "payday-3" || normalized === "payday3" || normalized === "pd3" || normalized === "853") return "PAYDAY 3";
  if (normalized === "payday-2" || normalized === "payday2" || normalized === "pd2" || normalized === "1") return "PAYDAY 2";
  return clean
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function RichDescription({ text, onOpenExternal }: { text?: string | null; onOpenExternal?: (url?: string | null) => void }) {
  const html = useMemo(() => sanitizeRichHtml(markdownToHtml(text ?? "")), [text]);

  return (
    <div
      className="unified-rich-description"
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        onOpenExternal?.(link.getAttribute("href"));
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function BadgeRow({ badges }: { badges: UnifiedBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <div className="unified-badge-row">
      {badges.map((badge, index) => (
        <span className={`unified-badge ${badge.tone ?? "neutral"}`} key={`badge-${index}`}>{badge.label}</span>
      ))}
    </div>
  );
}

function textFromNode(value?: ReactNode): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textFromNode).join(" ");
  if (isValidElement<{ children?: ReactNode }>(value)) return textFromNode(value.props.children);
  return "";
}

function matchesQuery(query: string, ...values: Array<ReactNode | undefined | null>) {
  if (!query) return true;
  return values.some((value) => textFromNode(value ?? null).toLowerCase().includes(query));
}

function filterInfoItems(items: UnifiedInfoItem[], query: string) {
  return query ? items.filter((item) => matchesQuery(query, item.label, item.value, item.detail)) : items;
}

function filterFileGroups(groups: UnifiedFileGroup[], query: string) {
  if (!query) return groups;
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => matchesQuery(query, group.title, group.subtitle, row.title, row.subtitle, row.meta, row.status)),
    }))
    .filter((group) => group.rows.length > 0);
}

function filterTimelineItems(items: UnifiedTimelineItem[], query: string) {
  return query ? items.filter((item) => matchesQuery(query, item.title, item.detail, item.date, item.status)) : items;
}

function filterDependencyItems(items: UnifiedDependencyItem[], query: string) {
  return query ? items.filter((item) => matchesQuery(query, item.title, item.detail, item.status)) : items;
}

function filterGalleryItems(items: UnifiedGalleryImage[], query: string) {
  return query ? items.filter((item) => matchesQuery(query, item.title, item.imageUrl, item.thumbnailUrl)) : items;
}

function InfoGrid({ items, emptyLabel }: { items?: UnifiedInfoItem[]; emptyLabel?: ReactNode }) {
  const visible = (items ?? []).filter((item) => isPresent(item.value) || isPresent(item.detail));
  if (visible.length === 0) return emptyLabel ? <p className="unified-empty">{emptyLabel}</p> : null;
  return (
    <dl className="unified-info-grid">
      {visible.map((item, index) => (
        <div className={item.tone ?? "neutral"} key={`${item.label}-${index}`}>
          <dt>{item.label}</dt>
          {isPresent(item.value) && <dd>{item.value}</dd>}
          {isPresent(item.detail) && <small>{item.detail}</small>}
        </div>
      ))}
    </dl>
  );
}

function ActionBar({ actions }: { actions?: UnifiedAction[] }) {
  const visible = (actions ?? []).filter((action) => Boolean(action));
  if (visible.length === 0) return null;
  return (
    <div className="unified-action-bar" aria-label="Mod actions">
      {visible.map((action) => (
        <button
          className={`ghost-button unified-action ${action.variant ?? "neutral"}`}
          type="button"
          key={action.key}
          disabled={action.disabled}
          onClick={action.onClick}
          title={action.title}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function FileGroups({ groups, emptyLabel }: { groups?: UnifiedFileGroup[]; emptyLabel?: ReactNode }) {
  const visible = (groups ?? []).filter((group) => group.rows.length > 0 || group.emptyLabel);
  if (visible.length === 0) return emptyLabel ? <p className="unified-empty">{emptyLabel}</p> : null;
  return (
    <div className="unified-file-groups">
      {visible.map((group) => (
        <section className="unified-file-group" key={group.id}>
          <header>
            <div>
              <h3>{group.title}</h3>
              {group.subtitle && <p>{group.subtitle}</p>}
            </div>
            <span>{group.rows.length}</span>
          </header>
          <div className="unified-file-list">
            {group.rows.map((row) => (
              <article className={`unified-file-row ${row.tone ?? "neutral"}`} key={row.id}>
                <div className="unified-file-copy">
                  <strong>{row.title}</strong>
                  {row.subtitle && <p>{row.subtitle}</p>}
                  {row.meta && <small>{row.meta}</small>}
                </div>
                {row.status && <span className="unified-row-status">{row.status}</span>}
                {row.actions && <div className="unified-row-actions">{row.actions}</div>}
                {row.progress && <div className="unified-row-progress">{row.progress}</div>}
              </article>
            ))}
            {group.rows.length === 0 && <p className="unified-empty">{group.emptyLabel ?? "No files in this group."}</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function TimelineList({ items, emptyLabel }: { items?: UnifiedTimelineItem[]; emptyLabel?: ReactNode }) {
  const visible = items ?? [];
  if (visible.length === 0) return emptyLabel ? <p className="unified-empty">{emptyLabel}</p> : null;
  return (
    <div className="unified-timeline">
      {visible.map((item) => (
        <article className={`unified-timeline-item ${item.tone ?? "neutral"}`} key={item.id}>
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p>{item.detail}</p>}
          </div>
          <div className="unified-timeline-meta">
            {item.date && <span>{item.date}</span>}
            {item.status && <b>{item.status}</b>}
            {item.actions}
          </div>
        </article>
      ))}
    </div>
  );
}

function DependencyList({ items, emptyLabel }: { items?: UnifiedDependencyItem[]; emptyLabel?: ReactNode }) {
  const visible = items ?? [];
  if (visible.length === 0) return emptyLabel ? <p className="unified-empty">{emptyLabel}</p> : null;
  return (
    <div className="unified-dependency-list">
      {visible.map((item) => (
        <article className={`unified-dependency-row ${item.tone ?? "neutral"}`} key={item.id}>
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p>{item.detail}</p>}
          </div>
          {item.status && <span>{item.status}</span>}
          {item.actions && <div className="unified-row-actions">{item.actions}</div>}
        </article>
      ))}
    </div>
  );
}

function GalleryStrip({
  images,
  activeIndex,
  onSelect,
  onImageError,
}: {
  images: UnifiedGalleryImage[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onImageError?: (url?: string | null) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  if (images.length <= 1) return null;

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!stripRef.current) return;
    stripRef.current.scrollLeft += event.deltaY || event.deltaX;
  };

  return (
    <div className="unified-gallery-strip" ref={stripRef} onWheel={onWheel} aria-label="Image gallery">
      {images.map((image, index) => (
        <button
          className={index === activeIndex ? "active" : ""}
          type="button"
          key={image.id}
          onClick={() => onSelect(index)}
          aria-label={`Open image ${index + 1}`}
        >
          <img
            src={image.thumbnailUrl ?? image.imageUrl}
            alt={image.title ?? ""}
            loading="lazy"
            onError={() => onImageError?.(image.thumbnailUrl ?? image.imageUrl)}
          />
        </button>
      ))}
    </div>
  );
}

export function UnifiedModPage({
  className = "",
  backLabel,
  onBack,
  source,
  sourceLabel,
  sourceAccent,
  sourceId,
  title,
  summary,
  description,
  author,
  version,
  game,
  category,
  fileSize,
  installDate,
  lastUpdate,
  installStatus,
  verificationStatus,
  thumbnailUrl,
  bannerUrl,
  pageUrl,
  tags = [],
  badges = [],
  actions = [],
  metadata = [],
  statistics = [],
  galleryImages = [],
  fileGroups = [],
  installedFileGroups = [],
  dependencies = [],
  conflicts = [],
  versionHistory = [],
  receiptItems = [],
  updateItems = [],
  comments = [],
  settingsContent,
  developerItems = [],
  developerMode = false,
  initialTab = "overview",
  extraTabs = [],
  filesUnavailableMessage,
  onOpenExternal,
  onImageError,
}: UnifiedModPageProps) {
  const mediaItems = useMemo(() => {
    const images: UnifiedGalleryImage[] = [];
    const seen = new Set<string>();
    const addImage = (image: UnifiedGalleryImage | null) => {
      if (!image?.imageUrl || seen.has(image.imageUrl)) return;
      seen.add(image.imageUrl);
      images.push(image);
    };

    addImage(bannerUrl ? { id: "banner", imageUrl: bannerUrl, thumbnailUrl: thumbnailUrl ?? bannerUrl, title } : null);
    addImage(!bannerUrl && thumbnailUrl ? { id: "thumbnail", imageUrl: thumbnailUrl, thumbnailUrl, title } : null);
    for (const image of galleryImages) addImage(image);
    return images;
  }, [bannerUrl, galleryImages, thumbnailUrl, title]);

  const [heroIndex, setHeroIndex] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [pageSearch, setPageSearch] = useState("");
  const pageIdentity = `${source}:${sourceId ?? title}`;
  const pageIdentityRef = useRef(pageIdentity);
  const normalizedSearch = pageSearch.trim().toLowerCase();
  const heroImage = mediaItems[heroIndex] ?? mediaItems[0] ?? null;
  const displayGame = formatGameLabel(game);
  const baseMetadata = [
    { label: "Version", value: version },
    { label: "Author", value: author },
    { label: "Source", value: sourceLabel },
    { label: "Game", value: displayGame },
    { label: "Category", value: category },
    { label: "Install Status", value: installStatus },
    { label: "Verification", value: verificationStatus },
    { label: "File Size", value: fileSize },
    { label: "Install Date", value: installDate },
    { label: "Last Update", value: lastUpdate },
    ...metadata,
  ].filter((item) => isPresent(item.value) || isPresent(item.detail));

  const allBadges = [
    ...badges,
    installStatus ? { label: installStatus, tone: "good" as const } : null,
    verificationStatus ? { label: verificationStatus, tone: "neutral" as const } : null,
  ].filter((badge): badge is UnifiedBadge => Boolean(badge));

  const tabs = useMemo<UnifiedTab[]>(() => {
    const searchActive = normalizedSearch.length > 0;
    const visibleTags = searchActive ? tags.filter((tag) => matchesQuery(normalizedSearch, tag)) : tags;
    const visibleFileGroups = filterFileGroups(fileGroups, normalizedSearch);
    const visibleInstalledFileGroups = filterFileGroups(installedFileGroups, normalizedSearch);
    const visibleMediaItems = filterGalleryItems(mediaItems, normalizedSearch);
    const visibleVersionHistory = filterTimelineItems(versionHistory, normalizedSearch);
    const visibleDependencies = filterDependencyItems(dependencies, normalizedSearch);
    const visibleConflicts = filterDependencyItems(conflicts, normalizedSearch);
    const visibleReceipts = filterInfoItems(receiptItems, normalizedSearch);
    const visibleUpdates = filterTimelineItems(updateItems, normalizedSearch);
    const visibleComments = searchActive ? comments.filter((comment) => matchesQuery(normalizedSearch, comment)) : comments;
    const visibleStatistics = filterInfoItems(statistics, normalizedSearch);
    const visibleDeveloperItems = filterInfoItems(developerItems, normalizedSearch);
    const overviewMatches = !searchActive || matchesQuery(normalizedSearch, title, summary, description, author, version, displayGame, category, sourceLabel, tags.join(" "));

    const next: UnifiedTab[] = [
      {
        id: "overview",
        label: "Overview",
        content: (
          <div className="unified-overview-tab">
            {overviewMatches ? <RichDescription text={description} onOpenExternal={onOpenExternal} /> : <p className="unified-empty">No overview matches.</p>}
            {visibleTags.length > 0 && (
              <div className="unified-tag-list">
                {visibleTags.slice(0, 30).map((tag) => <span className={tagColorClass(tag)} style={tagColorStyle(tag)} key={tag}>{tag}</span>)}
              </div>
            )}
          </div>
        ),
      },
    ];

    if (fileGroups.some((group) => group.rows.length > 0) || filesUnavailableMessage) {
      next.push({
        id: "files",
        label: "Files",
        badge: visibleFileGroups.reduce((count, group) => count + group.rows.length, 0),
        content: <FileGroups groups={visibleFileGroups} emptyLabel={searchActive ? "No files match this search." : filesUnavailableMessage ?? "No downloadable files are available yet."} />,
      });
    }

    if (mediaItems.length > 0) {
      next.push({
        id: "images",
        label: "Images",
        badge: visibleMediaItems.length,
        content: visibleMediaItems.length > 0 ? (
          <div className="unified-image-grid">
            {visibleMediaItems.map((image) => {
              const originalIndex = mediaItems.findIndex((item) => item.id === image.id);
              return (
                <button type="button" key={image.id} onClick={() => setViewerIndex(Math.max(0, originalIndex))}>
                  <img src={image.thumbnailUrl ?? image.imageUrl} alt={image.title ?? title} loading="lazy" onError={() => onImageError?.(image.thumbnailUrl ?? image.imageUrl)} />
                  <span>{image.title ?? `Image ${Math.max(0, originalIndex) + 1}`}</span>
                </button>
              );
            })}
          </div>
        ) : <p className="unified-empty">No images match this search.</p>,
      });
    }

    if (versionHistory.length > 0) {
      next.push({ id: "versions", label: "Versions", badge: visibleVersionHistory.length, content: <TimelineList items={visibleVersionHistory} emptyLabel={searchActive ? "No versions match this search." : undefined} /> });
    }

    if (dependencies.length > 0) {
      next.push({ id: "dependencies", label: "Dependencies", badge: visibleDependencies.length, content: <DependencyList items={visibleDependencies} emptyLabel={searchActive ? "No dependencies match this search." : undefined} /> });
    }

    if (conflicts.length > 0) {
      next.push({ id: "conflicts", label: "Conflicts", badge: visibleConflicts.length, content: <DependencyList items={visibleConflicts} emptyLabel={searchActive ? "No conflicts match this search." : undefined} /> });
    }

    if (installedFileGroups.some((group) => group.rows.length > 0)) {
      next.push({
        id: "installed-files",
        label: "Installed Files",
        badge: visibleInstalledFileGroups.reduce((count, group) => count + group.rows.length, 0),
        content: <FileGroups groups={visibleInstalledFileGroups} emptyLabel={searchActive ? "No installed files match this search." : "No installed files are tracked for this mod yet."} />,
      });
    }

    if (settingsContent) {
      next.push({ id: "settings", label: "Settings", content: settingsContent });
    }

    if (receiptItems.length > 0) {
      next.push({ id: "receipts", label: "Receipts", badge: visibleReceipts.length, content: <InfoGrid items={visibleReceipts} emptyLabel={searchActive ? "No receipts match this search." : undefined} /> });
    }

    if (updateItems.length > 0) {
      next.push({ id: "updates", label: "Updates", badge: visibleUpdates.length, content: <TimelineList items={visibleUpdates} emptyLabel={searchActive ? "No updates match this search." : undefined} /> });
    }

    if (comments.length > 0) {
      next.push({
        id: "comments",
        label: "Comments",
        badge: visibleComments.length,
        content: visibleComments.length > 0 ? <div className="unified-comment-list">{visibleComments.map((comment, index) => <article key={`comment-${index}`}>{comment}</article>)}</div> : <p className="unified-empty">No comments match this search.</p>,
      });
    }

    if (statistics.length > 0) {
      next.push({ id: "statistics", label: "Statistics", badge: visibleStatistics.length, content: <InfoGrid items={visibleStatistics} emptyLabel={searchActive ? "No statistics match this search." : undefined} /> });
    }

    if (developerMode && developerItems.length > 0) {
      next.push({ id: "developer", label: "Developer", badge: visibleDeveloperItems.length, content: <InfoGrid items={visibleDeveloperItems} emptyLabel={searchActive ? "No developer fields match this search." : undefined} /> });
    }

    return [...next, ...extraTabs];
  }, [
    author,
    category,
    comments,
    conflicts,
    dependencies,
    description,
    developerItems,
    developerMode,
    extraTabs,
    fileGroups,
    filesUnavailableMessage,
    displayGame,
    installedFileGroups,
    mediaItems,
    normalizedSearch,
    onImageError,
    onOpenExternal,
    receiptItems,
    settingsContent,
    sourceLabel,
    statistics,
    summary,
    tags,
    title,
    updateItems,
    version,
    versionHistory,
  ]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab(tabs[0]?.id ?? "overview");
  }, [activeTab, tabs]);

  useEffect(() => {
    if (pageIdentityRef.current === pageIdentity) return;
    pageIdentityRef.current = pageIdentity;
    setHeroIndex(0);
    setViewerIndex(null);
    setZoom(1);
    setPageSearch("");
    setActiveTab(tabs.some((tab) => tab.id === initialTab) ? initialTab : tabs[0]?.id ?? "overview");
  }, [initialTab, pageIdentity, tabs]);

  useEffect(() => {
    if (viewerIndex === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewerIndex(null);
      if (event.key === "ArrowLeft") setViewerIndex((current) => current === null ? current : (current + mediaItems.length - 1) % mediaItems.length);
      if (event.key === "ArrowRight") setViewerIndex((current) => current === null ? current : (current + 1) % mediaItems.length);
      if (event.key === "+" || event.key === "=") setZoom((current) => Math.min(3, current + 0.2));
      if (event.key === "-") setZoom((current) => Math.max(0.6, current - 0.2));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mediaItems.length, viewerIndex]);

  const currentViewerImage = viewerIndex === null ? null : mediaItems[viewerIndex] ?? null;
  const activeTabContent = tabs.find((tab) => tab.id === activeTab)?.content ?? tabs[0]?.content;

  return (
    <section className={`page unified-mod-page source-detail-page source-detail-${source} ${className}`}>
      <div className="unified-mod-nav">
        <button className="ghost-button compact" type="button" onClick={onBack}>{backLabel}</button>
        <span>{sourceLabel} mod page</span>
      </div>

      <header className={`unified-mod-hero ${heroImage ? "has-media" : "no-media"}`}>
        {heroImage && <button className="unified-hero-media" type="button" onClick={() => mediaItems.length > 0 && setViewerIndex(heroIndex)}>
          {heroImage ? (
            <img src={heroImage.imageUrl} alt={heroImage.title ?? title} loading="eager" onError={() => onImageError?.(heroImage.imageUrl)} />
          ) : (
            <span>{sourceAccent}</span>
          )}
        </button>}

        <div className="unified-hero-copy">
          <p className="eyebrow">{sourceLabel}</p>
          <h1>{title}</h1>
          {summary && <p>{summary}</p>}
          <BadgeRow badges={allBadges} />
          <InfoGrid items={baseMetadata.filter((item) => ["Author", "Version", "Game", "Last Update"].includes(item.label))} />
        </div>

        <ActionBar actions={[
          ...actions,
          pageUrl && onOpenExternal ? { key: "visit-page", label: "Visit Page", onClick: () => onOpenExternal(pageUrl), variant: "neutral" as const } : null,
        ].filter((action): action is UnifiedAction => Boolean(action))} />
      </header>

      <GalleryStrip images={mediaItems} activeIndex={heroIndex} onSelect={setHeroIndex} onImageError={onImageError} />

      <div className="unified-mod-layout">
        <main className="unified-mod-main">
          <div className="unified-mod-search" role="search">
            <input aria-label="Search this mod page" value={pageSearch} placeholder="Search this mod" onChange={(event) => setPageSearch(event.target.value)} />
            {pageSearch && <button className="ghost-button compact" type="button" onClick={() => setPageSearch("")}>Clear</button>}
          </div>
          <nav className="unified-mod-tabs" aria-label="Mod detail tabs">
            {tabs.map((tab) => (
              <button
                className={activeTab === tab.id ? "active" : ""}
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const direction = event.key === "ArrowRight" ? 1 : -1;
                  const currentIndex = tabs.findIndex((item) => item.id === activeTab);
                  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
                  setActiveTab(tabs[nextIndex]?.id ?? tabs[0]?.id ?? "overview");
                }}
              >
                {tab.label}
                {isPresent(tab.badge) && <span>{tab.badge}</span>}
              </button>
            ))}
          </nav>
          <section className="unified-tab-panel">{activeTabContent}</section>
        </main>

        <aside className="unified-mod-side">
          <section>
            <p className="eyebrow">Source</p>
            <h2>{sourceLabel}</h2>
            <InfoGrid items={[
              { label: "Page", value: pageUrl ? "Available" : "Unavailable" },
              { label: "Game", value: displayGame },
            ]} />
          </section>

          <section>
            <p className="eyebrow">Information</p>
            <h2>Details</h2>
            <InfoGrid items={baseMetadata} emptyLabel="No metadata has been saved for this mod yet." />
          </section>

          {statistics.length > 0 && (
            <section>
              <p className="eyebrow">Statistics</p>
              <h2>Activity</h2>
              <InfoGrid items={statistics.slice(0, 8)} />
            </section>
          )}

          {tags.length > 0 && (
            <section>
              <p className="eyebrow">Tags</p>
              <div className="unified-tag-list compact">
                {tags.slice(0, 24).map((tag) => <span className={tagColorClass(tag)} style={tagColorStyle(tag)} key={tag}>{tag}</span>)}
              </div>
            </section>
          )}
        </aside>
      </div>

      {currentViewerImage && (
        <div className="unified-image-viewer" role="dialog" aria-modal="true">
          <header>
            <strong>{currentViewerImage.title ?? `${title} image`}</strong>
            <div>
              <button className="ghost-button compact" type="button" onClick={() => setZoom((current) => Math.max(0.6, current - 0.2))}>Zoom Out</button>
              <button className="ghost-button compact" type="button" onClick={() => setZoom(1)}>Reset</button>
              <button className="ghost-button compact" type="button" onClick={() => setZoom((current) => Math.min(3, current + 0.2))}>Zoom In</button>
              <button className="ghost-button compact" type="button" onClick={() => setViewerIndex(null)}>Close</button>
            </div>
          </header>
          <button className="unified-viewer-prev" type="button" onClick={() => setViewerIndex((current) => current === null ? current : (current + mediaItems.length - 1) % mediaItems.length)}>Previous</button>
          <div className="unified-viewer-stage">
            <img
              src={currentViewerImage.imageUrl}
              alt={currentViewerImage.title ?? title}
              style={{ transform: `scale(${zoom})` }}
              onError={() => onImageError?.(currentViewerImage.imageUrl)}
            />
          </div>
          <button className="unified-viewer-next" type="button" onClick={() => setViewerIndex((current) => current === null ? current : (current + 1) % mediaItems.length)}>Next</button>
        </div>
      )}
    </section>
  );
}
