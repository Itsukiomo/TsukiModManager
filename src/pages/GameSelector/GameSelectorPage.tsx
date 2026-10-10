import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { makeDraft } from "../ProfileCreator/ProfileCreatorPage";
import { ProfileArtwork } from "../../components/ProfileArtwork";
import type { GameProfile, GameProfileType } from "../../models/gameProfiles";
import { repairMojibakeText } from "../../utils/textEncoding";

interface AppCapabilities {
  isDeveloperMode: boolean;
  canEditOfficialProfiles: boolean;
}

interface GameSelectorPageProps {
  profiles: GameProfile[];
  currentProfile: GameProfile;
  appCapabilities: AppCapabilities;
  onSelectProfile: (profileId: string) => void;
  onVersionChange: (profileId: string, version: string) => void;
  onCreateProfile: () => void;
  onEditProfile: (profileId: string) => void;
  onDeleteDraft: (profileId: string) => void | Promise<void>;
  onDuplicateProfile: (profileId: string) => void | Promise<void>;
  onOpenSettings: () => void;
  onOpenProfileSettings: (profileId: string) => void;
}

type AddDialogAction = "create" | "import" | "browse";

const originLabels: Record<GameProfileType, string> = {
  builtin_official: "Official",
  promoted_official: "Official",
  community: "Community",
  user_created: "Custom",
};

const originFilters: Array<{ id: "all" | GameProfileType; label: string }> = [
  { id: "all", label: "All" },
  { id: "builtin_official", label: "Official" },
  { id: "community", label: "Community" },
  { id: "user_created", label: "Custom" },
];

function profileOriginLabel(profile: GameProfile) {
  if (profile.lifecycleState === "draft") return "Draft";
  return originLabels[profile.profileType] ?? "Custom";
}
export function GameSelectorPage({ profiles, currentProfile, appCapabilities, onSelectProfile, onVersionChange, onCreateProfile, onEditProfile, onDeleteDraft, onDuplicateProfile, onOpenSettings, onOpenProfileSettings }: GameSelectorPageProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | GameProfileType>("all");
  const [menuProfileId, setMenuProfileId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const availableFilters = useMemo(() => {
    if (profiles.length <= 2) return [];
    const profileTypes = new Set(profiles.map((profile) => profile.profileType));
    return originFilters.filter((item) => item.id === "all" || profileTypes.has(item.id));
  }, [profiles]);

  const filteredProfiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return profiles.filter((profile) => {
      if (filter !== "all" && profile.profileType !== filter) return false;
      if (!normalizedQuery) return true;
      return repairMojibakeText(profile.displayName).toLowerCase().includes(normalizedQuery);
    });
  }, [filter, profiles, query]);

  const profileGroups = useMemo(() => [
    {
      id: "installed",
      title: "Installed",
      profiles: filteredProfiles.filter((profile) => profile.installation?.installed === true),
    },
    {
      id: "not-installed",
      title: "Not Installed",
      profiles: filteredProfiles.filter((profile) => profile.installation?.installed !== true),
    },
  ], [filteredProfiles]);

  function showUnavailable(action: AddDialogAction) {
    if (action === "create") {
      setAddDialogOpen(false);
      onCreateProfile();
      return;
    }
    const messages: Record<AddDialogAction, string> = {
      create: "Opening Profile Creator.",
      import: "Import Profile File is not wired yet.",
      browse: "Community profile browsing needs a configured catalog service.",
    };
    setNotice(messages[action]);
    setAddDialogOpen(false);
    window.setTimeout(() => setNotice((current) => current === messages[action] ? null : current), 2600);
  }

  async function importProfile() {
    try {
      const path = await open({ multiple: false, filters: [{ name: "Tsuki profiles", extensions: ["tsukiprofile", "json"] }] });
      if (!path || typeof path !== "string") return;
      const draft = JSON.parse(await invoke<string>("read_profile_creator_import_file", { path }));
      if (!draft.schemaVersion || !draft.overview || !draft.sections || !draft.artwork) throw new Error("Profile package is missing required fields.");
      const profileId = `user.${crypto.randomUUID()}`;
      await invoke("save_game_profile_draft", { profileId, draft: { ...draft, profileId, profileType: "user_created", status: "draft", lifecycleState: "draft" } });
      setAddDialogOpen(false);
      onEditProfile(profileId);
    } catch (error) { setNotice(`Import failed: ${String(error)}`); }
  }

  async function exportProfile(profile: GameProfile) {
    try {
      const path = await save({ defaultPath: `${profile.gameKey}.tsukiprofile`, filters: [{ name: "Tsuki profile draft", extensions: ["tsukiprofile", "json"] }] });
      if (!path) return;
      await invoke("write_profile_creator_text_file", { path, contents: JSON.stringify(makeDraft(profile), null, 2), extension: "tsukiprofile" });
      setNotice(`Exported ${profile.displayName} profile draft.`);
    } catch (error) { setNotice(`Export failed: ${String(error)}`); }
  }

  return (
    <section className="page game-selector-page compact-game-selector">
      <div className="game-selector-topbar">
        <div>
          <h1>Select Game</h1>
          <p>Choose a game to manage.</p>
        </div>
        <div className="game-selector-topbar-actions">
          <button className="ghost-button compact" type="button" onClick={onOpenSettings}>
            Settings
          </button>
          <button className="ghost-button compact" type="button" onClick={() => showUnavailable("browse")}>
            Browse Community
          </button>
        </div>
      </div>

      <div className="game-selector-tools">
        <input
          className="setting-input game-selector-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search profiles..."
        />
        {availableFilters.length > 0 && (
          <div className="game-selector-filters" aria-label="Filter game profiles">
            {availableFilters.map((item) => (
              <button
                className={`profile-filter-button ${filter === item.id ? "selected" : ""}`}
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="game-profile-sections">
        {profileGroups.map((group) => (
          <section className="game-profile-group" key={group.id} aria-labelledby={`game-profile-group-${group.id}`}>
            <div className="game-profile-group-heading">
              <h2 id={`game-profile-group-${group.id}`}>{group.title}</h2>
              <span>{group.profiles.length}</span>
            </div>
            <div className="game-profile-grid" aria-label={`${group.title} game profiles`}>
        {group.profiles.map((profile) => {
          const isDraft = profile.lifecycleState === "draft";
          const installationChecked = profile.installation?.checked === true;
          const needsSetup = !isDraft && profile.setupStatus !== "ready";
          const current = !isDraft && currentProfile.profileId === profile.profileId;
          const menuOpen = menuProfileId === profile.profileId;
          const displayName = repairMojibakeText(profile.displayName);
          const setupLabel = repairMojibakeText(
            profile.setupStatus === "ready"
              ? "Ready"
              : profile.setupStatus === "error"
                ? "Invalid configuration"
                : (profile.setupProgress?.configured ?? 0) === 0
                  ? "Draft"
                  : "Setup incomplete",
          );
          const setupTitle = repairMojibakeText(profile.statusLabel ?? profile.setupProgress?.label ?? setupLabel);
          const installationLabel = profile.installation?.installed
            ? needsSetup
              ? "Installed - Profile setup pending"
              : `Installed - ${profile.installation.storefront === "manual" ? "Configured folder" : "Steam"}`
            : "Not installed";
          return (
            <article className={`game-profile-card portrait ${(profile.gameVersions?.length ?? 0) > 1 ? "has-version-picker" : ""} ${current ? "current" : ""} ${(isDraft || needsSetup) ? "setup-required" : ""}`} key={profile.profileId}>
              <button
                className="game-profile-select-surface"
                type="button"
                aria-pressed={current}
                onClick={() => isDraft ? onEditProfile(profile.profileId) : onSelectProfile(profile.profileId)}
              >
                <div className="game-profile-artwork-frame">
                  <ProfileArtwork
                    imageReference={profile.imageReference}
                    legacySrc={profile.image}
                    profileId={profile.profileId}
                    alt={`${displayName} artwork`}
                    fit={profile.artwork?.objectFit ?? "cover"}
                    focalX={profile.artwork?.focalX ?? 50}
                    focalY={profile.artwork?.focalY ?? 35}
                    scale={profile.artwork?.scale ?? 1}
                    fallback={<span className="profile-artwork-placeholder" aria-hidden="true" />}
                  />
                  <span className="game-profile-art-shade" />
                  <span className="game-profile-origin-badge">{profileOriginLabel(profile)}</span>
                </div>
                <div className="game-profile-card-meta">
                  <span className="game-profile-card-title" title={displayName}>{displayName}</span>
                  <span className="game-profile-install-status">Profile v{profile.profileVersion || "1.0.0"}{profile.gameVersion ? ` - ${profile.gameVersion}` : ""}</span>
                  {isDraft && <span className="game-profile-setup-status" title={setupTitle}>{setupLabel}</span>}
                  {!isDraft && installationChecked && <span className="game-profile-install-status">{installationLabel}</span>}
                </div>
              </button>
              {profile.gameVersions && profile.gameVersions.length > 1 && <div className="game-profile-version-control"><select className="setting-input" aria-label={`${displayName} game version`} value={profile.gameVersion} onChange={(event) => onVersionChange(profile.profileId, event.target.value)}>{profile.gameVersions.map((version) => <option key={version} value={version}>{version === "UE5.5" ? "Unreal Engine 5.5 (current)" : version === "UE4.27" ? "Unreal Engine 4.27 (legacy)" : version}</option>)}</select></div>}
              <button
                className="game-profile-menu-button"
                type="button"
                aria-label={`${displayName} profile actions`}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuProfileId((current) => current === profile.profileId ? null : profile.profileId);
                }}
              >
                ...
              </button>
              {menuOpen && (
                <div className="game-profile-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onOpenProfileSettings(profile.profileId); }}>View Details</button>
                  <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onOpenProfileSettings(profile.profileId); }}>Profile Settings</button>
                  {profile.profileType === "builtin_official" ? (
                    appCapabilities.canEditOfficialProfiles ? (
                      <>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onEditProfile(profile.profileId); }}>Edit Official Profile</button>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onEditProfile(profile.profileId); }}>Validate in Creator</button>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onEditProfile(profile.profileId); }}>Test in Creator</button>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void exportProfile(profile); }}>Export Official Draft</button>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onEditProfile(profile.profileId); }}>Use Official Draft Locally</button>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDuplicateProfile(profile.profileId); }}>Duplicate as Custom</button>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void invoke("open_game_profile_data_folder", { profileId: profile.profileId }).catch((error) => setNotice(String(error))); }}>Open Profile Folder</button>
                      </>
                    ) : (
                      <>
                        <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDuplicateProfile(profile.profileId); }}>Duplicate as Custom</button>
                        {profile.allowNormalUserExport && <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void exportProfile(profile); }}>Export Profile</button>}
                      </>
                    )
                  ) : profile.profileType === "community" ? (
                    <>
                      <button type="button" role="menuitem" disabled title="No community profile update service is configured.">Check for Updates</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDuplicateProfile(profile.profileId); }}>Duplicate as Custom</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void exportProfile(profile); }}>Export</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDeleteDraft(profile.profileId); }}>Remove</button>
                    </>
                  ) : profile.lifecycleState === "draft" ? (
                    <>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onEditProfile(profile.profileId); }}>Continue Setup</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDuplicateProfile(profile.profileId); }}>Duplicate Draft</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDeleteDraft(profile.profileId); }}>Delete Draft</button>
                    </>
                  ) : (
                    <>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); onEditProfile(profile.profileId); }}>Edit Profile</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDuplicateProfile(profile.profileId); }}>Duplicate</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void exportProfile(profile); }}>Export</button>
                      <button type="button" role="menuitem" onClick={() => { setMenuProfileId(null); void onDeleteDraft(profile.profileId); }}>Delete</button>
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}

              {group.id === "not-installed" && (
                <button className="game-profile-card portrait add-game-card" type="button" onClick={() => setAddDialogOpen(true)}>
                  <span className="add-game-plus">+</span>
                  <strong>Add Game</strong>
                  <small>Create or Import</small>
                </button>
              )}
            </div>
          </section>
        ))}
      </div>

      {notice && <div className="game-selector-toast" role="status">{notice}</div>}

      {addDialogOpen && (
        <div className="modal-backdrop game-profile-dialog-backdrop" role="presentation" onMouseDown={() => setAddDialogOpen(false)}>
          <section className="card add-game-dialog" role="dialog" aria-modal="true" aria-labelledby="add-game-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="add-game-dialog-header">
              <div>
                <p className="eyebrow">Add Game Profile</p>
                <h2 id="add-game-title">Add Game Profile</h2>
              </div>
              <button className="ghost-button compact" type="button" onClick={() => setAddDialogOpen(false)}>Close</button>
            </div>
            <button className="add-game-choice" type="button" onClick={onCreateProfile}>
              <strong>Create New Profile</strong>
              <span>Build support for a game manually.</span>
            </button>
            <button className="add-game-choice" type="button" onClick={() => void importProfile()}>
              <strong>Import Profile File</strong>
              <span>Install a local .tsukiprofile file.</span>
            </button>
            <button className="add-game-choice" type="button" onClick={() => showUnavailable("browse")}>
              <strong>Browse Community Profiles</strong>
              <span>Find a profile made by another user.</span>
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
