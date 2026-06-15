import type { AppPage } from "../../models/navigation";
import tsukiLogo from "../../assets/tsuki-logo.png";

interface SidebarTaskProgress {
  active: boolean;
  label: string;
  detail?: string;
  progress?: number | null;
}

interface SidebarProps {
  activePage: AppPage;
  onChangePage: (page: AppPage) => void;
  taskProgress?: SidebarTaskProgress;
}

const navItems: Array<{ page: AppPage; label: string; icon: string }> = [
  { page: "home", label: "Home", icon: "☾" },
  { page: "browse", label: "Browse", icon: "⌕" },
  { page: "installed", label: "Installed", icon: "□" },
  { page: "profiles", label: "Profiles", icon: "◇" },
  { page: "repair", label: "Repair", icon: "✦" },
  { page: "backups", label: "Backups", icon: "◷" },
  { page: "settings", label: "Settings", icon: "⚙" },
];

export function Sidebar({ activePage, onChangePage, taskProgress }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand compact-brand">
        <img src={tsukiLogo} alt="Tsuki logo" />
        <div>
          <strong>Moonbase</strong>
          <span>PAYDAY 3</span>
        </div>
      </div>
      <div>
        <p className="sidebar-section-title">Manager</p>
        {navItems.map((item) => (
          <button
            className={`nav-button ${activePage === item.page ? "active" : ""}`}
            key={item.page}
            type="button"
            onClick={() => onChangePage(item.page)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {taskProgress?.active && (
        <div className="sidebar-task-progress">
          <div>
            <strong>{taskProgress.label}</strong>
            <span>{taskProgress.detail || "Working..."}</span>
          </div>
          <div className="sidebar-progress-track">
            <div style={{ width: `${taskProgress.progress ?? 35}%` }} />
          </div>
          {typeof taskProgress.progress === "number" && <small>{Math.round(taskProgress.progress)}%</small>}
        </div>
      )}

      <div className="sidebar-footer">
        <strong>v1.0.7.27.3</strong>
        <br />
        Build fix.</div>
    </aside>
  );
}
