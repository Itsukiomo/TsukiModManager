import "./WindowTitleBar.css";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { AppPage } from "../../models/navigation";
import tsukiLogo from "../../assets/tsuki-logo.png";

interface AppUpdateStatus {
  currentVersion: string;
  currentSemver: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  notes?: string | null;
  pubDate?: string | null;
  downloadUrl?: string | null;
  releaseUrl?: string | null;
  sha256?: string | null;
  manifestUrl?: string | null;
  checkedAtUnix: number;
  error?: string | null;
}

interface WindowTitleBarProps {
  activePage: AppPage;
  appUpdate: AppUpdateStatus | null;
  updateBusy: boolean;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}

const pageLabels: Record<AppPage, string> = {
  home: "Home",
  browse: "Browse",
  installed: "Installed Mods",
  profiles: "Profiles",
  repair: "Repair",
  backups: "Backups",
  settings: "Settings",
};

async function safeInvoke(command: string) {
  try {
    await invoke(command);
  } catch (error) {
    console.error(`Window command failed: ${command}`, error);
  }
}

export function WindowTitleBar({ activePage, appUpdate, updateBusy, onCheckUpdate, onInstallUpdate }: WindowTitleBarProps) {
  const [launchBusy, setLaunchBusy] = useState(false);
  async function minimizeWindow() {
    await safeInvoke("window_minimize");
  }

  async function toggleMaximizeWindow() {
    await safeInvoke("window_toggle_maximize");
  }

  async function closeWindow() {
    await safeInvoke("window_close");
  }

  async function launchVanilla() {
    if (launchBusy) return;
    setLaunchBusy(true);
    try {
      await safeInvoke("launch_payday3_vanilla");
    } finally {
      window.setTimeout(() => setLaunchBusy(false), 7000);
    }
  }

  async function launchModded() {
    if (launchBusy) return;
    setLaunchBusy(true);
    try {
      await safeInvoke("launch_payday3_modded");
    } finally {
      window.setTimeout(() => setLaunchBusy(false), 7000);
    }
  }

  async function handleTitlebarMouseDown(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest("button")) return;

    await safeInvoke("window_start_dragging");
  }

  async function handleTitlebarDoubleClick(event: React.MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;

    if (target.closest("button")) return;

    await toggleMaximizeWindow();
  }

  return (
    <header className="window-titlebar" data-tauri-drag-region onMouseDown={handleTitlebarMouseDown} onDoubleClick={handleTitlebarDoubleClick}>
      <div className="window-brand" data-tauri-drag-region>
        <img className="window-logo-image" src={tsukiLogo} alt="" />
        <div>
          <strong>Tsuki Mod Manager</strong>
          <span>{pageLabels[activePage]}</span>
        </div>
      </div>

      <div className="window-titlebar-center" data-tauri-drag-region>
        <span>PAYDAY 3 mod library</span>
      </div>

      <div className="window-update-actions">
        {appUpdate?.updateAvailable ? (
          <button type="button" className="window-update-button" onClick={onInstallUpdate} disabled={updateBusy}>
            {updateBusy ? "Updating..." : `Update Available ${appUpdate.latestVersion ?? ""}`}
          </button>
        ) : (
          <button type="button" className="window-update-button subtle" onClick={onCheckUpdate} disabled={updateBusy} title={appUpdate?.error ?? "Check for Tsuki app updates"}>
            {updateBusy ? "Checking..." : "Check Updates"}
          </button>
        )}
      </div>

      <div className="window-launch-actions">
        <button type="button" className="window-launch-button" onClick={launchVanilla} disabled={launchBusy}>
          {launchBusy ? "Launching..." : "Launch Vanilla"}
        </button>
        <button type="button" className="window-launch-button primary" onClick={launchModded} disabled={launchBusy}>
          Launch Modded
        </button>
      </div>

      <div className="window-actions">
        <button type="button" className="window-control minimize" onClick={minimizeWindow} aria-label="Minimize">
          —
        </button>
        <button type="button" className="window-control maximize" onClick={toggleMaximizeWindow} aria-label="Maximize or restore">
          □
        </button>
        <button type="button" className="window-control close" onClick={closeWindow} aria-label="Close">
          ×
        </button>
      </div>
    </header>
  );
}
