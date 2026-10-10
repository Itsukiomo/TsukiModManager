import "./WindowTitleBar.css";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { GameProfile } from "../../models/gameProfiles";
import type { AppPage } from "../../models/navigation";
import type { ActiveProfileRuntime } from "../../models/profileRuntime";
import { Download, RefreshCw, Play, Sparkles, Minus, Square, X } from "lucide-react";
import tsukiLogo from "../../assets/tsuki-lunar-logo-v2-ui.png";

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
  currentGameProfile: GameProfile;
  profileRuntime?: ActiveProfileRuntime | null;
  profileSwitching?: boolean;
  specialFlow?: boolean;
}

const pageLabels: Record<AppPage, string> = {
  home: "Home",
  browse: "Browse",
  installed: "Installed Mods",
  profiles: "Profiles",
  games: "Select Game",
  profileCreator: "Create Profile",
  repair: "Repair",
  backups: "Backups",
  settings: "Settings",
};

async function safeInvoke(command: string, args?: Record<string, unknown>) {
  try {
    await invoke(command, args);
  } catch (error) {
    console.error(`Window command failed: ${command}`, error);
  }
}

export function WindowTitleBar({ activePage, appUpdate, updateBusy, onCheckUpdate, onInstallUpdate, currentGameProfile, profileRuntime, profileSwitching = false, specialFlow = false }: WindowTitleBarProps) {
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchStatus, setLaunchStatus] = useState("");
  const runtimeReady = !profileSwitching && profileRuntime?.profileId === currentGameProfile.profileId && profileRuntime.ready !== false;
  const launchConfigured = currentGameProfile.profileId === "builtin.payday3" || Boolean(profileRuntime?.executable);
  const canLaunch = runtimeReady && launchConfigured;
  const launchDisabledTitle = profileSwitching
    ? "Profile runtime is switching."
    : runtimeReady
      ? launchConfigured ? `Launch ${profileRuntime?.gameName ?? currentGameProfile.displayName}` : "This profile does not have a launch executable configured."
      : "Profile runtime is not ready.";
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
      setLaunchStatus(await invoke<string>("launch_active_profile_vanilla", { profileId: currentGameProfile.profileId }));
    } catch (error) {
      setLaunchStatus(error instanceof Error ? error.message : String(error));
    } finally {
      window.setTimeout(() => setLaunchBusy(false), 7000);
    }
  }

  async function launchModded() {
    if (launchBusy) return;
    setLaunchBusy(true);
    try {
      setLaunchStatus(await invoke<string>("launch_active_profile_modded", { profileId: currentGameProfile.profileId }));
    } catch (error) {
      setLaunchStatus(error instanceof Error ? error.message : String(error));
    } finally {
      window.setTimeout(() => setLaunchBusy(false), 7000);
    }
  }


  async function handleTitlebarDoubleClick(event: React.MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;

    if (target.closest("button")) return;

    await toggleMaximizeWindow();
  }

  return (
    <header className="window-titlebar" onDoubleClick={handleTitlebarDoubleClick}>
      <div className="window-brand" data-tauri-drag-region>
        <img className="window-logo-image" src={tsukiLogo} alt="" />
        <div>
          <strong>Tsuki <small>Mod Manager</small></strong>
          <span>{pageLabels[activePage]}</span>
        </div>
      </div>

      <div className="window-titlebar-center" data-tauri-drag-region>
        <span title={specialFlow ? "Profile workflow" : profileRuntime?.gameName ?? currentGameProfile.displayName}>{specialFlow ? "Profile workflow" : profileRuntime?.gameName ?? currentGameProfile.displayName}</span>
      </div>

      <div className="window-update-actions">
        {appUpdate?.updateAvailable ? (
          <button type="button" className="window-update-button" onClick={onInstallUpdate} disabled={updateBusy}>
            <Download size={14} aria-hidden="true" />
            {updateBusy ? "Updating..." : `Update Available ${appUpdate.latestVersion ?? ""}`}
          </button>
        ) : (
          <button type="button" className="window-update-button subtle" onClick={onCheckUpdate} disabled={updateBusy} title={appUpdate?.error ?? "Check for Tsuki app updates"}>
            <RefreshCw size={14} className={updateBusy ? "window-icon-busy" : undefined} aria-hidden="true" />
            {updateBusy ? "Checking..." : "Check Updates"}
          </button>
        )}
      </div>

      {!specialFlow && (
        <div className="window-launch-actions">
          {launchStatus && <span className="window-launch-status" role="status" title={launchStatus}>{launchStatus}</span>}
          <button type="button" className="window-launch-button" onClick={launchVanilla} disabled={launchBusy || !canLaunch} title={launchDisabledTitle}>
            <Play size={14} aria-hidden="true" />
            {launchBusy ? "Launching..." : "Launch Vanilla"}
          </button>
          <button type="button" className="window-launch-button primary" onClick={launchModded} disabled={launchBusy || !canLaunch} title={launchDisabledTitle}>
            <Sparkles size={14} aria-hidden="true" />
            Launch Modded
          </button>
        </div>
      )}

      <div className="window-actions">
        <button type="button" className="window-control minimize" onClick={minimizeWindow} aria-label="Minimize" title="Minimize">
          <Minus size={15} aria-hidden="true" />
        </button>
        <button type="button" className="window-control maximize" onClick={toggleMaximizeWindow} aria-label="Maximize or restore" title="Maximize or restore">
          <Square size={12} aria-hidden="true" />
        </button>
        <button type="button" className="window-control close" onClick={closeWindow} aria-label="Close" title="Close">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
