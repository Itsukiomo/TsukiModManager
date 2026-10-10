import type { AppPage } from "../../models/navigation";
import type { GameProfile } from "../../models/gameProfiles";
import { ProfileArtwork } from "../ProfileArtwork";
import { Home, Compass, PackageCheck, Layers, Archive, Settings, ChevronDown, LoaderCircle, Check } from "lucide-react";

interface SidebarTaskProgress {
  active: boolean;
  label: string;
  detail?: string;
  progress?: number | null;
}
interface SidebarProps {
  activePage: AppPage;
  currentGameProfile: GameProfile;
  onChangePage: (page: AppPage) => void;
  taskProgress?: SidebarTaskProgress;
  onOpenDebug?: () => void;
}
const navItems = [
  { page: "home" as AppPage, label: "Home", icon: Home },
  { page: "browse" as AppPage, label: "Browse", icon: Compass },
  { page: "installed" as AppPage, label: "Installed", icon: PackageCheck },
  { page: "profiles" as AppPage, label: "Profiles", icon: Layers },
  { page: "backups" as AppPage, label: "Backups", icon: Archive },
  { page: "settings" as AppPage, label: "Settings", icon: Settings },
];

function selectorStatus(profile: GameProfile) {
  if (profile.setupStatus === "ready") return "Ready";
  if (profile.lifecycleState === "draft" && profile.setupProgress?.configured === 0) return "Draft";
  if (profile.lifecycleState === "draft" || profile.setupStatus === "incomplete" || profile.setupStatus === "setup_required") {
    return "Setup incomplete";
  }
  return profile.statusLabel;
}

export function Sidebar({ activePage, currentGameProfile, onChangePage, taskProgress, onOpenDebug }: SidebarProps) {
  const status = selectorStatus(currentGameProfile);
  const progress = typeof taskProgress?.progress === "number" && Number.isFinite(taskProgress.progress)
    ? Math.max(0, Math.min(100, taskProgress.progress)) : null;
  return (
    <aside className="sidebar">
      <button
        className="sidebar-brand compact-brand current-game-card"
        type="button"
        title="Select game"
        onClick={() => onChangePage("games")}
      >
        <ProfileArtwork
          className="current-game-artwork"
          imageReference={currentGameProfile.imageReference}
          legacySrc={currentGameProfile.image}
          profileId={currentGameProfile.profileId}
          alt={`${currentGameProfile.displayName} profile cover`}
          fit={currentGameProfile.artwork?.objectFit ?? "cover"}
          focalX={currentGameProfile.artwork?.focalX ?? 50}
          focalY={currentGameProfile.artwork?.focalY ?? 35}
          scale={currentGameProfile.artwork?.scale ?? 1}
          fallback={<span className="profile-artwork-placeholder" aria-hidden="true" />}
        />
        <div className="current-game-copy">
          <strong title={currentGameProfile.displayName}>{currentGameProfile.displayName}</strong>
          <span title={status}>{status}</span>
        </div>
        <ChevronDown className="current-game-caret" size={16} aria-hidden="true" />
      </button>
      <div>
        <p className="sidebar-section-title">Manager</p>
        {navItems.map((item) => (
          <button
            className={`nav-button ${activePage === item.page ? "active" : ""}`}
            key={item.page}
            type="button"
            onClick={() => onChangePage(item.page)}
          >
            <span className="nav-icon"><item.icon size={18} strokeWidth={1.8} aria-hidden="true" /></span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {taskProgress?.active && (
        <div className="sidebar-task-progress" aria-live="polite">
          <div className="sidebar-task-heading">
            {progress === 100 ? <Check size={16} aria-hidden="true" /> : <LoaderCircle size={16} className="task-spinner" aria-hidden="true" />}
            <strong title={taskProgress.label}>{taskProgress.label}</strong>
            {progress !== null && <small>{Math.round(progress)}%</small>}
          </div>
          <div className="sidebar-task-detail">
            <span>{taskProgress.detail || "Working..."}</span>
          </div>
          <div className={`sidebar-progress-track ${progress === null ? "indeterminate" : "determinate"}`} role="progressbar" aria-label={taskProgress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined} aria-valuetext={progress === null ? taskProgress.detail || "Working" : undefined}>
            <div style={progress !== null ? { width: `${progress}%` } : undefined} />
          </div>
        </div>
      )}

      <div className="sidebar-footer" onDoubleClick={onOpenDebug} title="Double-click to open debug panel">
        <strong>v2.0.3</strong>
      </div>
    </aside>
  );
}
