import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface ModProfile {
  id: string;
  name: string;
  createdUnix: number;
  enabledPakFiles: string[];
  enabledReceiptIds: string[];
}

function formatProfileDate(seconds?: number) {
  if (!seconds) return "Unknown date";
  return new Date(seconds * 1000).toLocaleString();
}

export function ProfilesPage() {
  const [profiles, setProfiles] = useState<ModProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [, setStatus] = useState("Profiles ready.");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);
  const [visibleProfileLists, setVisibleProfileLists] = useState<Record<string, boolean>>({});
  const [folderNotice, setFolderNotice] = useState<string | null>(null);

  function showFolderNotice(message: string) {
    setFolderNotice(message);
    window.setTimeout(() => {
      setFolderNotice((current) => current === message ? null : current);
    }, 2800);
  }

  async function refreshProfiles() {
    try {
      const result = await invoke<ModProfile[]>("list_mod_profiles");
      setProfiles(result);
      setStatus(result.length ? `${result.length} saved profile${result.length === 1 ? "" : "s"}.` : "No profiles saved yet.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveProfile() {
    setBusyId("save-profile");
    try {
      const result = await invoke<ModProfile>("save_current_mod_profile", {
        name: profileName.trim() || `Profile ${new Date().toLocaleString()}`,
      });
      setProfileName("");
      setExpandedProfileId(result.id);
      setStatus(`Saved profile: ${result.name}`);
      await refreshProfiles();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function applyProfile(profile: ModProfile) {
    setBusyId(profile.id);
    try {
      const result = await invoke<string>("apply_mod_profile", { profileId: profile.id });
      setStatus(result);
      window.dispatchEvent(new Event("tsuki-data-refresh"));
      await refreshProfiles();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProfile(profile: ModProfile) {
    if (!window.confirm(`Delete profile "${profile.name}"? This does not uninstall mods.`)) return;

    setBusyId(`delete-${profile.id}`);
    try {
      const result = await invoke<string>("delete_mod_profile", { profileId: profile.id });
      setStatus(result);
      setExpandedProfileId((current) => current === profile.id ? null : current);
      await refreshProfiles();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function openProfilesFolder() {
    setBusyId("open-profiles-folder");
    try {
      await invoke<string>("open_mod_profiles_folder");
      showFolderNotice("Profiles folder opened.");
    } catch (error) {
      showFolderNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  function toggleProfileList(profileId: string) {
    setVisibleProfileLists((current) => ({ ...current, [profileId]: !current[profileId] }));
  }

  function profilePakItems(profile: ModProfile) {
    return profile.enabledPakFiles.map((fileName) => ({ name: fileName, kind: "PAK" }));
  }

  function profileReceiptItems(profile: ModProfile) {
    return profile.enabledReceiptIds.map((receiptId) => ({ name: receiptId, kind: "Tsuki receipt" }));
  }

  useEffect(() => {
    void refreshProfiles();
  }, []);

  return (
    <section className="page profiles-page simple-profiles-page">
      <div className="page-header clean-page-header">
        <div>
          <p className="eyebrow">Loadouts</p>
          <h1>Profiles</h1>
          <p className="page-description">
            Save your current enabled mods as a loadout, then apply it later.
          </p>
        </div>
        <div className="profile-header-actions">
          <button className="ghost-button compact" type="button" disabled={busyId === "open-profiles-folder"} onClick={openProfilesFolder}>
            Open Profiles Folder
          </button>
          <button className="ghost-button compact" type="button" onClick={refreshProfiles}>Refresh</button>
        </div>
      </div>

      <article className="card profile-save-card simple-profile-save">
        <div>
          <h2>Create profile</h2>
          <p>Save your current enabled mods as a reusable loadout.</p>
        </div>
        <div className="profile-save-controls">
          <input
            className="setting-input"
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            placeholder="Profile name"
          />
          <button className="ghost-button" type="button" disabled={busyId === "save-profile"} onClick={saveProfile}>
            {busyId === "save-profile" ? "Saving..." : "Save Current Mods"}
          </button>
        </div>
      </article>

      {folderNotice && (
        <div className="profile-folder-toast" role="status" aria-live="polite">
          {folderNotice}
        </div>
      )}

      <article className="card simple-profile-list-card">
        <div className="home-feed-header">
          <div>
            <p className="eyebrow">Saved</p>
            <h2>Loadouts</h2>
          </div>
        </div>

        <div className="managed-list simple-profile-list">
          {profiles.length === 0 ? (
            <p>No profiles yet. Save your current setup above.</p>
          ) : profiles.map((profile) => {
            const expanded = expandedProfileId === profile.id;
            return (
              <div className={`managed-row simple-profile-row profile-row-clean ${expanded ? "expanded" : ""}`} key={profile.id}>
                <div className="profile-row-main">
                  <div>
                    <strong>{profile.name}</strong>
                    <p>
                      {profile.enabledPakFiles.length} PAK files · {profile.enabledReceiptIds.length} Tsuki installs · {formatProfileDate(profile.createdUnix)}
                    </p>
                  </div>
                  <div className="profile-row-actions">
                    <button className="ghost-button compact" type="button" onClick={() => setExpandedProfileId(expanded ? null : profile.id)}>
                      {expanded ? "Hide" : "View"}
                    </button>
                    <button className="ghost-button compact" type="button" disabled={busyId === profile.id} onClick={() => applyProfile(profile)}>
                      {busyId === profile.id ? "Applying..." : "Apply"}
                    </button>
                    <button className="ghost-button compact danger" type="button" disabled={busyId === `delete-${profile.id}`} onClick={() => deleteProfile(profile)}>
                      {busyId === `delete-${profile.id}` ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
                {expanded && (() => {
                  const pakItems = profilePakItems(profile);
                  const receiptItems = profileReceiptItems(profile);
                  const showAll = visibleProfileLists[profile.id] ?? false;
                  const visiblePaks = showAll ? pakItems : pakItems.slice(0, 18);
                  const visibleReceipts = showAll ? receiptItems : receiptItems.slice(0, 12);
                  const hiddenCount = Math.max(0, pakItems.length + receiptItems.length - visiblePaks.length - visibleReceipts.length);

                  return (
                    <div className="profile-detail-panel profile-detail-grid">
                      <section className="profile-detail-summary">
                        <div>
                          <span>Saved on</span>
                          <strong>{formatProfileDate(profile.createdUnix)}</strong>
                        </div>
                        <div>
                          <span>PAK files</span>
                          <strong>{pakItems.length}</strong>
                        </div>
                        <div>
                          <span>Tsuki installs</span>
                          <strong>{receiptItems.length}</strong>
                        </div>
                      </section>

                      <section className="profile-mod-section">
                        <div className="profile-section-heading">
                          <span>PAK files restored by name</span>
                          <small>{pakItems.length} saved</small>
                        </div>
                        <div className="profile-chip-list">
                          {visiblePaks.length ? visiblePaks.map((item) => (
                            <span className="profile-mod-chip pak" key={item.name} title={item.name}>
                              <small>{item.kind}</small>{item.name}
                            </span>
                          )) : <p>No loose PAK files saved in this profile.</p>}
                        </div>
                      </section>

                      <section className="profile-mod-section">
                        <div className="profile-section-heading">
                          <span>Receipt-backed Tsuki installs</span>
                          <small>{receiptItems.length} saved</small>
                        </div>
                        <div className="profile-chip-list receipt-list">
                          {visibleReceipts.length ? visibleReceipts.map((item) => (
                            <span className="profile-mod-chip receipt" key={item.name} title={item.name}>
                              <small>{item.kind}</small>{item.name}
                            </span>
                          )) : <p>No receipt-backed installs saved in this profile.</p>}
                        </div>
                      </section>

                      {hiddenCount > 0 && (
                        <button className="ghost-button compact profile-show-more" type="button" onClick={() => toggleProfileList(profile.id)}>
                          {showAll ? "Show less" : `Show ${hiddenCount} more`}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </article>
    </section>
  );
}
