import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState, type ClipboardEvent, type Dispatch, type DragEvent, type ReactNode, type SetStateAction } from "react";
import { ProfileArtwork, logProfileArtwork } from "../../components/ProfileArtwork";
import { DependencyActions, DependencyName } from "../../components/DependencyActions";
import { dependenciesForProfile } from "../../models/dependency";
import type { GameProfile, GameProfileType } from "../../models/gameProfiles";
import { noneProfileImageReference, normalizeProfileImageReference, profileImageHasValue, type ProfileImageReference } from "../../models/profileArtwork";
import { canonicalModWorkshopRoute, canonicalModWorkshopUrl } from "../../models/profileSources";
import { safeLocalStorageSet } from "../../utils/browserStorage";

type SaveState = "saved" | "saving" | "unsaved" | "error";
type Mode = "guided" | "advanced";
type IssueLevel = "error" | "warning" | "suggestion" | "untested";
type SectionId = "gameArtwork" | "detectionStores" | "pathsLaunch" | "sources" | "modTypes" | "installBehavior" | "enableDisable" | "loadOrder" | "dependencies" | "conflicts" | "updatesUninstall" | "taxonomy" | "advancedRules" | "testProfile" | "reviewExport";
type CustomFileTypeKind = "common" | "custom_extension" | "filename_pattern" | "folder_based" | "paired_file_set" | "advanced_empty";
type ModTypePresetId = "pak" | "win64" | "blt" | "mod_override" | "reframework_script" | "beardlib_content" | "loose_file" | "streaming_asset" | "custom";
type ProfileTemplateId = "blank" | "unreal" | "superblt" | "reframework" | "bepinex" | "unity" | "custom";
type ExtensionGroupMode = "any" | "all_paired" | "optional_companions";
type FileMatchMode = "any" | "all" | "exact_file" | "folder" | "whole_folder" | "same_basename" | "custom";
type FileCatalogKind = "extension" | "exact" | "folder";
type DisableRecipeId = "move_folder" | "move_files" | "suffix_files" | "move_and_suffix" | "rename_main_file" | "config_value" | "loader_controlled" | "unsupported" | "custom";
type DisabledFolderLocation = "inside_install_folder" | "selected_mods_folder" | "game_folder" | "profile_disabled_storage" | "choose_another_folder" | "custom_path";
type RenameBehavior = "after_filename" | "before_extension" | "replace_extension" | "custom_suffix" | "custom_rule";
type ToggleMoveMode = "whole_folder" | "tracked_files" | "auto";
type DisableConflictBehavior = "ask" | "replace_same_receipt" | "numbered_name" | "stop_error";
type FolderSuffixTarget = "folder" | "files" | "folder_and_files";
type SectionStatus = "notConfigured" | "configured" | "untested" | "tested" | "warning" | "error";
type EditorTarget = { section: SectionId; index: number; custom?: boolean } | null;
type SelectorMode = "folder" | "file" | "executable" | "archive" | "image" | "markerFile" | "markerFolder" | "dependencyFile";

interface ProfileRuntimeIssue {
  level: "error" | "warning" | string;
  code: string;
  message: string;
  section?: SectionId | string | null;
}

interface ProfileRuntimeOpenResult {
  profileId: string;
  storagePath: string;
  profilePath: string;
  draftPath: string;
  setupStatePath: string;
  indexPath: string;
  testWorkspacePath: string;
  blocking: ProfileRuntimeIssue[];
  warnings: ProfileRuntimeIssue[];
  revision: number;
  openedAtUnix: number;
  previewSetup: boolean;
}

interface ProfileCreatorRuntimeTestResult {
  status: string;
  whatWasTested: string;
  inputUsed: string[];
  resolvedPaths: string[];
  actions: string[];
  warnings: string[];
  errors: string[];
  technicalDetails: string[];
  profileRevision: number;
  outdated: boolean;
}

interface Props {
  sourceProfile?: GameProfile | null;
  canEditOfficialProfiles?: boolean;
  onDraftSaved?: () => void | Promise<void>;
  onOpenProfile?: (profileId: string, options: { previewSetup: boolean; activeSection: SectionId; result: ProfileRuntimeOpenResult }) => void | Promise<void>;
  onBack: () => void;
}

interface ProfileArtworkImportResult {
  imageReference: ProfileImageReference;
  sourcePath: string;
  sourceExists: boolean;
  managedPath: string;
  managedExists: boolean;
}

interface GameFolderScanExecutable {
  fileName: string;
  path: string;
  relativePath: string;
  sizeBytes?: number;
  score?: number;
}

interface GameFolderScanFolder {
  name: string;
  path: string;
  relativePath: string;
}

interface GameFolderScanResult {
  gameFolder: string;
  suggestedGameName: string;
  executables: GameFolderScanExecutable[];
  suggestedExecutable?: GameFolderScanExecutable | null;
  folders: GameFolderScanFolder[];
  frameworks: string[];
  steamAppIds: string[];
  architectureHints: string[];
  visitedEntries?: number;
}
interface Field {
  label: string;
  value: string;
}

interface Item {
  id: string;
  title: string;
  enabled?: boolean;
  summary: string;
  fields: Field[];
  chips?: string[];
}

interface SourceTestResult {
  status: "Connected" | "Failed" | string;
  message: string;
  userMessage?: string | null;
  user_message?: string | null;
  technicalDetails?: string | null;
  technical_details?: string | null;
  sourceType?: string | null;
  source_type?: string | null;
  reachable?: boolean;
  authenticated?: boolean;
  mappingValid?: boolean;
  mapping_valid?: boolean;
  final_url?: string | null;
  http_status?: number | null;
  statusCode?: number | null;
  status_code?: number | null;
}

interface CustomPath {
  id: string;
  name: string;
  baseRoot: string;
  relativePath: string;
  required: boolean;
  createIfMissing: boolean;
  writable: boolean;
  description: string;
  userPrompt?: string;
  validationMarkers?: string;
}

interface CustomFileType {
  id: string;
  name: string;
  kind: CustomFileTypeKind;
  presetId?: ModTypePresetId;
  description?: string;
  extension: string;
  extensions: string[];
  filenamePattern: string;
  folderMarker: string;
  exactFilenames?: string[];
  folderMarkers?: string[];
  fileMatchMode?: FileMatchMode;
  customMatchRule?: string;
  companionPattern: string;
  pairedRequired: boolean;
  caseSensitive: boolean;
  allowMultipleExtensions: boolean;
  extensionGroupMode: ExtensionGroupMode;
  destination: string;
  preserveStructure: boolean;
  flattenWrapper: boolean;
  enableDisableStrategy: string;
  disableRecipeId?: DisableRecipeId;
  disabledFolderLocation?: DisabledFolderLocation;
  disabledFolderName?: string;
  renameBehavior?: RenameBehavior;
  customDisableSuffix?: string;
  customRenameRule?: string;
  toggleMoveMode?: ToggleMoveMode;
  folderSuffixTarget?: FolderSuffixTarget;
  disableConflictBehavior?: DisableConflictBehavior;
  createDisabledFolder?: boolean;
  preserveDisabledStructure?: boolean;
  trackDisabledMapping?: boolean;
  moveEmptyParents?: boolean;
  restoreExactPaths?: boolean;
  removeDisabledFolderWhenEmpty?: boolean;
  disabledFolderPath?: string;
  loadOrderStrategy: string;
  requiredDependency: string;
  conflictPolicy: string;
  conditions: string;
  priority: number;
  confidence: number;
}

interface Draft {
  schemaVersion: number;
  profileId: string;
  profileType: GameProfileType;
  status: "draft" | "official_draft" | "official_release_candidate";
  lifecycleState?: "draft" | "official" | "installed" | "community" | "disabled";
  setupStatus?: "incomplete" | "ready" | "setup_required" | "disabled" | "error";
  createdAt?: string;
  updatedAt: string;
  overview: Record<string, string>;
  artwork: { imageUrl: string; imageReference: ProfileImageReference; originalPath?: string; managedPath?: string; resolvedPreviewUrl?: string; objectFit: "cover" | "contain"; focalX: number; focalY: number; scale: number };
  sections: Record<SectionId, Item[]>;
  customPaths: CustomPath[];
  customFileTypes: CustomFileType[];
  unknownFileFallback: string;
  customTest: { sampleFilename: string; sampleArchive: string; sampleGameRoot: string };
  advancedJson: string;
  testOutput: string[];
}

const sectionInfo: Array<{ id: SectionId; label: string; subtitle: string }> = [
  ["gameArtwork", "Game & Artwork", "Identity, artwork, profile card preview, and public metadata."],
  ["detectionStores", "Detection & Stores", "Storefront IDs, executable checks, and marker folders."],
  ["pathsLaunch", "Paths & Launch", "Variables, destinations, launch methods, and pre-launch checks."],
  ["sources", "Sources", "Browse, search, metadata, categories, and download handling."],
  ["modTypes", "Mod Types", "Supported installable mod shapes, custom file types, and destinations."],
  ["installBehavior", "Install Behavior", "Preset-based install routing that keeps receipt tracking safe."],
  ["enableDisable", "Enable & Disable", "Receipt-safe strategies for fast toggles."],
  ["loadOrder", "Load Order", "Ordering methods, priority layers, and paired-file grouping."],
  ["dependencies", "Dependencies", "Frameworks, loaders, repair rules, and uninstall policy."],
  ["conflicts", "Conflicts", "Same-destination, exclusive group, compatibility, and overwrite rules."],
  ["updatesUninstall", "Updates & Uninstall", "Lifecycle policy and rollback guarantees."],
  ["taxonomy", "Tags & Categories", "Source taxonomy, aliases, colors, and custom tags."],
  ["advancedRules", "Advanced Rules", "Approved actions, raw rules, registries, and permissions."],
  ["testProfile", "Test Profile", "Dry-run workspace for detection, install, custom type matching, toggle, update, uninstall, and rollback."],
  ["reviewExport", "Review & Export", "Readiness summary, validation, and export."],
].map(([id, label, subtitle]) => ({ id: id as SectionId, label, subtitle }));

const guidedSectionIds: SectionId[] = [
  "gameArtwork",
  "detectionStores",
  "pathsLaunch",
  "sources",
  "modTypes",
  "installBehavior",
  "enableDisable",
  "testProfile",
  "reviewExport",
];

const guidedSectionCopy: Partial<Record<SectionId, { label: string; subtitle: string }>> = {
  gameArtwork: { label: "Game", subtitle: "Name the profile and choose its artwork." },
  detectionStores: { label: "Find Game", subtitle: "Tell Tsuki how to locate the installed game." },
  pathsLaunch: { label: "Folders & Launch", subtitle: "Confirm the game folder, mod folders, and launch target." },
  sources: { label: "Mod Sources", subtitle: "Choose where this profile browses and downloads mods." },
  modTypes: { label: "Mod Types", subtitle: "Choose the mod formats this game accepts." },
  installBehavior: { label: "Install Rules", subtitle: "Set where matching mod files are installed." },
  enableDisable: { label: "Enable & Disable", subtitle: "Choose how installed mods are safely turned on and off." },
  testProfile: { label: "Test", subtitle: "Dry-run the profile before using it with real files." },
  reviewExport: { label: "Finish", subtitle: "Review required fixes and prepare the profile for use." },
};

const glossary = [
  "Game root: installed game folder",
  "Marker: required file or folder check",
  "Mod type: supported mod shape",
  "Custom path: approved profile-scoped destination variable",
  "Receipt: tracked install record",
  "Rollback: undo plan for tracked files",
  "Taxonomy: categories, tags, aliases, and colors",
  "Manifest: structured state file",
];

const templates = ["Unreal PAK", "PAK + UTOC + UCAS", "UE4SS Mod", "UE4SS Lua Script", "REFramework Script", "REFramework Plugin", "BepInEx Plugin", "Loose Files", "DLL Loader", "Config Mod", "Custom Declarative Type"];

type ProfileSourceType = "nexus" | "modworkshop" | "embedded" | "github" | "local" | "direct_catalog" | "custom_browser";

type SourceEditorState = {
  mode: "add" | "edit";
  index: number | null;
  draft: Item;
  original?: Item;
  dirty: boolean;
  duplicateOf?: Item | null;
  allowDuplicate?: boolean;
  message?: string;
};

type ItemEditorState = {
  mode: "add" | "edit";
  section: SectionId;
  index: number | null;
  draft: Item;
  dirty: boolean;
  saveLabel: string;
};

type CustomPathEditorState = {
  mode: "add" | "edit";
  index: number | null;
  draft: CustomPath;
  dirty: boolean;
};

type CustomTypeEditorState = {
  mode: "add" | "edit";
  index: number | null;
  draft: CustomFileType;
  dirty: boolean;
};

const sourceTypeOptions: Array<{ value: ProfileSourceType; label: string; description: string }> = [
  { value: "nexus", label: "Nexus Mods", description: "Map this profile to one Nexus game/domain." },
  { value: "modworkshop", label: "ModWorkshop", description: "Map this profile to one ModWorkshop game." },
  { value: "github", label: "GitHub Releases", description: "Read public releases from one repository." },
  { value: "embedded", label: "Embedded Website", description: "Open a protected source page in Tsuki." },
  { value: "local", label: "Local Files", description: "Allow picker, folder, and drag/drop installs." },
  { value: "direct_catalog", label: "Direct Catalog", description: "Read a structured catalog URL." },
  { value: "custom_browser", label: "Custom Browser Source", description: "Define custom browser and capture rules." },
];

const sourceCapabilities = ["Browse listings", "Search", "Mod details", "Categories", "Descriptive tags", "File downloads", "Version/update checks", "Authentication integration"];

const sourceDefaultCapabilities: Record<ProfileSourceType, string[]> = {
  nexus: ["Browse listings", "Search", "Mod details", "Categories", "File downloads", "Version/update checks", "Authentication integration"],
  modworkshop: ["Browse listings", "Search", "Mod details", "Categories", "Descriptive tags", "File downloads", "Version/update checks"],
  embedded: ["Browse listings", "File downloads"],
  github: ["Mod details", "File downloads", "Version/update checks"],
  local: ["File downloads"],
  direct_catalog: ["Browse listings", "Mod details", "File downloads", "Version/update checks"],
  custom_browser: ["Browse listings", "File downloads", "Authentication integration"],
};
const dependencyPresets = ["REFramework", "RED4ext", "redscript", "ArchiveXL", "TweakXL", "Codeware", "Cyber Engine Tweaks", "UE4SS", "BepInEx", "MelonLoader", "SuperBLT", "BeardLib", "Logic Mod Loader", "DLL Loader", "Script Hook", "Custom Dependency"];
const detectionPresets = ["Select Game Folder", "Steam", "Epic", "GOG", "Microsoft Store", "Standalone", "Custom Detection"];
const installRulePresets = ["Copy Matching Files", "Copy Whole Folder", "Preserve Folder Structure", "Flatten Wrapper Folder", "Merge Into Destination", "Back Up and Replace", "Ignore Matching Files", "Custom Install Rule"];
const conflictRulePresets = ["Ask User", "Back Up and Replace", "Block Install", "Keep Existing", "Prefer New Mod", "Allow Side by Side", "Exclusive Group", "Custom Conflict Rule"];
const versionRulePresets = ["Any compatible version", "Latest version", "Minimum version", "Exact version", "Version range", "Custom rule"];const approvedRoots = ["game_root", "game_exe_dir", "profile_data", "profile_disabled_storage", "profile_backup_storage", "profile_cache", "documents", "appdata", "localappdata", "user_selected_folder"];
const builtInExtensions = [".pak", ".utoc", ".ucas", ".dll", ".lua", ".ini", ".json", ".zip", ".rar", ".7z"];

type DependencyDownloadSourceType = "manual" | "nexus" | "modworkshop" | "github" | "direct" | "included" | "custom";

type ParsedDependencySource = {
  sourceType: DependencyDownloadSourceType;
  pageUrl: string;
  gameDomain?: string;
  gameSlug?: string;
  gameId?: string;
  modId?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  releaseChannel?: string;
};

const dependencyPresetDetails: Record<string, { kind: string; description: string; markers: string[]; folders: string[]; installMethod: string; destination: string; sourceType: DependencyDownloadSourceType; setupGroup: string; requires?: string[] }> = {
  REFramework: { kind: "Framework", description: "Framework required by REFramework scripts and plugins.", markers: ["dinput8.dll"], folders: ["reframework"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "github", setupGroup: "Mod-type dependency" },
  RED4ext: { kind: "Framework", description: "Cyberpunk 2077 script extender framework used by many Cyberpunk mods.", markers: ["RED4ext.dll"], folders: ["red4ext"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "github", setupGroup: "Core dependency" },
  redscript: { kind: "Library", description: "Script compiler/runtime dependency used by Cyberpunk script mods.", markers: ["redscript.dll"], folders: ["r6/scripts"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "github", setupGroup: "Mod-type dependency", requires: ["RED4ext"] },
  ArchiveXL: { kind: "Library", description: "Archive extension library required by ArchiveXL content mods.", markers: ["ArchiveXL.archive"], folders: ["archive/pc/mod"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "nexus", setupGroup: "Recommended dependency", requires: ["RED4ext"] },
  TweakXL: { kind: "Library", description: "Tweak database extension library required by TweakXL mods.", markers: ["TweakXL.archive"], folders: ["r6/tweaks"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "nexus", setupGroup: "Recommended dependency", requires: ["RED4ext"] },
  Codeware: { kind: "Library", description: "Codeware library used by Cyberpunk gameplay and UI mods.", markers: ["Codeware.archive"], folders: ["red4ext/plugins/Codeware"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "nexus", setupGroup: "Recommended dependency", requires: ["RED4ext"] },
  "Cyber Engine Tweaks": { kind: "Tool", description: "Cyber Engine Tweaks loader/tool required by CET mods.", markers: ["cyber_engine_tweaks.asi"], folders: ["bin/x64/plugins/cyber_engine_tweaks"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "github", setupGroup: "Recommended dependency" },
  UE4SS: { kind: "Loader", description: "Unreal Engine scripting loader used by UE4SS mods.", markers: ["UE4SS.dll", "xinput1_3.dll", "UE4SS-settings.ini"], folders: ["Mods"], installMethod: "Use dependency preset", destination: "${GAME_EXE_DIR}", sourceType: "github", setupGroup: "Mod-type dependency" },
  BepInEx: { kind: "Framework", description: "Unity plugin framework required by BepInEx plugins and patchers.", markers: ["winhttp.dll", "doorstop_config.ini"], folders: ["BepInEx"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "github", setupGroup: "Mod-type dependency" },
  MelonLoader: { kind: "Loader", description: "Unity loader required by MelonLoader mods.", markers: ["version.dll", "MelonLoader.dll"], folders: ["MelonLoader", "Mods"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "github", setupGroup: "Mod-type dependency" },
  SuperBLT: { kind: "Loader", description: "PAYDAY loader required by BLT and BeardLib mods.", markers: ["IPHLPAPI.dll", "WSOCK32.dll"], folders: ["mods"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "modworkshop", setupGroup: "Mod-type dependency" },
  BeardLib: { kind: "Supporting Mod", description: "Supporting mod required by BeardLib content.", markers: ["main.xml", "mod.txt"], folders: ["mods/BeardLib"], installMethod: "Use dependency preset", destination: "${GAME_ROOT}/mods", sourceType: "modworkshop", setupGroup: "Mod-type dependency", requires: ["SuperBLT"] },
  "Logic Mod Loader": { kind: "Loader", description: "Logic Mod Loader required by PD3 logic mods.", markers: ["LogicModLoader.dll"], folders: ["LogicMods"], installMethod: "Use dependency preset", destination: "${GAME_EXE_DIR}", sourceType: "modworkshop", setupGroup: "Mod-type dependency" },
  "DLL Loader": { kind: "Loader", description: "Generic DLL loader dependency with explicit markers and purpose.", markers: [], folders: [], installMethod: "Use dependency preset", destination: "${GAME_EXE_DIR}", sourceType: "manual", setupGroup: "Mod-type dependency" },
  "Script Hook": { kind: "Loader", description: "Script Hook style loader dependency for script mods.", markers: [], folders: [], installMethod: "Use dependency preset", destination: "${GAME_ROOT}", sourceType: "github", setupGroup: "Mod-type dependency" },
  "Custom Dependency": { kind: "Custom", description: "Custom loader, framework, library, tool, or supporting mod.", markers: [], folders: [], installMethod: "Custom install rules", destination: "", sourceType: "manual", setupGroup: "Recommended dependency" },
};

const dependencyRequiredOptions = ["Required for profile", "Required by Mod Type", "Optional / Recommended", "Dependency of another dependency"];
const dependencyDetectionOptions = ["Known dependency preset", "File exists", "Folder exists", "Any selected marker exists", "All selected markers exist", "Custom detection"];
const dependencySourceOptions: Array<{ value: DependencyDownloadSourceType; label: string; description: string }> = [
  { value: "nexus", label: "Nexus Mods Page", description: "Use public Nexus identifiers and the user's global Nexus connection." },
  { value: "modworkshop", label: "ModWorkshop Page", description: "Use ModWorkshop's public API. No personal key is stored or requested." },
  { value: "github", label: "GitHub Repository / Releases", description: "Use GitHub releases and ignore source-code archives by default." },
  { value: "direct", label: "Direct Approved Download", description: "Use a fixed public download URL with optional version/checksum metadata." },
  { value: "included", label: "Included With Profile", description: "Dependency files are bundled with an approved profile package." },
  { value: "manual", label: "User Installs Manually", description: "Tsuki detects the dependency and shows instructions, but does not download it." },
  { value: "custom", label: "Custom Source", description: "Advanced source resolver metadata for maintainers." },
];
const dependencyInstallOptions = ["Use dependency preset", "Install archive contents to Game Root", "Install to Executable Folder", "Install to Named Path", "Browse Destination", "Custom install rules"];
const dependencyReleaseChannels = ["Latest stable", "Latest prerelease", "Specific release", "Custom tag pattern"];
const dependencyFileSelectionModes = ["Latest compatible main file", "First matching archive", "Asset matching dependency name", "Asset matching extension", "Custom filename pattern", "Ask user when multiple files match"];

type ModTypePreset = {
  id: ModTypePresetId;
  label: string;
  description: string;
  name: string;
  kind: CustomFileTypeKind;
  extension: string;
  extensions: string[];
  filenamePattern: string;
  folderMarker: string;
  exactFilenames?: string[];
  folderMarkers?: string[];
  fileMatchMode?: FileMatchMode;
  customMatchRule?: string;
  companionPattern: string;
  pairedRequired: boolean;
  allowMultipleExtensions: boolean;
  extensionGroupMode: ExtensionGroupMode;
  destination: string;
  preserveStructure: boolean;
  flattenWrapper: boolean;
  enableDisableStrategy: string;
  disableRecipeId?: DisableRecipeId;
  disabledFolderLocation?: DisabledFolderLocation;
  disabledFolderName?: string;
  renameBehavior?: RenameBehavior;
  customDisableSuffix?: string;
  customRenameRule?: string;
  toggleMoveMode?: ToggleMoveMode;
  folderSuffixTarget?: FolderSuffixTarget;
  disableConflictBehavior?: DisableConflictBehavior;
  createDisabledFolder?: boolean;
  preserveDisabledStructure?: boolean;
  trackDisabledMapping?: boolean;
  moveEmptyParents?: boolean;
  restoreExactPaths?: boolean;
  removeDisabledFolderWhenEmpty?: boolean;
  disabledFolderPath?: string;
  loadOrderStrategy: string;
  requiredDependency: string;
  conflictPolicy: string;
  conditions: string;
  priority: number;
};

const defaultReceiptToggle = "Move tracked files to disabled storage; restore by moving them back to the destination.";
const defaultInstallBehavior = "Copy matched files to the selected destination and track every written file in the receipt.";

const modTypePresets: ModTypePreset[] = [
  { id: "pak", label: "PAK Mod", description: "Unreal PAK files, with optional UTOC/UCAS companion files.", name: "PAK Mod", kind: "custom_extension", extension: ".pak", extensions: [".utoc", ".ucas"], filenamePattern: "", folderMarker: "", companionPattern: ".utoc|.ucas", pairedRequired: false, allowMultipleExtensions: true, extensionGroupMode: "optional_companions", destination: "${GAME_ROOT}/Content/Paks/~mods", preserveStructure: false, flattenWrapper: true, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Filename order", requiredDependency: "", conflictPolicy: "Ask user on same destination file", conditions: defaultInstallBehavior, priority: 500 },
  { id: "win64", label: "Win64 Mod", description: "DLL, ASI, INI, or script files that live beside the game executable.", name: "Win64 Mod", kind: "custom_extension", extension: ".dll", extensions: [".asi", ".ini", ".lua"], filenamePattern: "", folderMarker: "", companionPattern: "", pairedRequired: false, allowMultipleExtensions: true, extensionGroupMode: "any", destination: "${GAME_EXE_DIR}", preserveStructure: true, flattenWrapper: true, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Priority layer", requiredDependency: "", conflictPolicy: "Warn and allow overwrite with backup", conditions: defaultInstallBehavior, priority: 300 },
  { id: "blt", label: "BLT Mod", description: "SuperBLT or BLT folder mods detected by common manifest files.", name: "BLT Mod", kind: "folder_based", extension: "", extensions: [], filenamePattern: "", folderMarker: "mod.txt|main.lua|main.xml", companionPattern: "", pairedRequired: false, allowMultipleExtensions: false, extensionGroupMode: "any", destination: "${GAME_ROOT}/mods", preserveStructure: true, flattenWrapper: true, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Loader manifest", requiredDependency: "SuperBLT", conflictPolicy: "Ask user on same destination file", conditions: defaultInstallBehavior, priority: 500 },
  { id: "mod_override", label: "Mod Override", description: "Asset override folders that merge into a game or loader override directory.", name: "Mod Override", kind: "folder_based", extension: "", extensions: [], filenamePattern: "", folderMarker: "mod_overrides|assets|main.xml", companionPattern: "", pairedRequired: false, allowMultipleExtensions: false, extensionGroupMode: "any", destination: "${GAME_ROOT}/assets/mod_overrides", preserveStructure: true, flattenWrapper: true, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Filename order", requiredDependency: "", conflictPolicy: "Ask user on same destination file", conditions: "Merge matched folders into the selected override destination and track receipt ownership.", priority: 600 },
  { id: "reframework_script", label: "REFramework Script", description: "Lua scripts installed into REFramework autorun.", name: "REFramework Script", kind: "custom_extension", extension: ".lua", extensions: [], filenamePattern: "", folderMarker: "", companionPattern: "", pairedRequired: false, allowMultipleExtensions: false, extensionGroupMode: "any", destination: "${GAME_ROOT}/reframework/autorun", preserveStructure: false, flattenWrapper: true, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Loader manifest", requiredDependency: "REFramework", conflictPolicy: "Ask user on same destination file", conditions: defaultInstallBehavior, priority: 500 },
  { id: "beardlib_content", label: "BeardLib Content", description: "BeardLib folders detected by main.xml or mod metadata files.", name: "BeardLib Content", kind: "folder_based", extension: "", extensions: [], filenamePattern: "", folderMarker: "main.xml|mod.txt", companionPattern: "", pairedRequired: false, allowMultipleExtensions: false, extensionGroupMode: "any", destination: "${GAME_ROOT}/mods", preserveStructure: true, flattenWrapper: true, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Loader manifest", requiredDependency: "BeardLib", conflictPolicy: "Ask user on same destination file", conditions: defaultInstallBehavior, priority: 500 },
  { id: "loose_file", label: "Loose File Mod", description: "Loose files or folders copied into an approved game destination.", name: "Loose File Mod", kind: "filename_pattern", extension: "", extensions: [], filenamePattern: "**/*", folderMarker: "", companionPattern: "", pairedRequired: false, allowMultipleExtensions: false, extensionGroupMode: "any", destination: "${GAME_ROOT}", preserveStructure: true, flattenWrapper: false, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Keep archive order", requiredDependency: "", conflictPolicy: "Ask user on same destination file", conditions: defaultInstallBehavior, priority: 10 },
  { id: "streaming_asset", label: "Streaming Asset Mod", description: "Unity StreamingAssets content installed into the matching asset folder.", name: "Streaming Asset Mod", kind: "folder_based", extension: "", extensions: [], filenamePattern: "", folderMarker: "StreamingAssets|streamingassets", companionPattern: "", pairedRequired: false, allowMultipleExtensions: false, extensionGroupMode: "any", destination: "${GAME_ROOT}/StreamingAssets", preserveStructure: true, flattenWrapper: true, enableDisableStrategy: defaultReceiptToggle, loadOrderStrategy: "Keep archive order", requiredDependency: "", conflictPolicy: "Warn and allow overwrite with backup", conditions: defaultInstallBehavior, priority: 600 },
  { id: "custom", label: "Custom Mod Type", description: "Start empty and define the files, destination, dependency, and behavior yourself.", name: "", kind: "custom_extension", extension: "", extensions: [], filenamePattern: "", folderMarker: "", companionPattern: "", pairedRequired: false, allowMultipleExtensions: false, extensionGroupMode: "any", destination: "", preserveStructure: false, flattenWrapper: false, enableDisableStrategy: "", loadOrderStrategy: "", requiredDependency: "", conflictPolicy: "", conditions: "", priority: 500 },
];

const modTypePresetOptions = modTypePresets.map((preset) => ({ value: preset.id, label: preset.label, description: preset.description }));
const profileTemplateOptions: Array<{ value: ProfileTemplateId; label: string; description: string }> = [
  { value: "blank", label: "Blank Profile", description: "Start with an empty document and add only what you choose." },
  { value: "unreal", label: "Unreal Engine Mod Support", description: "Suggested PAK, Win64, and loose-file support." },
  { value: "superblt", label: "SuperBLT / BLT Mod Support", description: "Suggested BLT folders, BeardLib content, and override folders." },
  { value: "reframework", label: "REFramework Mod Support", description: "Suggested REFramework scripts, plugins, and loose files." },
  { value: "bepinex", label: "BepInEx Mod Support", description: "Suggested Unity plugin loader support." },
  { value: "unity", label: "Unity Mod Support", description: "Suggested StreamingAssets and loose-file content support." },
  { value: "custom", label: "Custom Profile", description: "Open the blank editor and build everything manually." },
];

function modTypePresetById(presetId: ModTypePresetId | undefined) {
  return modTypePresets.find((preset) => preset.id === presetId) ?? modTypePresets[modTypePresets.length - 1];
}

function selectedModTypePresetId(fileType: CustomFileType): ModTypePresetId {
  if (fileType.presetId) return fileType.presetId;
  const marker = fileType.conditions.match(/^Preset:\s*(.+)$/m)?.[1]?.trim();
  return (modTypePresets.find((preset) => preset.label === marker || preset.name === marker)?.id ?? "custom") as ModTypePresetId;
}

function applyModTypePreset(fileType: CustomFileType, presetId: ModTypePresetId): CustomFileType {
  const preset = modTypePresetById(presetId);
  if (preset.id === "custom") return { ...fileType, presetId: "custom", description: fileType.description ?? "" };
  const presetMarkers = splitMarkerList(preset.folderMarker);
  const exactFilenames = presetMarkers.filter((marker) => /\.[a-z0-9_-]+$/i.test(marker) && !marker.includes("/"));
  const folderMarkers = presetMarkers.filter((marker) => !exactFilenames.includes(marker));
  return {
    ...fileType,
    presetId: preset.id,
    name: preset.name,
    description: preset.description,
    kind: preset.kind,
    extension: preset.extension,
    extensions: [...preset.extensions],
    filenamePattern: preset.filenamePattern,
    folderMarker: folderMarkers.join("|"),
    exactFilenames,
    folderMarkers,
    fileMatchMode: preset.kind === "folder_based" ? "folder" : preset.kind === "filename_pattern" ? "custom" : preset.extensionGroupMode === "all_paired" ? "same_basename" : "any",
    customMatchRule: "",
    companionPattern: preset.companionPattern,
    pairedRequired: preset.pairedRequired,
    caseSensitive: false,
    allowMultipleExtensions: preset.allowMultipleExtensions || preset.extensions.length > 0,
    extensionGroupMode: preset.extensionGroupMode,
    destination: preset.destination,
    preserveStructure: preset.preserveStructure,
    flattenWrapper: preset.flattenWrapper,
    enableDisableStrategy: preset.enableDisableStrategy,
    disableRecipeId: "move_files",
    disabledFolderLocation: "profile_disabled_storage",
    disabledFolderName: "disabled",
    renameBehavior: "after_filename",
    customDisableSuffix: ".disabled",
    customRenameRule: "",
    toggleMoveMode: "tracked_files",
    folderSuffixTarget: "files",
    disableConflictBehavior: "replace_same_receipt",
    createDisabledFolder: true,
    preserveDisabledStructure: true,
    trackDisabledMapping: true,
    moveEmptyParents: false,
    restoreExactPaths: true,
    removeDisabledFolderWhenEmpty: true,
    disabledFolderPath: "",
    loadOrderStrategy: preset.loadOrderStrategy,
    requiredDependency: preset.requiredDependency,
    conflictPolicy: preset.conflictPolicy,
    conditions: `Preset: ${preset.label}\n${preset.conditions}`,
    priority: preset.priority,
    confidence: 100,
  };
}

function modTypeSummary(fileType: CustomFileType) {
  const preset = modTypePresetById(selectedModTypePresetId(fileType));
  if (preset.id !== "custom") return preset.description;
  return fileType.description || `${fileTypeKindOptions.find((option) => option.value === fileType.kind)?.label ?? "Custom"} mod type.`;
}

function item(id: string, title: string, summary: string, fields: Field[] = [], chips: string[] = [], enabled = true): Item {
  return { id, title, summary, fields, chips, enabled };
}

function safeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function pathVariableId(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "CUSTOM_PATH";
}

function makeUserId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pathVariable(path: CustomPath) {
  return "${PATH:" + path.id + "}";
}

function normalizeExtensionInput(value: string, caseSensitive = false) {
  const raw = value.trim();
  if (!raw) return "";
  let clean = raw;
  if (clean.startsWith("*.")) clean = clean.slice(2);
  else if (clean.startsWith(".")) clean = clean.slice(1);
  if (!caseSensitive) clean = clean.toLowerCase();
  return clean ? `.${clean}` : "";
}

function extensionErrors(value: string) {
  const raw = value.trim();
  const canonical = normalizeExtensionInput(raw);
  const errors: string[] = [];
  if (!raw) errors.push("Extension is required.");
  if (/[\\/]/.test(raw)) errors.push("Extension cannot contain path separators.");
  if (raw.includes("*") && !raw.startsWith("*.")) errors.push("Use Custom Filename Pattern for glob syntax.");
  if (raw === "*" || raw === "*." || raw === "*.*") errors.push("Wildcard-only values are not valid extensions.");
  if (/[ :]/.test(raw) || /^[a-z]:/i.test(raw)) errors.push("Extension cannot contain destination paths or command text.");
  if (raw.length > 64) errors.push("Extension is too long.");
  if (canonical && !/^\.[a-z0-9][a-z0-9._-]*$/i.test(canonical)) errors.push("Extension contains unsafe characters.");
  return errors;
}

function globWarning(pattern: string) {
  const raw = pattern.trim();
  if (!raw) return "Pattern is required.";
  if (["*", "*.*", "**"].includes(raw)) return "Pattern is overly broad and will match almost everything.";
  if (/^[a-z]:/i.test(raw) || raw.includes("..")) return "Pattern must not contain paths outside the archive.";
  return "";
}

function destinationErrors(destination: string, paths: CustomPath[]) {
  const raw = destination.trim();
  const errors: string[] = [];
  if (!raw) errors.push("Destination is required.");
  if (raw.includes("..")) errors.push("Destination must not contain path traversal.");
  if (/^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\") || raw.startsWith("/")) errors.push("Use an approved root variable instead of an unrestricted absolute path.");
  const pathMatch = raw.match(/^\$\{PATH:([A-Z0-9_]+)\}/);
  if (pathMatch && !paths.some((path) => path.id === pathMatch[1])) errors.push(`Custom path ${pathMatch[1]} is not defined.`);
  const approved = raw.startsWith("${GAME_ROOT}") || raw.startsWith("${GAME_EXE_DIR}") || raw.startsWith("${DOCUMENTS}") || raw.startsWith("${APP_DATA}") || raw.startsWith("${LOCAL_APP_DATA}") || raw.startsWith("${USER_SELECTED_PATH:") || Boolean(pathMatch);
  if (raw && !approved) errors.push("Destination must resolve through an approved root.");
  return errors;
}

function rootPreview(root: string, sampleRoot: string) {
  const gameRoot = sampleRoot.trim() || "C:/SelectedGame";
  const map: Record<string, string> = {
    game_root: gameRoot,
    game_exe_dir: `${gameRoot}/ExecutableFolder`,
    profile_data: "C:/Users/You/AppData/Roaming/Tsuki/game_profiles",
    profile_disabled_storage: `${gameRoot}/Tsuki_Disabled_Mods`,
    profile_backup_storage: `${gameRoot}/Tsuki_Backups`,
    profile_cache: "C:/Users/You/AppData/Roaming/Tsuki/cache",
    documents: "C:/Users/You/Documents",
    appdata: "C:/Users/You/AppData/Roaming/Tsuki",
    localappdata: "C:/Users/You/AppData/Local",
    user_selected_folder: "C:/UserSelectedFolder",
  };
  return map[root] ?? gameRoot;
}

function formatFriendlyPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("${")) return trimmed;
  let normalized = trimmed;
  if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  if (normalized.startsWith("\\\\.\\")) normalized = normalized.slice(4);
  normalized = normalized.replace(/[\\/]+/g, "\\");
  return normalized.replace(/^([A-Za-z]:)\\+/, "$1\\");
}
function resolvePathPreview(path: CustomPath, sampleRoot: string) {
  const relative = path.relativePath.trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
  const selectedRoot = path.baseRoot === "user_selected_folder" && /^[a-z]:[\\/]/i.test(path.userPrompt ?? "")
    ? path.userPrompt!.trim()
    : rootPreview(path.baseRoot, sampleRoot);
  return formatFriendlyPath(relative ? `${selectedRoot}/${relative}` : selectedRoot);
}

function resolvePathExpression(destination: string, paths: CustomPath[], sampleRoot: string) {
  let base = destination.trim();
  const pathMatch = base.match(/^\$\{PATH:([A-Z0-9_]+)\}/);
  if (pathMatch) {
    const custom = paths.find((path) => path.id === pathMatch[1]);
    if (custom) base = resolvePathPreview(custom, sampleRoot) + base.slice(pathMatch[0].length);
  } else {
    base = base
      .replace("${GAME_ROOT}", rootPreview("game_root", sampleRoot))
      .replace("${GAME_EXE_DIR}", rootPreview("game_exe_dir", sampleRoot))
      .replace("${DOCUMENTS}", rootPreview("documents", sampleRoot))
      .replace("${APP_DATA}", rootPreview("appdata", sampleRoot))
      .replace("${LOCAL_APP_DATA}", rootPreview("localappdata", sampleRoot));
  }
  return formatFriendlyPath(base);
}

function resolveDestination(destination: string, paths: CustomPath[], fileName: string, preserveStructure: boolean, sampleRoot: string) {
  const base = resolvePathExpression(destination, paths, sampleRoot);
  const cleanFile = fileName.replace(/\\/g, "/").split("/").filter(Boolean);
  const targetName = preserveStructure ? cleanFile.join("/") : cleanFile[cleanFile.length - 1] || fileName;
  return formatFriendlyPath(base && targetName ? `${base.replace(/[\\/]$/, "")}/${targetName}` : base || targetName);
}

function globToRegExp(pattern: string, caseSensitive: boolean) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "::DOUBLE_STAR::").replace(/\*/g, "[^/]*").replace(/::DOUBLE_STAR::/g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, caseSensitive ? "" : "i");
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    if (!value) return false;
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitMarkerList(value: string) {
  return value.split("|").map((marker) => marker.trim()).filter(Boolean);
}

function normalizeExactFilename(value: string, caseSensitive = false) {
  const raw = fileNameFromPath(value.trim().replace(/\\/g, "/"));
  if (!raw || raw.includes("/") || raw.includes("\\")) return "";
  return caseSensitive ? raw : raw.toLowerCase();
}

function normalizeFolderMarker(value: string, caseSensitive = false) {
  const raw = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!raw || raw.includes("..")) return "";
  return caseSensitive ? raw : raw.toLowerCase();
}

function selectedFileExtensions(fileType: CustomFileType) {
  return uniqueStrings([fileType.extension, ...(fileType.extensions ?? [])]
    .map((value) => normalizeExtensionInput(value, fileType.caseSensitive))
    .filter(Boolean));
}

function selectedExactFilenames(fileType: CustomFileType) {
  return uniqueStrings([...(fileType.exactFilenames ?? [])]
    .map((value) => normalizeExactFilename(value, fileType.caseSensitive))
    .filter(Boolean));
}

function selectedFolderMarkers(fileType: CustomFileType) {
  return uniqueStrings([...(fileType.folderMarkers ?? []), ...splitMarkerList(fileType.folderMarker)]
    .map((value) => normalizeFolderMarker(value, fileType.caseSensitive))
    .filter(Boolean));
}

function fileTypePatterns(fileType: CustomFileType) {
  const extensions = selectedFileExtensions(fileType).map((extension) => `*${extension}`);
  const exactFiles = selectedExactFilenames(fileType).map((name) => `file named ${name}`);
  const folderMarkers = selectedFolderMarkers(fileType).map((marker) => `folder containing ${marker}`);
  const patterns = [...extensions, ...exactFiles, ...folderMarkers];
  const filenamePattern = fileType.filenamePattern.trim();
  const customRule = fileType.customMatchRule?.trim() ?? "";
  if (filenamePattern) patterns.push(filenamePattern);
  if (customRule) patterns.push(customRule);
  if (fileType.kind === "paired_file_set" && fileType.companionPattern.trim()) patterns.push(`companion ${fileType.companionPattern.trim()}`);
  return patterns.length ? patterns : [fileType.name || "No matcher configured"];
}

function markerMatchesPath(marker: string, cleanSample: string, caseSensitive: boolean) {
  const haystack = caseSensitive ? cleanSample : cleanSample.toLowerCase();
  const needle = caseSensitive ? marker : marker.toLowerCase();
  if (needle.includes("/")) return haystack.includes(needle);
  const segments = haystack.split("/").filter(Boolean);
  return segments.includes(needle) || haystack.includes(`/${needle}/`) || haystack.endsWith(`/${needle}`);
}

function matchFileType(fileType: CustomFileType, sample: string) {
  const cleanSample = sample.trim().replace(/\\/g, "/");
  if (!cleanSample) return false;
  const compare = fileType.caseSensitive ? cleanSample : cleanSample.toLowerCase();
  const leaf = compare.split("/").pop() ?? compare;
  const extensions = selectedFileExtensions(fileType);
  const exactFiles = selectedExactFilenames(fileType);
  const folderMarkers = selectedFolderMarkers(fileType);
  const extensionMatches = extensions.some((extension) => compare.endsWith(fileType.caseSensitive ? extension : extension.toLowerCase()));
  const exactMatches = exactFiles.some((name) => leaf === (fileType.caseSensitive ? name : name.toLowerCase()));
  const folderMatches = folderMarkers.some((marker) => markerMatchesPath(marker, cleanSample, fileType.caseSensitive));
  const filenamePattern = fileType.filenamePattern.trim();
  const customPattern = fileType.customMatchRule?.trim() ?? "";
  const patternMatches = [filenamePattern, customPattern].some((pattern) => pattern && !globWarning(pattern) && globToRegExp(pattern, fileType.caseSensitive).test(cleanSample));
  const mode = fileType.fileMatchMode ?? (fileType.kind === "folder_based" ? "folder" : fileType.kind === "filename_pattern" ? "custom" : fileType.kind === "paired_file_set" ? "same_basename" : "any");
  if (mode === "exact_file") return exactMatches || patternMatches;
  if (mode === "folder" || mode === "whole_folder") return folderMatches;
  if (mode === "custom") return patternMatches;
  return extensionMatches || exactMatches || folderMatches || patternMatches;
}

function customFileTypeIssues(fileType: CustomFileType, paths: CustomPath[]) {
  const issues: Array<{ level: IssueLevel; text: string }> = [];
  const rawExtensions = [fileType.extension, ...(fileType.extensions ?? [])].map((value) => value.trim()).filter(Boolean);
  const extensions = selectedFileExtensions(fileType);
  const exactFiles = selectedExactFilenames(fileType);
  const folderMarkers = selectedFolderMarkers(fileType);
  const filenamePattern = fileType.filenamePattern.trim();
  const customRule = fileType.customMatchRule?.trim() ?? "";
  if (!fileType.name.trim()) issues.push({ level: "error", text: "Custom file type needs a display name." });
  if (!extensions.length && !exactFiles.length && !folderMarkers.length && !filenamePattern && !customRule) issues.push({ level: "error", text: "Choose at least one file extension, exact filename, folder marker, or custom match rule." });
  for (const extension of rawExtensions) {
    for (const error of extensionErrors(extension)) issues.push({ level: "error", text: error });
  }
  for (const extension of extensions) {
    if (builtInExtensions.includes(extension)) issues.push({ level: "warning", text: `${extension} also exists in the known file catalog.` });
  }
  for (const name of fileType.exactFilenames ?? []) {
    if (!normalizeExactFilename(name, fileType.caseSensitive)) issues.push({ level: "error", text: `Exact filename is invalid: ${name}` });
  }
  for (const marker of [...(fileType.folderMarkers ?? []), ...splitMarkerList(fileType.folderMarker)]) {
    if (!normalizeFolderMarker(marker, fileType.caseSensitive)) issues.push({ level: "error", text: `Folder marker is invalid: ${marker}` });
  }
  if (filenamePattern) {
    const warning = globWarning(filenamePattern);
    if (warning) issues.push({ level: warning.includes("required") ? "error" : "warning", text: warning });
  }
  if (customRule) {
    const warning = globWarning(customRule);
    if (warning) issues.push({ level: warning.includes("required") ? "error" : "warning", text: warning });
  }
  if (fileType.kind === "paired_file_set" && fileType.pairedRequired && !fileType.companionPattern.trim()) issues.push({ level: "error", text: "Required paired file set needs a companion pattern." });
  for (const error of destinationErrors(fileType.destination, paths)) issues.push({ level: "error", text: error });
  if (!fileType.enableDisableStrategy.trim()) issues.push({ level: "warning", text: "Enable/disable strategy is missing." });
  if (!/restore|move back|reversible|generated/i.test(fileType.enableDisableStrategy)) issues.push({ level: "suggestion", text: "Explain how this strategy reverses disable/enable operations." });
  return issues;
}

function customPathIssues(path: CustomPath) {
  const issues: Array<{ level: IssueLevel; text: string }> = [];
  if (!path.name.trim()) issues.push({ level: "error", text: "Custom path needs a name." });
  if (!approvedRoots.includes(path.baseRoot)) issues.push({ level: "error", text: "Custom path base root is not approved." });
  if (path.relativePath.includes("..")) issues.push({ level: "error", text: "Custom path cannot contain path traversal." });
  if (/^[a-z]:[\\/]/i.test(path.relativePath) || path.relativePath.startsWith("/") || path.relativePath.startsWith("\\")) issues.push({ level: "error", text: "Custom path relative path must not be absolute." });
  if (path.baseRoot === "user_selected_folder" && !path.userPrompt?.trim()) issues.push({ level: "warning", text: "User Selected Folder roots should include an end-user prompt." });
  return issues;
}

function makeCustomPath(): CustomPath {
  return { id: `CUSTOM_PATH_${Date.now()}`, name: "", baseRoot: "game_root", relativePath: "", required: false, createIfMissing: true, writable: true, description: "", userPrompt: "", validationMarkers: "" };
}

function makeCustomFileType(kind: CustomFileTypeKind = "custom_extension", presetId: ModTypePresetId = "custom"): CustomFileType {
  const base: CustomFileType = {
    id: `custom_${Date.now()}`,
    name: "",
    kind,
    presetId,
    description: "",
    extension: "",
    extensions: [],
    filenamePattern: "",
    folderMarker: "",
    exactFilenames: [],
    folderMarkers: [],
    fileMatchMode: kind === "folder_based" ? "folder" : kind === "filename_pattern" ? "custom" : kind === "paired_file_set" ? "same_basename" : "any",
    customMatchRule: "",
    companionPattern: "",
    pairedRequired: kind === "paired_file_set",
    caseSensitive: false,
    allowMultipleExtensions: false,
    extensionGroupMode: kind === "paired_file_set" ? "all_paired" : "any",
    destination: "",
    preserveStructure: false,
    flattenWrapper: false,
    enableDisableStrategy: "",
    disableRecipeId: "move_files",
    disabledFolderLocation: "profile_disabled_storage",
    disabledFolderName: "disabled",
    renameBehavior: "after_filename",
    customDisableSuffix: ".disabled",
    customRenameRule: "",
    toggleMoveMode: "tracked_files",
    folderSuffixTarget: "files",
    disableConflictBehavior: "replace_same_receipt",
    createDisabledFolder: true,
    preserveDisabledStructure: true,
    trackDisabledMapping: true,
    moveEmptyParents: false,
    restoreExactPaths: true,
    removeDisabledFolderWhenEmpty: true,
    disabledFolderPath: "",
    loadOrderStrategy: "",
    requiredDependency: "",
    conflictPolicy: "",
    conditions: "",
    priority: 500,
    confidence: 100,
  };
  return presetId === "custom" ? base : applyModTypePreset(base, presetId);
}

function makeInstallRule(): Item {
  return item(`install-${Date.now()}`, "New Install Rule", "Describe when files should install and how receipts should track them.", [
    { label: "Conditions", value: "" },
    { label: "Actions", value: "" },
    { label: "Destination", value: "" },
    { label: "Overwrite", value: "" },
    { label: "Preserve structure", value: "" },
    { label: "Track receipt ownership", value: "" },
  ]);
}

function makeToggleStrategy(): Item {
  return item(`toggle-${Date.now()}`, "New Toggle Strategy", "Choose a receipt-safe disable recipe. Enable behavior is generated automatically.", [
    { label: "Mod Type", value: "" },
    { label: "Disable Recipe", value: "move_files" },
    { label: "Disable Method", value: "Move Every Installed File" },
    { label: "Enable Method", value: generatedEnableBehavior("move_files") },
    { label: "Destination", value: "" },
    { label: "Disabled Folder Location", value: "profile_disabled_storage" },
    { label: "Disabled Folder Name", value: "disabled" },
    { label: "Rename Behavior", value: "after_filename" },
    { label: "Disable Custom Suffix", value: ".disabled" },
    { label: "Move Mode", value: "tracked_files" },
    { label: "Folder Suffix Target", value: "files" },
    { label: "Disable Conflict", value: "replace_same_receipt" },
    { label: "Create Disabled Folder", value: "Yes" },
    { label: "Preserve Disabled Structure", value: "Yes" },
    { label: "Track Disabled Mapping", value: "Yes" },
    { label: "Move Empty Parent Folders", value: "No" },
    { label: "Restore Exact Paths", value: "Yes" },
    { label: "Remove Disabled Folder When Empty", value: "Yes" },
    { label: "Receipt Mapping", value: "originalPath|disabledPath|originalFilename|disabledFilename|receiptId" },
  ]);
}

function makeDetectionMethod(): Item {
  return item(`detection-${Date.now()}`, "New Detection Method", "Describe how Tsuki recognizes this game installation.", [
    { label: "Detection Type", value: "" },
    { label: "Root Folder", value: "" },
    { label: "Expected executable", value: "" },
    { label: "Required markers", value: "" },
    { label: "Condition mode", value: "" },
  ]);
}

function makeDependency(type = "Custom Dependency"): Item {
  const preset = dependencyPresetDetails[type] ?? dependencyPresetDetails["Custom Dependency"];
  const base = item(`dependency-${Date.now()}`, type, preset.description, [
    { label: "Dependency Type", value: type },
    { label: "Dependency Kind", value: preset.kind },
    { label: "Dependency ID", value: safeKey(type) || "custom-dependency" },
    { label: "Required", value: preset.setupGroup === "Core dependency" ? "Required for profile" : preset.setupGroup === "Mod-type dependency" ? "Required by Mod Type" : "Optional / Recommended" },
    { label: "Setup Group", value: preset.setupGroup },
    { label: "Detection Method", value: "Known dependency preset" },
    { label: "Marker File", value: preset.markers[0] ?? "" },
    { label: "Marker Folder", value: preset.folders[0] ?? "" },
    { label: "Marker Filenames", value: preset.markers.join("|") },
    { label: "Marker Folders", value: preset.folders.join("|") },
    { label: "Version Requirement", value: "Any compatible version" },
    { label: "Minimum Version", value: "" },
    { label: "Maximum Version", value: "" },
    { label: "Exact Version", value: "" },
    { label: "Version Range", value: "" },
    { label: "Blocked Versions", value: "" },
    { label: "Game Version Compatibility", value: "" },
    { label: "Download Source Type", value: preset.sourceType },
    { label: "Dependency Page URL", value: "" },
    { label: "Nexus Game Domain", value: "" },
    { label: "Nexus Mod ID", value: "" },
    { label: "ModWorkshop Game ID", value: "" },
    { label: "ModWorkshop Game Slug", value: "" },
    { label: "ModWorkshop Mod ID", value: "" },
    { label: "GitHub Owner", value: "" },
    { label: "GitHub Repository", value: "" },
    { label: "GitHub Release Channel", value: "Latest stable" },
    { label: "Specific Release", value: "" },
    { label: "File Selection Mode", value: "Latest compatible main file" },
    { label: "Include Asset Patterns", value: "" },
    { label: "Exclude Asset Patterns", value: "source code|src|source-code" },
    { label: "Direct Download URL", value: "" },
    { label: "Version Endpoint", value: "" },
    { label: "Checksum", value: "" },
    { label: "Install Method", value: preset.installMethod },
    { label: "Installer or archive", value: "" },
    { label: "Destination", value: preset.destination },
    { label: "Preserve Config", value: "Yes" },
    { label: "Create Dependency Receipt", value: "Yes" },
    { label: "Requires Dependencies", value: (preset.requires ?? []).join("|") },
    { label: "Used By", value: "" },
    { label: "Update Policy", value: "Preserve compatible installed versions unless user requests update" },
    { label: "Repair Action", value: "Redownload selected compatible release and restore missing tracked files" },
    { label: "Uninstall Policy", value: "Check dependents first; remove only dependency receipt-owned files" },
    { label: "Removal Safety", value: "Block unsafe removal until dependent mods, mod types, and dependencies are reviewed" },
    { label: "Manual Install Instructions", value: "" },
    { label: "Dependency Source JSON", value: "" },
    { label: "Dependency Resolver", value: "latest compatible release; prompt when file selection is ambiguous" },
    { label: "Permission Summary", value: "Download from public source, copy tracked files under approved destination, create receipt, preserve config; cannot run shell commands or store credentials" },
  ], [preset.kind, preset.setupGroup]);
  return normalizeDependencyItem(base);
}

function makeConflictRule(preset = "Ask User"): Item {
  return item(`conflict-${Date.now()}`, preset === "Custom Conflict Rule" ? "Custom Conflict Rule" : preset, "Define what Tsuki should do when mods target the same files or cannot coexist.", [
    { label: "Conflict Type", value: preset },
    { label: "Condition", value: "Same destination or exclusive group" },
    { label: "Resolution", value: preset },
    { label: "Policy", value: "Ask before changing installed files" },
  ]);
}

function templatePath(id: string, name: string, relativePath: string): CustomPath {
  return { id, name, baseRoot: "game_root", relativePath, required: false, createIfMissing: true, writable: true, description: `${name} suggested by the starting template.`, userPrompt: "", validationMarkers: "" };
}

function templateInstallRule(id: string, title: string, preset: string, destination: string): Item {
  return item(`template-${id}`, title, `Suggested ${preset.toLowerCase()} install behavior.`, [
    { label: "Rule Preset", value: preset },
    { label: "Conditions", value: "For selected Mod Type" },
    { label: "Actions", value: preset },
    { label: "Destination", value: destination },
    { label: "Track receipt ownership", value: "Yes" },
    { label: "Preserve structure", value: "Yes" },
  ]);
}

function templateToggleStrategy(id: string, title: string): Item {
  return item(`template-toggle-${id}`, title, "Suggested receipt-safe enable and disable behavior.", [
    { label: "Mod Type", value: title },
    { label: "Disable Recipe", value: "move_files" },
    { label: "Disable Method", value: "Move Every Installed File" },
    { label: "Enable Method", value: generatedEnableBehavior("move_files") },
    { label: "Destination", value: "" },
    { label: "Disabled Folder Location", value: "profile_disabled_storage" },
    { label: "Disabled Folder Name", value: "disabled" },
    { label: "Rename Behavior", value: "after_filename" },
    { label: "Disable Custom Suffix", value: ".disabled" },
    { label: "Move Mode", value: "tracked_files" },
    { label: "Disable Conflict", value: "replace_same_receipt" },
    { label: "Receipt Mapping", value: "originalPath|disabledPath|originalFilename|disabledFilename|receiptId" },
  ]);
}

function profileTemplateAdditions(templateId: ProfileTemplateId) {
  const none = { customPaths: [] as CustomPath[], customFileTypes: [] as CustomFileType[], dependencies: [] as Item[], installBehavior: [] as Item[], enableDisable: [] as Item[], loadOrder: [] as Item[] };
  if (templateId === "blank" || templateId === "custom") return none;
  if (templateId === "unreal") return {
    customPaths: [templatePath("PAKS", "Paks", "Content/Paks"), templatePath("MODS", "~mods", "Content/Paks/~mods"), templatePath("WIN64", "Win64", "Binaries/Win64"), templatePath("DISABLED_MODS", "Disabled Mods", "Tsuki_Disabled_Mods"), templatePath("BACKUPS", "Backups", "Tsuki_Backups")],
    customFileTypes: [makeCustomFileType("custom_extension", "pak"), makeCustomFileType("custom_extension", "win64")],
    dependencies: [makeDependency("UE4SS"), makeDependency("DLL Loader")],
    installBehavior: [templateInstallRule("pak", "PAK-family files", "Copy Matching Files", "${PATH:MODS}"), templateInstallRule("win64", "Runtime files", "Back Up and Replace", "${PATH:WIN64}"), templateInstallRule("loose", "Loose files", "Preserve Folder Structure", "${GAME_ROOT}")],
    enableDisable: [templateToggleStrategy("pak", "PAK Mod"), templateToggleStrategy("win64", "Win64 Mod")],
    loadOrder: [item("template-unreal-load-order", "Unreal Load Order", "PAK files usually use filename order. Runtime loader files use high priority.", [{ label: "Method", value: "Filename order and priority layers" }])],
  };
  if (templateId === "superblt") return {
    customPaths: [templatePath("MODS", "Mods", "mods"), templatePath("MOD_OVERRIDES", "Mod Overrides", "assets/mod_overrides"), templatePath("DISABLED_MODS", "Disabled Mods", "Tsuki_Disabled_Mods"), templatePath("BACKUPS", "Backups", "Tsuki_Backups")],
    customFileTypes: [makeCustomFileType("folder_based", "blt"), makeCustomFileType("folder_based", "beardlib_content"), makeCustomFileType("folder_based", "mod_override"), makeCustomFileType("custom_extension", "win64")],
    dependencies: [makeDependency("SuperBLT"), makeDependency("BeardLib")],
    installBehavior: [templateInstallRule("blt", "Complete BLT folders", "Copy Whole Folder", "${PATH:MODS}"), templateInstallRule("override", "Override folders", "Merge Into Destination", "${PATH:MOD_OVERRIDES}"), templateInstallRule("loader", "Loader DLLs", "Back Up and Replace", "${GAME_ROOT}")],
    enableDisable: [templateToggleStrategy("blt", "BLT Mod"), templateToggleStrategy("beardlib", "BeardLib Content")],
    loadOrder: [],
  };
  if (templateId === "reframework") return {
    customPaths: [templatePath("REFRAMEWORK", "REFramework", "reframework"), templatePath("AUTORUN", "Autorun", "reframework/autorun"), templatePath("PLUGINS", "Plugins", "reframework/plugins"), templatePath("DISABLED_MODS", "Disabled Mods", "Tsuki_Disabled_Mods")],
    customFileTypes: [makeCustomFileType("custom_extension", "reframework_script"), makeCustomFileType("custom_extension", "win64")],
    dependencies: [makeDependency("REFramework")],
    installBehavior: [templateInstallRule("reframework", "REFramework scripts", "Copy Matching Files", "${PATH:AUTORUN}"), templateInstallRule("plugins", "REFramework plugins", "Copy Matching Files", "${PATH:PLUGINS}")],
    enableDisable: [templateToggleStrategy("reframework", "REFramework Script")],
    loadOrder: [],
  };
  if (templateId === "bepinex") return {
    customPaths: [templatePath("BEPINEX", "BepInEx", "BepInEx"), templatePath("BEPINEX_PLUGINS", "BepInEx Plugins", "BepInEx/plugins"), templatePath("DISABLED_MODS", "Disabled Mods", "Tsuki_Disabled_Mods")],
    customFileTypes: [makeCustomFileType("custom_extension", "win64")],
    dependencies: [makeDependency("BepInEx")],
    installBehavior: [templateInstallRule("bepinex", "BepInEx plugins", "Copy Matching Files", "${PATH:BEPINEX_PLUGINS}")],
    enableDisable: [templateToggleStrategy("bepinex", "Win64 Mod")],
    loadOrder: [],
  };
  return {
    customPaths: [templatePath("STREAMING_ASSETS", "StreamingAssets", "StreamingAssets"), templatePath("CONTENT", "Content", "Content"), templatePath("DISABLED_MODS", "Disabled Mods", "Tsuki_Disabled_Mods")],
    customFileTypes: [makeCustomFileType("folder_based", "streaming_asset"), makeCustomFileType("filename_pattern", "loose_file"), makeCustomFileType("custom_extension", "pak")],
    dependencies: [],
    installBehavior: [templateInstallRule("streaming", "Streaming asset content", "Preserve Folder Structure", "${PATH:STREAMING_ASSETS}"), templateInstallRule("loose-content", "Loose content", "Back Up and Replace", "${PATH:CONTENT}")],
    enableDisable: [templateToggleStrategy("streaming", "Streaming Asset Mod")],
    loadOrder: [],
  };
}
function cloneItemForDuplicate(entry: Item): Item {
  return { ...entry, id: `${entry.id}-copy-${makeUserId()}`, title: `${entry.title || "Item"} Copy`, fields: entry.fields.map((field) => ({ ...field })), chips: [...(entry.chips ?? [])] };
}

function cloneCustomPath(path: CustomPath): CustomPath {
  const name = `${path.name || "Named Path"} Copy`;
  return { ...path, id: pathVariableId(name), name };
}

function cloneCustomFileType(fileType: CustomFileType): CustomFileType {
  return { ...fileType, id: `custom_${makeUserId()}`, name: `${fileType.name || "Custom Mod Type"} Copy`, extensions: [...fileType.extensions], exactFilenames: [...(fileType.exactFilenames ?? [])], folderMarkers: [...(fileType.folderMarkers ?? [])] };
}

function canonicalSourceType(value: string): ProfileSourceType {
  const lower = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (lower.includes("nexus")) return "nexus";
  if (lower.includes("modworkshop") || lower === "mw") return "modworkshop";
  if (lower.includes("github")) return "github";
  if (lower.includes("local")) return "local";
  if (lower.includes("direct") || lower.includes("catalog")) return "direct_catalog";
  if (lower.includes("custom") && lower.includes("browser")) return "custom_browser";
  if (lower.includes("embedded") || lower.includes("website")) return "embedded";
  return "custom_browser";
}

function sourceTypeLabel(type: ProfileSourceType) {
  return sourceTypeOptions.find((option) => option.value === type)?.label ?? "Custom Browser Source";
}

function sourceTypeFromItem(entry: Item): ProfileSourceType {
  return canonicalSourceType(fieldValue(entry, "Source Type") || entry.title);
}

function sourceInstanceId(entry: Item) {
  return fieldValue(entry, "Source Instance ID") || entry.id;
}

function sourceField(label: string, value = ""): Field {
  return { label, value };
}

const NEXUS_ALLOWED_DOMAINS = "nexusmods.com, www.nexusmods.com, staticdelivery.nexusmods.com, users.nexusmods.com";
const MODWORKSHOP_ALLOWED_DOMAINS = "modworkshop.net, www.modworkshop.net, storage.modworkshop.net, api.modworkshop.net";

function sourceFieldsForType(sourceType: ProfileSourceType, instanceId: string): Field[] {
  const base = [
    sourceField("Source Instance ID", instanceId),
    sourceField("Source Type", sourceType),
    sourceField("Display Name", sourceTypeLabel(sourceType)),
    sourceField("Capabilities", sourceDefaultCapabilities[sourceType].join("|")),
    sourceField("Last Test Status", "Untested"),
    sourceField("Last Tested", ""),
    sourceField("Last Test Message", ""),
    sourceField("Last Test URL", ""),
    sourceField("Last Test HTTP Status", ""),
    sourceField("Last Test Details", ""),
  ];

  if (sourceType === "nexus") return [
    ...base,
    sourceField("Search Nexus Games"),
    sourceField("Human Game Name"),
    sourceField("Nexus Domain"),
    sourceField("Nexus Game ID"),
    sourceField("Nexus Game Page URL"),
    sourceField("Nexus Category URL"),
    sourceField("Embedded Start URL"),
    sourceField("Allowed Domains", NEXUS_ALLOWED_DOMAINS),
    sourceField("Browse Mode", "Built-in/API"),
    sourceField("Capture Downloads", "Yes"),
    sourceField("API Enabled State", "Enabled"),
    sourceField("API Key Source", "Global Settings"),
    sourceField("Update Checking", "Enabled"),
    sourceField("Authentication/API Status", "Uses global settings"),
  ];
  if (sourceType === "modworkshop") return [
    ...base,
    sourceField("Search ModWorkshop Games"),
    sourceField("Human Game Name"),
    sourceField("ModWorkshop Slug"),
    sourceField("ModWorkshop Game ID"),
    sourceField("ModWorkshop Game Page URL"),
    sourceField("ModWorkshop Category URL"),
    sourceField("Embedded Start URL"),
    sourceField("Allowed Domains", MODWORKSHOP_ALLOWED_DOMAINS),
    sourceField("Browse Mode", "Built-in/API"),
    sourceField("Capture Downloads", "Yes"),
    sourceField("API Enabled State", "Enabled"),
    sourceField("API Key Source", "Global Settings"),
  ];
  if (sourceType === "embedded") return [...base, sourceField("Starting Page URL"), sourceField("Allowed Domains"), sourceField("Current-Game URL Patterns"), sourceField("Download Capture", "Prompt before download"), sourceField("Cross-Game Protection", "Enabled"), sourceField("Login Required", "No")];
  if (sourceType === "github") return [...base, sourceField("Repository URL"), sourceField("Repository Owner"), sourceField("Repository Name"), sourceField("Release Channel", "Latest stable"), sourceField("Fixed Tag"), sourceField("Custom Tag Pattern"), sourceField("Asset Selection", "First matching release archive"), sourceField("Include Asset Patterns"), sourceField("Exclude Asset Patterns", "Source code (zip)|Source code (tar.gz)|source-code|source_code"), sourceField("Accepted Extensions", ".zip|.7z|.rar|.dll"), sourceField("Version Parsing", "Release tag"), sourceField("Update Checking", "Enabled")];
  if (sourceType === "local") return [...base, sourceField("Allow Drag and Drop", "Yes"), sourceField("Allow File Picker", "Yes"), sourceField("Allow Folder Picker", "No"), sourceField("Accepted Extensions", ".zip|.7z|.rar|.pak|.dll|.lua|.ini"), sourceField("Unmatched File Behavior", "Show install preview")];
  if (sourceType === "direct_catalog") return [...base, sourceField("Catalog URL"), sourceField("Schema Version Field", "schemaVersion"), sourceField("Mod Name Field", "name"), sourceField("Download URL Field", "downloadUrl"), sourceField("Version Field", "version"), sourceField("Checksum Field", "sha256")];
  return [...base, sourceField("Allowed Domains"), sourceField("Start URL"), sourceField("Download Capture Rules"), sourceField("Game-Page Validation"), sourceField("Authentication Requirement", "Optional")];
}

interface ParsedNexusGameUrl {
  domain: string;
  normalizedUrl: string;
  isCategoryUrl: boolean;
}

interface ParsedModWorkshopGameUrl {
  slug: string;
  numericId: string;
  normalizedUrl: string;
  isCategoryUrl: boolean;
}

function withUrlProtocol(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(withUrlProtocol(value));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

function hostMatches(url: URL, suffix: string) {
  const host = url.hostname.toLowerCase();
  const clean = suffix.toLowerCase();
  return host === clean || host.endsWith(`.${clean}`);
}

function urlPathParts(url: URL) {
  return url.pathname.split("/").map((part) => decodeURIComponent(part.trim())).filter(Boolean);
}

function isNumericSourceId(value: string) {
  return /^\d+$/.test(value.trim());
}

function cleanSourceSlug(value: string) {
  const clean = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split(/[/?#]/)[0] ?? "";
  return isSafeDomainSlug(clean) && !clean.includes(" ") ? clean.toLowerCase() : "";
}

function parseNexusGameUrl(value: string): ParsedNexusGameUrl | null {
  const url = parseHttpUrl(value);
  if (!url || !hostMatches(url, "nexusmods.com")) return null;
  const parts = urlPathParts(url);
  const domainIndex = parts[0]?.toLowerCase() === "games" ? 1 : 0;
  const domain = cleanSourceSlug(parts[domainIndex] ?? "");
  if (!domain) return null;
  const isCategoryUrl = parts.length > domainIndex + 1 || Boolean(url.search);
  return { domain, normalizedUrl: url.toString(), isCategoryUrl };
}

function normalizeNexusDomainInput(value: string) {
  const raw = value.trim();
  if (!raw) return { domain: "", converted: false };
  const parsed = parseNexusGameUrl(raw);
  if (parsed) return { domain: parsed.domain, converted: parsed.domain !== raw };
  const withoutHost = raw.replace(/^www\.nexusmods\.com[\\/]/i, "").replace(/^nexusmods\.com[\\/]/i, "");
  const clean = cleanSourceSlug(withoutHost);
  return { domain: clean, converted: Boolean(clean) && clean !== raw };
}

function parseModWorkshopGameUrl(value: string): ParsedModWorkshopGameUrl | null {
  const url = parseHttpUrl(value);
  if (!url || !hostMatches(url, "modworkshop.net")) return null;
  const parts = urlPathParts(url);
  let slug = "";
  let numericId = "";

  const gameRouteIndex = parts.findIndex((part) => ["g", "game", "games"].includes(part.toLowerCase()));
  if (gameRouteIndex >= 0 && parts[gameRouteIndex + 1]) {
    const candidate = parts[gameRouteIndex + 1];
    if (isNumericSourceId(candidate)) numericId = candidate;
    else slug = canonicalModWorkshopRoute(cleanSourceSlug(candidate));
  }

  const queryGame = url.searchParams.get("game") || url.searchParams.get("game_id") || url.searchParams.get("gameId") || "";
  if (queryGame) {
    if (isNumericSourceId(queryGame) && !numericId) numericId = queryGame;
    else if (!slug) slug = canonicalModWorkshopRoute(cleanSourceSlug(queryGame));
  }

  if (!slug && !numericId) return null;
  return {
    slug,
    numericId,
    normalizedUrl: canonicalModWorkshopUrl(url.toString()),
    isCategoryUrl: parts.some((part) => /^categor/i.test(part)) || url.searchParams.has("category") || url.searchParams.has("category_id") || url.searchParams.has("tags") || url.searchParams.has("tag"),
  };
}

function sourceUrlMatchesHost(value: string, suffix: string) {
  const url = parseHttpUrl(value);
  return Boolean(url && hostMatches(url, suffix));
}

function setSourceFieldIfMissing(entry: Item, label: string, value?: string | null) {
  const clean = value?.trim() ?? "";
  if (!clean || sourceValue(entry, label)) return entry;
  return replaceField(entry, label, clean);
}

function parseGitHubSourceUrl(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  const clean = /^https?:\/\//i.test(raw) ? raw : raw.replace(/^(?:www\.)?github\.com\//i, "https://github.com/");
  try {
    const url = new URL(clean);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const tagIndex = parts.findIndex((part, index) => part.toLowerCase() === "tag" && index > 0);
    return {
      owner: parts[0],
      repository: parts[1].replace(/\.git$/i, ""),
      fixedTag: tagIndex >= 0 && parts[tagIndex + 1] ? decodeURIComponent(parts[tagIndex + 1]) : "",
      releaseChannel: tagIndex >= 0 ? "Specific tag" : "Latest stable",
    };
  } catch {
    return null;
  }
}

function firstSourceAlias(entry: Item, labels: string[]) {
  for (const label of labels) {
    const value = fieldValue(entry, label).trim();
    if (value) return value;
  }
  return "";
}

function normalizeSourceTechnicalFields(entry: Item) {
  const sourceType = sourceTypeFromItem(entry);
  let next = entry;

  if (sourceType === "nexus") {
    next = setSourceFieldIfMissing(next, "Human Game Name", firstSourceAlias(next, ["Selected Nexus Game", "Selected Game", "Game Name"]));
    next = setSourceFieldIfMissing(next, "Nexus Game Page URL", firstSourceAlias(next, ["Game Page URL", "Page URL"]));
    next = setSourceFieldIfMissing(next, "Nexus Category URL", firstSourceAlias(next, ["Category URL", "Mods URL"]));
    next = setSourceFieldIfMissing(next, "Embedded Start URL", firstSourceAlias(next, ["Start URL", "Starting Page URL"]));

    const domainInput = sourceValue(next, "Nexus Domain") || firstSourceAlias(next, ["Domain"]);
    const pageUrl = sourceValue(next, "Nexus Game Page URL");
    const categoryUrl = sourceValue(next, "Nexus Category URL");
    const startUrl = sourceValue(next, "Embedded Start URL");
    const gameId = sourceValue(next, "Nexus Game ID") || firstSourceAlias(next, ["Game ID", "Numeric Nexus Game ID"]);

    for (const candidate of [domainInput, pageUrl, categoryUrl, startUrl, gameId]) {
      const parsed = parseNexusGameUrl(candidate);
      if (!parsed) continue;
      next = setSourceFieldIfMissing(next, "Nexus Domain", parsed.domain);
      next = setSourceFieldIfMissing(next, parsed.isCategoryUrl ? "Nexus Category URL" : "Nexus Game Page URL", parsed.normalizedUrl);
      next = setSourceFieldIfMissing(next, "Embedded Start URL", parsed.normalizedUrl);
    }

    if (domainInput && !parseNexusGameUrl(domainInput)) {
      const normalized = normalizeNexusDomainInput(domainInput);
      if (normalized.domain) next = replaceField(next, "Nexus Domain", normalized.domain);
    }

    if (gameId) {
      const parsed = parseNexusGameUrl(gameId);
      if (parsed) {
        next = replaceField(next, "Nexus Game ID", "");
      } else if (isNumericSourceId(gameId)) {
        next = replaceField(next, "Nexus Game ID", gameId.trim());
      } else {
        const legacyDomain = cleanSourceSlug(gameId);
        if (legacyDomain) {
          next = setSourceFieldIfMissing(next, "Nexus Domain", legacyDomain);
          next = replaceField(next, "Nexus Game ID", "");
        }
      }
    }

    const domain = sourceValue(next, "Nexus Domain");
    if (domain) {
      next = setSourceFieldIfMissing(next, "Nexus Game Page URL", `https://www.nexusmods.com/${domain}`);
      next = setSourceFieldIfMissing(next, "Embedded Start URL", sourceValue(next, "Nexus Category URL") || sourceValue(next, "Nexus Game Page URL"));
    }
    next = setSourceFieldIfMissing(next, "Allowed Domains", NEXUS_ALLOWED_DOMAINS);
  }

  if (sourceType === "modworkshop") {
    next = setSourceFieldIfMissing(next, "Human Game Name", firstSourceAlias(next, ["Selected ModWorkshop Game", "Selected Game", "Game Name"]));
    next = setSourceFieldIfMissing(next, "ModWorkshop Game Page URL", firstSourceAlias(next, ["Game Page URL", "Page URL"]));
    next = setSourceFieldIfMissing(next, "ModWorkshop Category URL", firstSourceAlias(next, ["Category URL", "Mods URL"]));
    next = setSourceFieldIfMissing(next, "Embedded Start URL", firstSourceAlias(next, ["Start URL", "Starting Page URL"]));

    const pageUrl = sourceValue(next, "ModWorkshop Game Page URL");
    const categoryUrl = sourceValue(next, "ModWorkshop Category URL");
    const startUrl = sourceValue(next, "Embedded Start URL");
    const slug = sourceValue(next, "ModWorkshop Slug") || firstSourceAlias(next, ["Slug", "Game Slug"]);
    const gameId = sourceValue(next, "ModWorkshop Game ID") || firstSourceAlias(next, ["Game ID", "Numeric ModWorkshop Game ID"]);

    for (const candidate of [pageUrl, categoryUrl, startUrl, slug, gameId]) {
      const parsed = parseModWorkshopGameUrl(candidate);
      if (!parsed) continue;
      next = setSourceFieldIfMissing(next, "ModWorkshop Slug", parsed.slug);
      next = setSourceFieldIfMissing(next, "ModWorkshop Game ID", parsed.numericId);
      next = setSourceFieldIfMissing(next, parsed.isCategoryUrl ? "ModWorkshop Category URL" : "ModWorkshop Game Page URL", parsed.normalizedUrl);
      next = setSourceFieldIfMissing(next, "Embedded Start URL", parsed.normalizedUrl);
    }

    if (slug && !parseModWorkshopGameUrl(slug)) {
      const normalizedSlug = canonicalModWorkshopRoute(cleanSourceSlug(slug));
      if (normalizedSlug) next = replaceField(next, "ModWorkshop Slug", normalizedSlug);
    }

    if (gameId) {
      if (isNumericSourceId(gameId)) {
        next = replaceField(next, "ModWorkshop Game ID", gameId.trim());
      } else if (!parseModWorkshopGameUrl(gameId)) {
        const legacySlug = canonicalModWorkshopRoute(cleanSourceSlug(gameId));
        if (legacySlug) {
          next = setSourceFieldIfMissing(next, "ModWorkshop Slug", legacySlug);
          next = replaceField(next, "ModWorkshop Game ID", "");
        }
      }
    }

    for (const label of ["ModWorkshop Game Page URL", "ModWorkshop Category URL", "Embedded Start URL"]) {
      const value = sourceValue(next, label);
      if (value) next = replaceField(next, label, canonicalModWorkshopUrl(value));
    }

    const normalizedSlug = sourceValue(next, "ModWorkshop Slug");
    if (normalizedSlug) {
      next = setSourceFieldIfMissing(next, "ModWorkshop Game Page URL", `https://modworkshop.net/g/${normalizedSlug}/mods`);
      next = setSourceFieldIfMissing(next, "Embedded Start URL", sourceValue(next, "ModWorkshop Category URL") || sourceValue(next, "ModWorkshop Game Page URL"));
    }
    next = setSourceFieldIfMissing(next, "Allowed Domains", MODWORKSHOP_ALLOWED_DOMAINS);
  }

  if (sourceType === "github") {
    const repositoryUrl = sourceValue(next, "Repository URL") || firstSourceAlias(next, ["GitHub URL", "Page URL"]);
    if (repositoryUrl && !sourceValue(next, "Repository URL")) next = replaceField(next, "Repository URL", repositoryUrl);
    const parsed = parseGitHubSourceUrl(repositoryUrl);
    if (parsed) {
      if (!sourceValue(next, "Repository Owner")) next = replaceField(next, "Repository Owner", parsed.owner);
      if (!sourceValue(next, "Repository Name")) next = replaceField(next, "Repository Name", parsed.repository);
      if (parsed.fixedTag && !sourceValue(next, "Fixed Tag")) next = replaceField(next, "Fixed Tag", parsed.fixedTag);
      if (parsed.fixedTag) next = replaceField(next, "Release Channel", "Specific tag");
    }
  }

  return next;
}
function normalizeSourceItem(entry: Item, nextType?: ProfileSourceType): Item {
  entry = normalizeSourceTechnicalFields(entry);
  const sourceType = nextType ?? sourceTypeFromItem(entry);
  const instanceId = sourceInstanceId(entry).startsWith("source.") ? sourceInstanceId(entry) : `source.${makeUserId()}`;
  const defaults = sourceFieldsForType(sourceType, instanceId);
  const fields = defaults.map((defaultField) => {
    const existing = entry.fields.find((field) => field.label === defaultField.label);
    return existing ? { ...defaultField, value: existing.value } : defaultField;
  });
  const obsoleteAliases = new Set(
    sourceType === "nexus"
      ? ["Selected Nexus Game", "Selected Game", "Game Name", "Domain", "Game Page URL", "Page URL", "Category URL", "Mods URL", "Start URL", "Starting Page URL", "Numeric Nexus Game ID"]
      : sourceType === "modworkshop"
        ? ["Selected ModWorkshop Game", "Selected Game", "Game Name", "Game Page URL", "Page URL", "Category URL", "Mods URL", "Start URL", "Starting Page URL", "Slug", "Game Slug", "Numeric ModWorkshop Game ID"]
        : []
  );
  const extraFields = entry.fields.filter((field) => !fields.some((defaultField) => defaultField.label === field.label) && !obsoleteAliases.has(field.label));
  const displayName = fields.find((field) => field.label === "Display Name")?.value.trim() || sourceTypeLabel(sourceType);
  const capabilities = fields.find((field) => field.label === "Capabilities")?.value.split("|").filter(Boolean) ?? [];
  return {
    ...entry,
    id: instanceId,
    title: displayName,
    summary: sourceMappingSummary({ ...entry, fields: [...fields, ...extraFields] }, sourceType),
    fields: [...fields, ...extraFields],
    chips: capabilities,
  };
}

function makeSource(type = "custom_browser"): Item {
  const sourceType = canonicalSourceType(type);
  const instanceId = `source.${makeUserId()}`;
  return normalizeSourceItem(item(instanceId, sourceTypeLabel(sourceType), "Not configured.", sourceFieldsForType(sourceType, instanceId), sourceDefaultCapabilities[sourceType]), sourceType);
}

function sourceValue(entry: Item, label: string) {
  return fieldValue(entry, label).trim();
}

function isValidUrl(value: string, requireHttps = false) {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || (!requireHttps && url.protocol === "http:")) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function hostFromUrl(value: string) {
  try { return new URL(value.trim()).hostname.toLowerCase(); } catch { return ""; }
}

function isSafeDomainSlug(value: string) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value.trim());
}

function sourceMappingSummary(entry: Item, sourceType = sourceTypeFromItem(entry)) {
  if (sourceType === "nexus") return [sourceValue(entry, "Human Game Name"), sourceValue(entry, "Nexus Domain") || sourceValue(entry, "Nexus Game Page URL") || sourceValue(entry, "Nexus Game ID")].filter(Boolean).join(" - ") || "Not configured";
  if (sourceType === "modworkshop") return [sourceValue(entry, "Human Game Name"), sourceValue(entry, "ModWorkshop Slug") || sourceValue(entry, "ModWorkshop Game ID") || sourceValue(entry, "ModWorkshop Game Page URL")].filter(Boolean).join(" - ") || "Not configured";
  if (sourceType === "embedded") return sourceValue(entry, "Starting Page URL") || sourceValue(entry, "Allowed Domains") || "Not configured";
  if (sourceType === "github") return ([sourceValue(entry, "Repository Owner"), sourceValue(entry, "Repository Name")].filter(Boolean).join("/") + (sourceValue(entry, "Fixed Tag") ? ` @ ${sourceValue(entry, "Fixed Tag")}` : "")) || "Not configured";
  if (sourceType === "local") return [sourceValue(entry, "Allow Drag and Drop") === "Yes" ? "Drag and drop" : "", sourceValue(entry, "Allow File Picker") === "Yes" ? "File picker" : "", sourceValue(entry, "Allow Folder Picker") === "Yes" ? "Folder picker" : ""].filter(Boolean).join(" - ") || "Not configured";
  if (sourceType === "direct_catalog") return sourceValue(entry, "Catalog URL") || "Not configured";
  return sourceValue(entry, "Start URL") || sourceValue(entry, "Allowed Domains") || "Not configured";
}

function sourceValidationErrors(entry: Item) {
  const normalized = normalizeSourceItem(entry);
  const sourceType = sourceTypeFromItem(normalized);
  const errors: string[] = [];
  const notConfigured = (value: string) => !value.trim() || /^not configured$/i.test(value.trim());

  if (sourceType === "nexus") {
    const domain = sourceValue(normalized, "Nexus Domain");
    const gameId = sourceValue(normalized, "Nexus Game ID");
    const gamePageUrl = sourceValue(normalized, "Nexus Game Page URL");
    const categoryUrl = sourceValue(normalized, "Nexus Category URL");
    const startUrl = sourceValue(normalized, "Embedded Start URL");
    if (notConfigured(domain) && notConfigured(gameId) && notConfigured(gamePageUrl)) errors.push("Enter a Nexus domain, numeric game ID, or full Nexus game page URL.");
    if (domain && !isSafeDomainSlug(domain)) errors.push("Nexus domain must be a source slug like readyornot, not a display name.");
    if (gameId && !isNumericSourceId(gameId)) errors.push("Nexus game ID must be numeric. Put slugs in Nexus Domain and game titles in Human Game Name.");
    if (gamePageUrl && !sourceUrlMatchesHost(gamePageUrl, "nexusmods.com")) errors.push("Nexus game page URL must be a Nexus Mods URL.");
    if (categoryUrl && !sourceUrlMatchesHost(categoryUrl, "nexusmods.com")) errors.push("Nexus category URL must be a Nexus Mods URL.");
    if (startUrl && !sourceUrlMatchesHost(startUrl, "nexusmods.com")) errors.push("Embedded Nexus start URL must stay on nexusmods.com.");
  } else if (sourceType === "modworkshop") {
    const gameId = sourceValue(normalized, "ModWorkshop Game ID");
    const slug = sourceValue(normalized, "ModWorkshop Slug");
    const pageUrl = sourceValue(normalized, "ModWorkshop Game Page URL");
    const categoryUrl = sourceValue(normalized, "ModWorkshop Category URL");
    const startUrl = sourceValue(normalized, "Embedded Start URL");
    if (notConfigured(gameId) && notConfigured(slug) && notConfigured(pageUrl)) errors.push("Enter a ModWorkshop game page URL, game ID, or slug.");
    if (gameId && !isNumericSourceId(gameId)) errors.push("ModWorkshop game ID must be numeric. Put slugs in ModWorkshop Slug and game titles in Human Game Name.");
    if (slug && !isSafeDomainSlug(slug)) errors.push("ModWorkshop slug must be a source slug like ready-or-not, not a display name.");
    if (pageUrl && !sourceUrlMatchesHost(pageUrl, "modworkshop.net")) errors.push("ModWorkshop game page URL must be a ModWorkshop URL.");
    if (categoryUrl && !sourceUrlMatchesHost(categoryUrl, "modworkshop.net")) errors.push("ModWorkshop category URL must be a ModWorkshop URL.");
    if (startUrl && !sourceUrlMatchesHost(startUrl, "modworkshop.net")) errors.push("Embedded ModWorkshop start URL must stay on modworkshop.net.");
  } else if (sourceType === "embedded") {
    if (!isValidUrl(sourceValue(normalized, "Starting Page URL"))) errors.push("Starting page URL must be valid.");
    if (notConfigured(sourceValue(normalized, "Allowed Domains"))) errors.push("Add at least one allowed domain.");
  } else if (sourceType === "github") {
    if (!isSafeDomainSlug(sourceValue(normalized, "Repository Owner"))) errors.push("Repository owner is required.");
    if (!isSafeDomainSlug(sourceValue(normalized, "Repository Name"))) errors.push("Repository name is required.");
    if ((sourceValue(normalized, "Release Channel") || "Latest stable") === "Specific tag" && !sourceValue(normalized, "Fixed Tag")) errors.push("Specific tag sources need a fixed release tag.");
  } else if (sourceType === "local") {
    const allowed = ["Allow Drag and Drop", "Allow File Picker", "Allow Folder Picker"].some((label) => sourceValue(normalized, label) === "Yes");
    if (!allowed) errors.push("Enable at least one local input method.");
  } else if (sourceType === "direct_catalog") {
    if (!isValidUrl(sourceValue(normalized, "Catalog URL"), true)) errors.push("Catalog URL must be a valid HTTPS URL.");
  } else {
    if (notConfigured(sourceValue(normalized, "Allowed Domains"))) errors.push("Add at least one allowed domain.");
    if (!isValidUrl(sourceValue(normalized, "Start URL"))) errors.push("Start URL must be valid.");
  }

  const caps = listField(normalized, "Capabilities");
  if (!caps.length) errors.push("Select at least one capability.");
  return errors;
}

function sourceStatus(entry: Item) {
  if (entry.enabled === false) return "Disabled";
  const status = sourceValue(entry, "Last Test Status");
  if (status === "Failed") return "Failed";
  if (sourceValidationErrors(entry).length) return "Not configured";
  if (status === "Connected") return "Connected";
  if (status === "Configured") return "Configured";
  return "Untested";
}

function normalizeSourceTestStatus(status: string) {
  if (status === "Connected") return "Connected";
  if (status === "Valid") return "Configured";
  return "Failed";
}

function sourceTestPassed(result: SourceTestResult) {
  return result.status === "Connected" || result.status === "Valid";
}

function sourceTestResultFromError(error: unknown): SourceTestResult {
  return {
    status: "Failed",
    message: error instanceof Error ? error.message : String(error || "Source test failed."),
    final_url: null,
    http_status: null,
  };
}

function sourceTestMessage(result: SourceTestResult) {
  return result.userMessage || result.user_message || result.message || result.status || "Source test completed.";
}

function stampSourceTestResult(entry: Item, result: SourceTestResult) {
  const status = normalizeSourceTestStatus(result.status);
  const statusCode = result.statusCode ?? result.status_code ?? result.http_status ?? null;
  let next = replaceField(entry, "Last Test Status", status);
  next = replaceField(next, "Last Tested", new Date().toISOString());
  next = replaceField(next, "Last Test Message", sourceTestMessage(result));
  next = replaceField(next, "Last Test URL", result.final_url ?? "");
  next = replaceField(next, "Last Test HTTP Status", statusCode ? String(statusCode) : "");
  next = replaceField(next, "Last Test Details", result.technicalDetails ?? result.technical_details ?? "");
  return normalizeSourceItem(next);
}

async function runProfileSourceTest(entry: Item): Promise<{ entry: Item; result: SourceTestResult }> {
  const normalized = normalizeSourceItem(entry);
  try {
    const localResult = await invoke<SourceTestResult>("test_profile_source_config", { source: normalized });
    const result = sourceTypeFromItem(normalized) === "github" && localResult.status === "Valid"
      ? await invoke<SourceTestResult>("test_github_public_repository", {
          owner: sourceValue(normalized, "Repository Owner"),
          repository: sourceValue(normalized, "Repository Name"),
        })
      : localResult;
    return { entry: stampSourceTestResult(normalized, result), result };
  } catch (error) {
    const result = sourceTestResultFromError(error);
    return { entry: stampSourceTestResult(normalized, result), result };
  }
}
function sourceDuplicateKey(entry: Item) {
  const normalized = normalizeSourceItem(entry);
  const sourceType = sourceTypeFromItem(normalized);
  if (sourceType === "nexus") return `nexus:${(sourceValue(normalized, "Nexus Domain") || parseNexusGameUrl(sourceValue(normalized, "Nexus Game Page URL"))?.domain || sourceValue(normalized, "Nexus Game ID")).toLowerCase()}`;
  if (sourceType === "modworkshop") return `modworkshop:${(sourceValue(normalized, "ModWorkshop Slug") || parseModWorkshopGameUrl(sourceValue(normalized, "ModWorkshop Game Page URL"))?.slug || sourceValue(normalized, "ModWorkshop Game ID")).toLowerCase()}`;
  if (sourceType === "github") return `github:${sourceValue(normalized, "Repository Owner").toLowerCase()}/${sourceValue(normalized, "Repository Name").toLowerCase()}`;
  if (sourceType === "embedded") return `embedded:${hostFromUrl(sourceValue(normalized, "Starting Page URL")) || sourceValue(normalized, "Allowed Domains").toLowerCase()}`;
  if (sourceType === "direct_catalog") return `direct_catalog:${sourceValue(normalized, "Catalog URL").toLowerCase()}`;
  if (sourceType === "local") return "local:local-files";
  return `custom_browser:${hostFromUrl(sourceValue(normalized, "Start URL")) || sourceValue(normalized, "Allowed Domains").toLowerCase()}`;
}

function findDuplicateSource(candidate: Item, sources: Item[], ignoreInstanceId?: string) {
  const key = sourceDuplicateKey(candidate);
  if (!key || key.endsWith(":")) return null;
  return sources.find((source) => sourceInstanceId(source) !== ignoreInstanceId && sourceDuplicateKey(source) === key) ?? null;
}
function makeEmptySections(): Record<SectionId, Item[]> {
  return {
    gameArtwork: [],
    detectionStores: [],
    pathsLaunch: [],
    sources: [],
    modTypes: [],
    installBehavior: [],
    enableDisable: [],
    loadOrder: [],
    dependencies: [],
    conflicts: [],
    updatesUninstall: [],
    taxonomy: [],
    advancedRules: [],
    testProfile: [],
    reviewExport: [],
  };
}

function makeSections(): Record<SectionId, Item[]> {
  return {
    gameArtwork: [],
    reviewExport: [],
    detectionStores: [
      item("steam", "Steam", "Tsuki recognizes PAYDAY 3 with Steam app 1272080, supported executables, and both required game folders.", [{ label: "Steam App ID", value: "1272080" }, { label: "Expected executable", value: "PAYDAY3Client-Win64-Shipping.exe, PAYDAY3-Win64-Shipping.exe" }, { label: "Required markers", value: "PAYDAY3/Content/Paks, PAYDAY3/Binaries/Win64" }], ["Detect Automatically", "Test Detection"]),
      item("custom", "Custom Folder", "User-selected folder uses the same executable and marker checks as Steam.", [{ label: "Folder", value: "${GAME_ROOT}" }, { label: "Condition mode", value: "Executable match AND marker folders" }], ["Browse", "Test Detection"]),
      item("epic", "Epic Games", "Coming later; no current PAYDAY 3 Epic mapping is used by Tsuki.", [{ label: "Catalog ID", value: "" }, { label: "Offer ID", value: "" }], ["Coming Later"], false),
      item("gog", "GOG", "Coming later; no current PAYDAY 3 GOG mapping is used by Tsuki.", [{ label: "Product ID", value: "" }], ["Coming Later"], false),
    ],
    pathsLaunch: [
      item("vars", "Built-in Variables", "Reusable paths available to install and launch rules.", [{ label: "Game Root", value: "${GAME_ROOT}" }, { label: "Executable Directory", value: "${GAME_ROOT}/PAYDAY3/Binaries/Win64" }, { label: "Profile Data", value: "${APP_DATA}/game_profiles" }, { label: "Disabled Mods", value: "${GAME_ROOT}/PAYDAY3/Content/Paks/~mods/Tsuki_Disabled_Mods" }, { label: "Backups", value: "${GAME_ROOT}/PAYDAY3/Content/Paks/~mods/Tsuki_Backups" }, { label: "Cache", value: "${APP_DATA}/cache" }, { label: "Documents", value: "${DOCUMENTS}" }, { label: "AppData", value: "${APP_DATA}" }, { label: "LocalAppData", value: "${LOCAL_APP_DATA}" }]),
      item("paths", "PAYDAY 3 Named Paths", "Current Tsuki destinations used by installer, scanner, toggles, backups, and receipts.", [{ label: "PAK Mods", value: "PAYDAY3/Content/Paks/~mods" }, { label: "UE4SS Mods", value: "PAYDAY3/Binaries/Win64/Mods" }, { label: "Win64", value: "PAYDAY3/Binaries/Win64" }, { label: "Game Content", value: "PAYDAY3/Content" }, { label: "Backups", value: "PAYDAY3/Content/Paks/~mods/Tsuki_Backups" }, { label: "Disabled Storage", value: "PAYDAY3/Content/Paks/~mods/Tsuki_Disabled_Mods" }]),
      item("launch", "Launch Configuration", "Modded launch keeps mods enabled. Vanilla launch temporarily moves active receipt files, PAK-family files, UE4SS loader items, and Win64/Mods children out of scanned folders, launches, then restores.", [{ label: "Executable", value: "PAYDAY3/Binaries/Win64/PAYDAY3Client-Win64-Shipping.exe" }, { label: "Working Directory", value: "${GAME_ROOT}/PAYDAY3/Binaries/Win64" }, { label: "Storefront launch", value: "Steam app 1272080; direct executable fallback" }, { label: "Pre-launch checks", value: "Game path detected, PAYDAY 3 not running, runtime locks clear" }], ["Test Paths", "Test Launch Dry Run"]),
    ],
    sources: [
      item("modworkshop", "ModWorkshop", "Current built-in public ModWorkshop source mapping.", [{ label: "Human Game Name", value: "PAYDAY 3" }, { label: "ModWorkshop Slug", value: "payday-3" }, { label: "ModWorkshop Game ID", value: "853" }, { label: "ModWorkshop Game Page URL", value: "https://modworkshop.net/g/payday-3/mods" }, { label: "Embedded Start URL", value: "https://modworkshop.net/g/payday-3/mods" }, { label: "Allowed Domains", value: MODWORKSHOP_ALLOWED_DOMAINS }, { label: "Browse Mode", value: "Built-in/API" }], ["Browse", "Search", "Download", "Categories", "Metadata", "Public API"]),
      item("nexus", "Nexus Mods", "Current built-in Nexus mapping; credentials come from global Settings.", [{ label: "Human Game Name", value: "PAYDAY 3" }, { label: "Nexus Domain", value: "payday3" }, { label: "Nexus Game Page URL", value: "https://www.nexusmods.com/payday3" }, { label: "Embedded Start URL", value: "https://www.nexusmods.com/payday3/mods" }, { label: "Allowed Domains", value: NEXUS_ALLOWED_DOMAINS }, { label: "Browse Mode", value: "Built-in/API" }, { label: "Update Checking", value: "Enabled" }, { label: "Authentication/API Status", value: "Uses global settings" }], ["Browse", "Search", "Download handling", "Categories", "Global Account"]),
      item("browser", "Embedded Browser", "Allowed source domains and download capture for supported source pages.", [{ label: "Allowed Domains", value: "modworkshop.net, nexusmods.com, github.com" }, { label: "Starting Page URL", value: "https://modworkshop.net/g/payday-3/mods" }], ["Cross-game safety", "Download capture"]),
      item("local", "Local Files", "Drag-and-drop and manual file installs with receipts.", [], ["Drag and drop", "Receipts"]),
      item("github", "GitHub Releases", "Built-in public GitHub Releases source. Configure a repository when this profile uses GitHub-hosted downloads.", [{ label: "Repository URL", value: "" }, { label: "Release Channel", value: "Latest stable" }, { label: "Asset Selection", value: "First matching release archive" }, { label: "Accepted Extensions", value: ".zip|.7z|.rar|.dll" }, { label: "Exclude Asset Patterns", value: "Source code (zip)|Source code (tar.gz)|source-code|source_code" }], ["Public API", "Releases", "Downloads", "Version checks"]),
      item("gamebanana", "Future GameBanana", "Coming later; profile has a clear source slot without pretending it works today.", [], ["Coming Later"], false),
    ],
    modTypes: [
      item("pak", "PAK / UTOC / UCAS", "Unreal cooked packages routed to the PAYDAY 3 ~mods folder.", [{ label: "Detection", value: ".pak, .utoc, .ucas, or Content/Paks/~mods" }, { label: "Destination", value: "PAYDAY3/Content/Paks/~mods" }, { label: "Priority", value: "200" }], ["PAK", "UTOC", "UCAS"]),
      item("ue4ss", "UE4SS Mods Folder", "Everything inside a UE4SS Mods folder is tracked and installed, not only Lua files.", [{ label: "Detection", value: "Mods/<ModName>, UE4SS, Lua, DLL, native hints" }, { label: "Destination", value: "PAYDAY3/Binaries/Win64/Mods" }, { label: "Dependency", value: "UE4SS recommended" }], ["Lua", "DLL", "INI", "Mods folder"]),
      item("win64", "Win64 Runtime Files", "DLL, INI, Lua, and native companion files beside the executable.", [{ label: "Destination", value: "PAYDAY3/Binaries/Win64" }, { label: "Overwrite", value: "Backup then overwrite with receipt" }], ["DLL", "INI", "Lua"]),
      item("movies", "Movie / Video Replacer", "Explicit video replacements route to Content/Movies instead of ~mods.", [{ label: "Destination", value: "PAYDAY3/Content/Movies" }]),
      item("wwise", "Wwise Audio", "Explicit Wwise audio content routes under Content/WwiseAudio.", [{ label: "Destination", value: "PAYDAY3/Content/WwiseAudio" }]),
      item("loose", "Loose Files", "Fallback declarative type that requires preview before copy.", [{ label: "Destination", value: "Prompt / archive inspection" }]),
    ],
    installBehavior: [
      item("pak-rule", "PAK-family to ~mods", "If the archive contains PAK-family files, copy them into PAYDAY3/Content/Paks/~mods and track every file.", [{ label: "WHEN", value: "Archive contains .pak, .utoc, .ucas, or ~mods path" }, { label: "THEN", value: "Extract matching files; copy to PAK Mods; write receipt" }]),
      item("ue4ss-rule", "UE4SS Mods folder", "If the archive contains a Mods folder, copy everything inside it into the game's Mods folder while preserving structure.", [{ label: "WHEN", value: "Archive contains Mods folder or UE4SS/Win64 hints" }, { label: "THEN", value: "Merge under Win64; track all children including non-Lua assets" }]),
      item("win64-rule", "Explicit Win64 route", "Runtime loader files install beside the executable with overwrite backups and receipt rollback.", [{ label: "WHEN", value: "Path contains Binaries/Win64 or known loader runtime" }, { label: "THEN", value: "Backup then overwrite; write receipt entry" }]),
      item("content-rule", "Content replacement routes", "Movie and Wwise replacements stay in explicit content folders instead of ~mods.", [{ label: "WHEN", value: "Path contains Content/Movies or Content/WwiseAudio" }, { label: "THEN", value: "Copy to matching content folder; warn on same destination" }]),
    ],
    enableDisable: [
      item("pak-toggle", "PAK / UTOC / UCAS", "Near-instant file moves between ~mods and Tsuki_Disabled_Mods/disabled_pak_mods; receipt paths stay intact.", [{ label: "Enable", value: "Move tracked file back to ~mods and remove .disabled suffix" }, { label: "Disable", value: "Move tracked file to disabled_pak_mods and add .disabled for risky names" }]),
      item("ue4ss-toggle", "UE4SS / Win64", "Tracked files move between Win64 and disabled_UE4SS_Mods while preserving relative paths and receipts.", [{ label: "Enable", value: "Restore under Win64" }, { label: "Disable", value: "Move under disabled_UE4SS_Mods" }]),
    ],
    loadOrder: [
      item("method", "Mixed Load Order", "Unreal package order is mostly filename/path driven; UE4SS/plugin order is loader-specific; Tsuki stores explicit priority layers for display and future manifests.", [{ label: "Method", value: "Filename/path, loader-specific, explicit priority layers" }], ["100 Framework", "200 Libraries", "300 Gameplay", "400 Audio", "500 Visual", "900 Overrides"]),
      item("paired", "Paired File Grouping", "PAK-family files, UE4SS folders, and loader companions remain grouped during install and preview.", [{ label: "PAK group", value: ".pak + .utoc + .ucas" }, { label: "UE4SS group", value: "Whole mod folder" }, { label: "Runtime group", value: "DLL + INI companions" }]),
    ],
    dependencies: [
      makeDependency("UE4SS"),
      makeDependency("DLL Loader"),
    ],
    conflicts: [
      item("same-destination", "Same destination file", "Ask user when another mod already owns this destination path.", [{ label: "Affected", value: "All receipt-backed installs" }, { label: "Severity", value: "Ask user" }, { label: "Resolution", value: "Overwrite, keep existing, or install compatibility patch" }]),
      item("loader-overwrite", "Runtime loader overwrite", "Warn before changing UE4SS/proxy loader behavior.", [{ label: "Affected", value: "Win64 Runtime Files" }, { label: "Severity", value: "Warning" }, { label: "Resolution", value: "Backup then overwrite after preview" }]),
    ],
    updatesUninstall: [
      item("update", "Update Policy", "Replace tracked files, preserve marked config, remove obsolete receipt files, allow downgrade after confirmation, and compare source version/manifest/hash where available.", [{ label: "Rollback", value: "Old receipt remains the rollback source until update succeeds" }]),
      item("uninstall", "Uninstall Policy", "Remove tracked files, restore overwritten backups, remove disabled copies, remove empty directories, keep shared dependencies, and preserve saves/user content.", [{ label: "Non-reversible warning", value: "Untracked manual edits outside receipts cannot be restored automatically" }]),
    ],
    taxonomy: [
      item("mw-taxonomy", "ModWorkshop PAYDAY 3", "Source taxonomy mapping with separate source/type identity.", [{ label: "Source ID", value: "payday-3 / 853" }, { label: "Color", value: "#4ab8ff" }], ["Categories", "Descriptive tags"]),
      item("nx-taxonomy", "Nexus PAYDAY 3", "Nexus mapping preserves domain and category identity.", [{ label: "Source ID", value: "payday3" }, { label: "Color", value: "#ffb45f" }], ["Categories"]),
      item("fallback-taxonomy", "Fallback PAYDAY 3 Taxonomy", "Fallback data is scoped to this profile and does not apply blindly to future games.", [{ label: "Categories", value: "Audio, Gameplay, HUD, Interface, Visual, Weapons, Tools, Misc" }, { label: "Tags", value: "PAK, UE4SS, Lua, DLL, INI, Movies, Wwise, Local File" }, { label: "Custom", value: "Favorite, Testing, Profile Locked" }]),
    ],
    advancedRules: [
      item("actions", "Approved Action Registry", "Advanced rules can use Tsuki's approved actions. They cannot run arbitrary programs or shell commands.", [{ label: "Actions", value: "copy, backup_then_copy, move_tracked_files, restore_tracked_files, patch_ini, patch_json, verify_hash, write_manifest_entry" }, { label: "Conditions", value: "archive contains path, extension, filename, folder, source, tag/category, dependency, storefront, game version" }]),
      item("permissions", "Generated Permissions", "Rules may read selected archives, write under detected game folders, and write Tsuki receipts only.", [{ label: "Blocked", value: "Shell, PowerShell, CMD, arbitrary executable actions" }]),
    ],
    testProfile: [
      item("workspace", "Runtime Test Workspace", "Runs shared runtime checks in profile-scoped test storage; install mutations are not executed.", [{ label: "Test game folder", value: "${GAME_ROOT}" }, { label: "Sample mod archive", value: "" }, { label: "Dependency state", value: "UE4SS optional" }, { label: "Storefront", value: "Steam" }, { label: "Game version", value: "Current" }], ["Test Detection", "Test Paths", "Dry-Run Install", "Dry-Run Enable", "Dry-Run Disable", "Dry-Run Update", "Dry-Run Uninstall", "Test Conflict", "Test Rollback"]),
    ],
  };
}

const tutorialExampleToken = String.fromCharCode(115, 99, 111, 111, 116, 101, 114);

function containsTutorialExample(value: unknown): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(tutorialExampleToken);
  if (Array.isArray(value)) return value.some(containsTutorialExample);
  if (value && typeof value === "object") return Object.values(value).some(containsTutorialExample);
  return false;
}

function cleanTutorialExamples(draft: Draft): Draft {
  const customPaths = draft.customPaths.filter((path) => !containsTutorialExample(path));
  const customFileTypes = draft.customFileTypes.filter((fileType) => !containsTutorialExample(fileType));
  const customTest = containsTutorialExample(draft.customTest) ? { sampleFilename: "", sampleArchive: "", sampleGameRoot: draft.customTest.sampleGameRoot || "C:/SelectedGame" } : draft.customTest;
  const advancedJson = containsTutorialExample(draft.advancedJson) ? "{}" : draft.advancedJson;
  return { ...draft, customPaths, customFileTypes, customTest, advancedJson };
}
function mergeSavedDraft(source?: GameProfile | null): Draft | null {
  const saved = (source as (GameProfile & { draft?: Partial<Draft> }) | null | undefined)?.draft;
  if (!saved || typeof saved !== "object" || !saved.profileId) return null;

  const base = makeDraft(null);
  const artwork = { ...base.artwork, ...(saved.artwork ?? {}) };
  const imageReference = normalizeProfileImageReference(artwork.imageReference, artwork.imageUrl);
  return cleanTutorialExamples({
    ...base,
    ...saved,
    profileId: String(saved.profileId),
    profileType: saved.profileType ?? "user_created",
    status: saved.status ?? "draft",
    lifecycleState: saved.lifecycleState ?? "draft",
    setupStatus: saved.setupStatus ?? "incomplete",
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt ?? new Date().toISOString(),
    overview: { ...base.overview, ...(saved.overview ?? {}) },
    artwork: { ...artwork, imageReference, imageUrl: imageReference.kind === "none" ? "" : imageReference.value },
    sections: { ...base.sections, ...(saved.sections ?? {}) },
    customPaths: Array.isArray(saved.customPaths) ? saved.customPaths : [],
    customFileTypes: Array.isArray(saved.customFileTypes) ? saved.customFileTypes : [],
    customTest: { ...base.customTest, ...(saved.customTest ?? {}) },
    advancedJson: saved.advancedJson ?? base.advancedJson,
    testOutput: Array.isArray(saved.testOutput) ? saved.testOutput : [],
  });
}
export function makeDraft(source?: GameProfile | null, official = false): Draft {
  const savedDraft = mergeSavedDraft(source);
  if (savedDraft) return savedDraft;

  const profileId = source?.profileId ?? `user.${makeUserId()}`;
  const isPayday = source?.gameKey === "payday3";
  const isBlank = !source;

  if (isBlank) {
    return {
      schemaVersion: 3,
      profileId,
      profileType: "user_created",
      status: "draft",
      updatedAt: new Date().toISOString(),
      overview: {
        gameName: "",
        profileTitle: "",
        gameKey: "",
        version: "1.0.0",
        gameVersion: "",
        author: "",
        shortDescription: "",
        fullDescription: "",
        storefronts: "",
        supportedVersions: "",
        license: "",
        documentationUrl: "",
        supportUrl: "",
      },
      artwork: { imageUrl: "", imageReference: noneProfileImageReference(), objectFit: "cover", focalX: 50, focalY: 50, scale: 1 },
      sections: makeEmptySections(),
      customPaths: [],
      customFileTypes: [],
      unknownFileFallback: "",
      customTest: { sampleFilename: "", sampleArchive: "", sampleGameRoot: "" },
      advancedJson: "{}",
      testOutput: [],
    };
  }

  const displayName = source.displayName ?? "";
  const sections = isPayday ? makeSections() : makeEmptySections();
  if (source.sourceConfig.sources?.length) {
    sections.sources = source.sourceConfig.sources.map((definition) => {
      let entry = makeSource(definition.provider);
      const providerName = definition.provider === "nexus" ? "Nexus" : "ModWorkshop";
      const values: Record<string, string> = {
        "Source Instance ID": definition.id,
        "Display Name": definition.displayName,
        "Human Game Name": definition.gameName || displayName,
        [definition.provider === "nexus" ? "Nexus Domain" : "ModWorkshop Slug"]: definition.providerSlug || "",
        [`${providerName} Game ID`]: definition.providerGameId || "",
        [`${providerName} Game Page URL`]: definition.gamePageUrl || "",
        [`${providerName} Category URL`]: definition.listingUrl || "",
        "Embedded Start URL": definition.startUrl || "",
        "Start URL": definition.startUrl || "",
        "Allowed Domains": definition.allowedDomains.join("|"),
        "Browse Mode": definition.browseMode === "api" ? "Built-in/API" : definition.browseMode === "external" ? "External" : "Embedded",
        "Capture Downloads": definition.captureDownloads ? "Yes" : "No",
      };
      for (const [label, value] of Object.entries(values)) entry = replaceField(entry, label, value);
      return normalizeSourceItem({ ...entry, id: definition.id, title: definition.displayName, enabled: definition.enabled });
    });
  }
  const sourceImageReference = normalizeProfileImageReference(source.imageReference, source.image, "bundled");
  return cleanTutorialExamples({
    schemaVersion: 3,
    profileId,
    profileType: source.profileType ?? "user_created",
    status: isPayday && official ? "official_draft" : "draft",
    updatedAt: new Date().toISOString(),
    overview: {
      gameName: displayName,
      profileTitle: isPayday ? "PAYDAY 3 Official Draft" : displayName ? `${displayName} Profile` : "",
      gameKey: source.gameKey ?? "",
      version: source.profileVersion || "1.0.0",
      gameVersion: source.gameVersion || "",
      author: isPayday ? "Tsuki Maintainer" : "",
      shortDescription: isPayday ? "Official Tsuki support package for PAYDAY 3." : "",
      fullDescription: isPayday ? "Mirrors the current built-in PAYDAY 3 install, source, toggle, and receipt behavior." : "",
      storefronts: isPayday ? "Steam, Custom" : "",
      supportedVersions: source.gameVersions?.join(", ") || source.gameVersion || "",
      license: isPayday ? "Tsuki built-in profile" : "",
      documentationUrl: "",
      supportUrl: "",
    },
    artwork: { imageUrl: sourceImageReference.value, imageReference: sourceImageReference, objectFit: source.artwork?.objectFit ?? "cover", focalX: source.artwork?.focalX ?? 50, focalY: source.artwork?.focalY ?? 50, scale: source.artwork?.scale ?? 1 },
    sections,
    customPaths: [],
    customFileTypes: [],
    unknownFileFallback: isPayday ? "Show install preview and ask user to choose a mod type." : "",
    customTest: { sampleFilename: "", sampleArchive: "", sampleGameRoot: "" },
    advancedJson: "{}",
    testOutput: [],
  });
}

export function ProfileCreatorPage({ sourceProfile = null, canEditOfficialProfiles = false, onDraftSaved, onOpenProfile, onBack }: Props) {
  const [draft, setDraft] = useState(() => makeDraft(sourceProfile, canEditOfficialProfiles));
  const [templateStep, setTemplateStep] = useState<"choose" | "review" | "done">(() => sourceProfile ? "done" : "choose");
  const [selectedProfileTemplate, setSelectedProfileTemplate] = useState<ProfileTemplateId>("blank");
  const [active, setActive] = useState<SectionId>(() => {
    const stored = sourceProfile?.profileId ? window.localStorage.getItem(`tsuki-profile-creator-section:${sourceProfile.profileId}`) : null;
    return stored && guidedSectionIds.includes(stored as SectionId) ? stored as SectionId : "gameArtwork";
  });
  const [mode, setMode] = useState<Mode>("guided");
  const [saveState, setSaveState] = useState<SaveState>("unsaved");
  const [message, setMessage] = useState(sourceProfile?.profileType === "builtin_official" ? "Official draft autosaves separately from the published built-in profile." : sourceProfile ? "Draft autosaves locally as you edit." : "Blank profile autosaves locally as you build it.");
  const [helpOpen, setHelpOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [testedSections, setTestedSections] = useState<Partial<Record<SectionId, boolean>>>({});
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const [pathsTab, setPathsTab] = useState<"folders" | "launch" | "variables" | "named">("folders");
  const [gameFolderScan, setGameFolderScan] = useState<GameFolderScanResult | null>(null);
  const [sourceEditor, setSourceEditor] = useState<SourceEditorState | null>(null);
  const [itemEditor, setItemEditor] = useState<ItemEditorState | null>(null);
  const [customPathEditor, setCustomPathEditor] = useState<CustomPathEditorState | null>(null);
  const [customTypeEditor, setCustomTypeEditor] = useState<CustomTypeEditorState | null>(null);

  useEffect(() => {
    safeLocalStorageSet(`tsuki-profile-creator-section:${draft.profileId}`, active);
  }, [active, draft.profileId]);

  useEffect(() => {
    const onPickerError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setMessage(detail?.message ?? "Profile Creator picker failed.");
    };
    window.addEventListener("tsuki-profile-creator-picker-error", onPickerError);
    return () => window.removeEventListener("tsuki-profile-creator-picker-error", onPickerError);
  }, []);

  useEffect(() => {
    logProfileArtwork("draft image reference loaded", {
      profileId: draft.profileId,
      imageReference: draft.artwork.imageReference,
      legacyImageUrl: draft.artwork.imageUrl,
    });
    // initial artwork diagnostics only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSaveState("saving");
    invoke<Draft>("create_game_profile_draft", { draft: cleanTutorialExamples(draft) })
      .then((saved) => { setDraft((current) => cleanTutorialExamples({ ...current, ...saved, customPaths: saved.customPaths ?? current.customPaths, customFileTypes: saved.customFileTypes ?? current.customFileTypes })); setSaveState("saved"); void onDraftSaved?.(); })
      .catch((error) => { console.warn(error); setSaveState("error"); });
    // initial durable draft only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = cleanTutorialExamples({ ...draft, updatedAt: new Date().toISOString() });
      setSaveState("saving");
      invoke("save_game_profile_draft", { profileId: draft.profileId, draft: next })
        .then(() => { setSaveState("saved"); void onDraftSaved?.(); })
        .catch((error) => { console.warn(error); setSaveState("error"); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const issues = useMemo(() => {
    const out: Array<{ level: IssueLevel; section: SectionId; text: string }> = [];
    if (!draft.overview.gameName.trim()) out.push({ level: "error", section: "gameArtwork", text: "Game name is required." });
    if (!draft.overview.profileTitle.trim()) out.push({ level: "error", section: "gameArtwork", text: "Profile name is required." });
    if (!safeKey(draft.overview.gameKey)) out.push({ level: "error", section: "gameArtwork", text: "Game key must be safe lowercase text." });
    if (!profileImageHasValue(draft.artwork.imageReference, draft.artwork.imageUrl)) out.push({ level: "suggestion", section: "gameArtwork", text: "Add profile artwork or acknowledge the no-image state in Review." });
    if (!draft.sections.detectionStores.some((item) => item.enabled)) out.push({ level: "error", section: "detectionStores", text: "Enable at least one detection strategy." });
    if (!draft.sections.modTypes.length && !draft.customFileTypes.length) out.push({ level: "error", section: "modTypes", text: "Add at least one built-in or custom mod type." });
    if (!draft.sections.installBehavior.length && !draft.customFileTypes.length) out.push({ level: "error", section: "installBehavior", text: "Add install behavior rules." });
    for (const path of draft.customPaths) {
      for (const issue of customPathIssues(path)) out.push({ level: issue.level, section: "pathsLaunch", text: `${path.name || path.id}: ${issue.text}` });
    }
    const duplicateKeys = new Map<string, number>();
    for (const fileType of draft.customFileTypes) {
      for (const issue of customFileTypeIssues(fileType, draft.customPaths)) out.push({ level: issue.level, section: "modTypes", text: `${fileType.name || fileType.id}: ${issue.text}` });
      const key = `${fileType.priority}:${fileType.kind}:${fileType.extension}:${fileType.filenamePattern}:${fileType.folderMarker}`.toLowerCase();
      duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
    }
    for (const [key, count] of duplicateKeys) {
      if (count > 1) out.push({ level: "warning", section: "modTypes", text: `Two custom mod types share identical matching conditions at priority ${key.split(":")[0]}.` });
    }
    for (const dependency of draft.sections.dependencies) {
      for (const issue of dependencyIssues(dependency, draft.sections.dependencies)) out.push({ level: issue.level, section: "dependencies", text: issue.text });
    }
    const dependencyGraph = dependencyGraphPlan(draft.sections.dependencies);
    for (const cycle of dependencyGraph.cycles) out.push({ level: "error", section: "dependencies", text: `Dependency cycle detected: ${cycle}.` });
    for (const missing of dependencyGraph.missing) out.push({ level: "warning", section: "dependencies", text: `Dependency graph references missing dependency: ${missing}.` });
    for (const section of sectionInfo) {
      if (sectionRequiresTest(section.id) && sectionHasConfiguration(draft, section.id) && !testedSections[section.id]) {
        out.push({ level: "untested", section: section.id, text: `${section.label} has not been dry-run in this draft.` });
      }
    }
    return out;
  }, [draft, testedSections]);

  const blocked = issues.some((issue) => issue.level === "error");
  const sectionStates = sectionInfo.map((section) => ({ ...section, status: sectionStatus(section.id, issues, draft, testedSections) }));
  const navigationSections = sectionStates
    .filter((section) => mode === "advanced" || guidedSectionIds.includes(section.id))
    .map((section) => mode === "guided" && guidedSectionCopy[section.id]
      ? { ...section, ...guidedSectionCopy[section.id] }
      : section);
  const activeMeta = navigationSections.find((section) => section.id === active)
    ?? sectionStates.find((section) => section.id === active)
    ?? sectionInfo[0];
  const readyCount = navigationSections.filter((section) => section.status === "configured" || section.status === "tested").length;
  const issueCount = issues.length;
  const validationSummary = summarizeIssues(issues);

  function openCreatorSection(section: SectionId) {
    if (mode === "guided" && !guidedSectionIds.includes(section)) setMode("advanced");
    setActive(section);
  }

  function changeCreatorMode(nextMode: Mode) {
    setMode(nextMode);
    if (nextMode === "guided" && !guidedSectionIds.includes(active)) setActive("reviewExport");
  }

  function setOverview(name: string, value: string) {
    setDraft((current) => ({ ...current, overview: { ...current.overview, [name]: name === "gameKey" ? safeKey(value) : value } }));
  }

  function setArtwork(name: string, value: string | number | ProfileImageReference) {
    setDraft((current) => ({ ...current, artwork: { ...current.artwork, [name]: value } }));
  }

  function setArtworkReference(reference: ProfileImageReference, paths?: { originalPath: string; managedPath: string; resolvedPreviewUrl: string }) {
    const normalized = normalizeProfileImageReference(reference);
    logProfileArtwork("saved typed image reference", { profileId: draft.profileId, imageReference: normalized });
    setDraft((current) => ({
      ...current,
      artwork: {
        ...current.artwork,
        imageReference: normalized,
        imageUrl: normalized.kind === "none" ? "" : normalized.value,
        ...(paths ?? {}),
      },
    }));
  }

  function setItem(section: SectionId, index: number, next: Partial<Item>) {
    setDraft((current) => {
      const rows = [...current.sections[section]];
      rows[index] = { ...rows[index], ...next };
      return { ...current, sections: { ...current.sections, [section]: rows } };
    });
  }

  function setItemField(section: SectionId, index: number, label: string, value: string) {
    setDraft((current) => {
      const rows = [...current.sections[section]];
      const fields = [...rows[index].fields];
      const fieldIndex = fields.findIndex((field) => field.label === label);
      if (fieldIndex >= 0) fields[fieldIndex] = { ...fields[fieldIndex], value };
      else fields.push({ label, value });
      rows[index] = { ...rows[index], fields };
      return { ...current, sections: { ...current.sections, [section]: rows } };
    });
  }

  function itemSaveLabel(section: SectionId) {
    if (section === "detectionStores") return "Save Detection Method";
    if (section === "dependencies") return "Save Dependency";
    if (section === "installBehavior") return "Save Install Rule";
    if (section === "enableDisable") return "Save Strategy";
    if (section === "conflicts") return "Save Conflict Rule";
    if (section === "taxonomy") return "Save Tag";
    return `Save ${sectionInfo.find((entry) => entry.id === section)?.label ?? "Item"}`;
  }

  function normalizeItemForSave(section: SectionId, draftItem: Item) {
    let next = { ...draftItem, title: draftItem.title.trim() || sectionInfo.find((entry) => entry.id === section)?.label || "Profile Item" };
    if (!next.id.trim()) next = { ...next, id: `${section}-${makeUserId()}` };
    if (section === "dependencies") next = normalizeDependencyItem(next);
    return next;
  }

  function openAddItem(section: SectionId, row: Item) {
    setItemEditor({ mode: "add", section, index: null, draft: row, dirty: false, saveLabel: itemSaveLabel(section) });
  }

  function openEditItem(section: SectionId, index: number) {
    const existing = draft.sections[section]?.[index];
    if (!existing) return;
    setItemEditor({ mode: "edit", section, index, draft: { ...existing, fields: existing.fields.map((field) => ({ ...field })), chips: [...(existing.chips ?? [])] }, dirty: false, saveLabel: itemSaveLabel(section) });
  }

  function setItemEditorDraft(next: Item) {
    setItemEditor((current) => current ? { ...current, draft: next, dirty: true } : current);
  }

  function saveItemEditor() {
    if (!itemEditor) return;
    const saved = normalizeItemForSave(itemEditor.section, itemEditor.draft);
    setDraft((current) => {
      const rows = [...current.sections[itemEditor.section]];
      if (itemEditor.mode === "edit" && itemEditor.index !== null && rows[itemEditor.index]) rows[itemEditor.index] = saved;
      else rows.push(saved);
      return { ...current, sections: { ...current.sections, [itemEditor.section]: rows } };
    });
    setMessage(`${saved.title} saved.`);
    setItemEditor(null);
  }

  function cancelItemEditor() {
    if (itemEditor?.dirty && !window.confirm("Discard unsaved item changes?")) return;
    setItemEditor(null);
  }

  function removeItem(section: SectionId, index: number) {
    const entry = draft.sections[section]?.[index];
    if (!entry) return;
    if (!window.confirm(`Remove "${entry.title}"? This deletes only this profile object.`)) return;
    const id = entry.id;
    setDraft((current) => ({ ...current, sections: { ...current.sections, [section]: current.sections[section].filter((item) => item.id !== id) } }));
    setMessage(`${entry.title} removed.`);
  }

  function duplicateItem(section: SectionId, index: number) {
    const entry = draft.sections[section]?.[index];
    if (!entry) return;
    const copy = cloneItemForDuplicate(entry);
    setDraft((current) => ({ ...current, sections: { ...current.sections, [section]: [...current.sections[section], copy] } }));
    setMessage(`${entry.title} duplicated.`);
  }

  function toggleItem(section: SectionId, index: number) {
    setDraft((current) => {
      const rows = [...current.sections[section]];
      if (!rows[index]) return current;
      rows[index] = { ...rows[index], enabled: rows[index].enabled === false };
      return { ...current, sections: { ...current.sections, [section]: rows } };
    });
  }

  function addSectionItem(section: SectionId) {
    const meta = sectionInfo.find((entry) => entry.id === section) ?? sectionInfo[0];
    openAddItem(section, item(`custom-${Date.now()}`, `New ${meta.label}`, "Describe the behavior in Advanced Mode.", [{ label: "Setting", value: "" }]));
  }

  function addDetectionMethod() {
    openAddItem("detectionStores", makeDetectionMethod());
  }

  function addInstallRule() {
    openAddItem("installBehavior", makeInstallRule());
  }

  function addToggleStrategy() {
    openAddItem("enableDisable", makeToggleStrategy());
  }

  function addDependency(type = "Custom Dependency") {
    openAddItem("dependencies", makeDependency(type));
  }

  function addConflictRule(preset = "Ask User") {
    openAddItem("conflicts", makeConflictRule(preset));
  }

  function openAddSource(sourceType: ProfileSourceType = "nexus") {
    setSourceEditor({ mode: "add", index: null, draft: makeSource(sourceType), dirty: false, duplicateOf: null });
  }

  function openEditSource(index: number) {
    const existing = draft.sections.sources[index];
    if (!existing) return;
    const normalized = normalizeSourceItem(existing);
    setSourceEditor({ mode: "edit", index, draft: normalized, original: normalized, dirty: false, duplicateOf: null });
  }

  function setSourceEditorDraft(next: Item) {
    setSourceEditor((current) => current ? { ...current, draft: normalizeSourceItem(next), dirty: true, duplicateOf: null, message: undefined } : current);
  }

  function saveSourceEditor(addAnyway = false) {
    if (!sourceEditor) return;
    const normalized = normalizeSourceItem(sourceEditor.draft);
    const errors = sourceValidationErrors(normalized);
    if (errors.length) {
      setSourceEditor((current) => current ? { ...current, draft: normalized, message: errors[0] } : current);
      return;
    }

    const duplicate = findDuplicateSource(normalized, draft.sections.sources, sourceEditor.mode === "edit" ? sourceInstanceId(normalized) : undefined);
    if (duplicate && !addAnyway && !sourceEditor.allowDuplicate) {
      setSourceEditor((current) => current ? { ...current, draft: normalized, duplicateOf: duplicate, message: "A similar source is already configured." } : current);
      return;
    }

    const saved = replaceField(replaceField(replaceField(normalized, "Last Test Status", sourceValue(normalized, "Last Test Status") || "Untested"), "Last Tested", sourceValue(normalized, "Last Tested")), "Display Name", sourceValue(normalized, "Display Name") || sourceTypeLabel(sourceTypeFromItem(normalized)));
    const finalSource = normalizeSourceItem(saved);
    setDraft((current) => {
      const rows = [...current.sections.sources];
      if (sourceEditor.mode === "edit" && sourceEditor.index !== null && rows[sourceEditor.index]) {
        rows[sourceEditor.index] = finalSource;
      } else {
        rows.push(finalSource);
      }
      return { ...current, sections: { ...current.sections, sources: rows } };
    });
    setSourceEditor(null);
    setMessage(`${finalSource.title} source saved.`);
  }

  function cancelSourceEditor() {
    if (sourceEditor?.dirty && !window.confirm("Discard unsaved source changes?")) return;
    setSourceEditor(null);
  }

  function removeSource(index: number) {
    const source = draft.sections.sources[index];
    if (!source) return;
    const confirmed = window.confirm(`Remove source "${source.title}"? This deletes only this source instance.`);
    if (!confirmed) return;
    const removedId = sourceInstanceId(source);
    setDraft((current) => ({ ...current, sections: { ...current.sections, sources: current.sections.sources.filter((entry) => sourceInstanceId(entry) !== removedId) } }));
    setMessage(`${source.title} source removed.`);
  }

  function duplicateSource(index: number) {
    const source = draft.sections.sources[index];
    if (!source) return;
    const sourceType = sourceTypeFromItem(source);
    const instanceId = `source.${makeUserId()}`;
    let copy = normalizeSourceItem({ ...source, id: instanceId, title: `${source.title || sourceTypeLabel(sourceType)} Copy`, fields: source.fields.map((field) => ({ ...field })), chips: [...(source.chips ?? [])] }, sourceType);
    copy = replaceField(replaceField(copy, "Source Instance ID", instanceId), "Display Name", copy.title);
    setDraft((current) => ({ ...current, sections: { ...current.sections, sources: [...current.sections.sources, normalizeSourceItem(copy)] } }));
    setMessage(`${source.title} duplicated.`);
  }

  function toggleSource(index: number) {
    setDraft((current) => {
      const rows = [...current.sections.sources];
      if (!rows[index]) return current;
      rows[index] = { ...rows[index], enabled: rows[index].enabled === false };
      return { ...current, sections: { ...current.sections, sources: rows } };
    });
  }

  async function testSourceDraft(entry: Item) {
    const tested = await runProfileSourceTest(entry);
    setMessage(sourceTestPassed(tested.result) ? `${tested.entry.title} check passed: ${sourceTestMessage(tested.result)}` : `Source test failed: ${sourceTestMessage(tested.result)}`);
    setTestedSections((current) => ({ ...current, sources: sourceTestPassed(tested.result) }));
    return tested.entry;
  }
  async function testSource(index: number) {
    const source = draft.sections.sources[index];
    if (!source) return;
    const { entry, result } = await runProfileSourceTest(source);
    setDraft((current) => {
      const rows = [...current.sections.sources];
      if (!rows[index]) return current;
      rows[index] = entry;
      return { ...current, sections: { ...current.sections, sources: rows } };
    });
    setMessage(sourceTestPassed(result) ? `${entry.title} check passed: ${sourceTestMessage(result)}` : `Source test failed: ${sourceTestMessage(result)}`);
    setTestedSections((current) => ({ ...current, sources: sourceTestPassed(result) }));
  }
  function addCustomPath() {
    setCustomPathEditor({ mode: "add", index: null, draft: makeCustomPath(), dirty: false });
  }

  function openEditCustomPath(index: number) {
    const existing = draft.customPaths[index];
    if (!existing) return;
    setCustomPathEditor({ mode: "edit", index, draft: { ...existing }, dirty: false });
  }

  function setCustomPathDraft(next: CustomPath) {
    setCustomPathEditor((current) => current ? { ...current, draft: next, dirty: true } : current);
  }

  function saveCustomPathEditor() {
    if (!customPathEditor) return;
    const path = { ...customPathEditor.draft, id: customPathEditor.draft.id || pathVariableId(customPathEditor.draft.name || "Custom Path") };
    setDraft((current) => {
      const rows = [...current.customPaths];
      if (customPathEditor.mode === "edit" && customPathEditor.index !== null && rows[customPathEditor.index]) rows[customPathEditor.index] = path;
      else rows.push(path);
      return { ...current, customPaths: rows };
    });
    setMessage(`${path.name || "Named Path"} saved.`);
    setCustomPathEditor(null);
  }

  function cancelCustomPathEditor() {
    if (customPathEditor?.dirty && !window.confirm("Discard unsaved named path changes?")) return;
    setCustomPathEditor(null);
  }

  function removeCustomPath(index: number) {
    const path = draft.customPaths[index];
    if (!path) return;
    if (!window.confirm(`Remove named path "${path.name || path.id}"?`)) return;
    setDraft((current) => ({ ...current, customPaths: current.customPaths.filter((_, itemIndex) => itemIndex !== index) }));
    setMessage(`${path.name || path.id} removed.`);
  }

  function duplicateCustomPath(index: number) {
    const path = draft.customPaths[index];
    if (!path) return;
    const copy = cloneCustomPath(path);
    setDraft((current) => ({ ...current, customPaths: [...current.customPaths, copy] }));
    setMessage(`${path.name || path.id} duplicated.`);
  }

  function addCustomFileType(kind: CustomFileTypeKind = "custom_extension", presetId: ModTypePresetId = "custom") {
    setCustomTypeEditor({ mode: "add", index: null, draft: makeCustomFileType(kind, presetId), dirty: false });
  }

  function openEditCustomFileType(index: number) {
    const existing = draft.customFileTypes[index];
    if (!existing) return;
    setCustomTypeEditor({ mode: "edit", index, draft: { ...existing, extensions: [...existing.extensions], exactFilenames: [...(existing.exactFilenames ?? [])], folderMarkers: [...(existing.folderMarkers ?? [])] }, dirty: false });
  }

  function setCustomTypeDraft(next: CustomFileType) {
    setCustomTypeEditor((current) => current ? { ...current, draft: next, dirty: true } : current);
  }

  function saveCustomTypeEditor() {
    if (!customTypeEditor) return;
    const fileType = { ...customTypeEditor.draft, id: customTypeEditor.draft.id || `custom_${makeUserId()}` };
    setDraft((current) => {
      const rows = [...current.customFileTypes];
      if (customTypeEditor.mode === "edit" && customTypeEditor.index !== null && rows[customTypeEditor.index]) rows[customTypeEditor.index] = fileType;
      else rows.push(fileType);
      return { ...current, customFileTypes: rows };
    });
    setMessage(`${fileType.name || "Custom Mod Type"} saved.`);
    setCustomTypeEditor(null);
  }

  function cancelCustomTypeEditor() {
    if (customTypeEditor?.dirty && !window.confirm("Discard unsaved mod type changes?")) return;
    setCustomTypeEditor(null);
  }

  function removeCustomFileType(index: number) {
    const fileType = draft.customFileTypes[index];
    if (!fileType) return;
    if (!window.confirm(`Remove mod type "${fileType.name || fileType.id}"?`)) return;
    setDraft((current) => ({ ...current, customFileTypes: current.customFileTypes.filter((_, itemIndex) => itemIndex !== index) }));
    setMessage(`${fileType.name || fileType.id} removed.`);
  }

  function duplicateCustomFileType(index: number) {
    const fileType = draft.customFileTypes[index];
    if (!fileType) return;
    const copy = cloneCustomFileType(fileType);
    setDraft((current) => ({ ...current, customFileTypes: [...current.customFileTypes, copy] }));
    setMessage(`${fileType.name || fileType.id} duplicated.`);
  }

  async function pickNativePath(label: string, options: Parameters<typeof open>[0]) {
    try {
      const result = await open(options);
      const selected = singlePath(result);
      if (!selected) {
        setMessage(`${label} cancelled.`);
        return null;
      }
      setMessage(`${label} selected.`);
      return selected;
    } catch (error) {
      setMessage(`${label} failed: ${dialogError(error)}`);
      return null;
    }
  }

  async function storeProfileArtworkReference(next: string | null) {
    const clean = next?.trim() ?? "";
    if (!clean) return;
    logProfileArtwork("selected input", { profileId: draft.profileId, selectedPath: clean });

    try {
      let result: ProfileArtworkImportResult;
      if (/^data:image\//i.test(clean)) {
        result = await invoke<ProfileArtworkImportResult>("save_profile_artwork_data_url", { profileId: draft.profileId, dataUrl: clean });
      } else if (/^https?:\/\//i.test(clean)) {
        result = await invoke<ProfileArtworkImportResult>("cache_profile_artwork_remote_url", { profileId: draft.profileId, url: clean });
      } else if (/^blob:/i.test(clean)) {
        throw new Error("Blob image references cannot be persisted. Paste the image itself or choose the local file.");
      } else {
        result = await invoke<ProfileArtworkImportResult>("import_profile_artwork_image", { profileId: draft.profileId, sourcePath: clean });
      }

      logProfileArtwork("managed import result", result as unknown as Record<string, unknown>);
      setArtworkReference(result.imageReference, {
        originalPath: result.sourcePath,
        managedPath: result.managedPath,
        resolvedPreviewUrl: result.managedPath ? convertFileSrc(result.managedPath) : result.imageReference.value,
      });
      setMessage(`Profile artwork saved to managed storage: ${fileNameFromPath(result.managedPath)}`);
    } catch (error) {
      logProfileArtwork("managed import error", { profileId: draft.profileId, selectedPath: clean, error: dialogError(error) });
      setMessage(`Profile artwork failed: ${dialogError(error)}`);
    }
  }

  async function chooseProfileImage() {
    const selected = await pickNativePath("Choose profile image", { multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (selected) await storeProfileArtworkReference(selected);
  }

  async function chooseExecutable(section: SectionId, index: number, label = "Expected executable") {
    const selected = await pickNativePath("Choose executable", { multiple: false, filters: [{ name: "Executables", extensions: ["exe"] }] });
    if (!selected) return;
    setDraft((current) => {
      const sections = { ...current.sections };
      const rows = [...sections[section]];
      if (rows[index]) rows[index] = replaceField(rows[index], label, selected);
      sections[section] = rows;
      const launchIndex = sections.pathsLaunch.findIndex((entry) => entry.id === "launch");
      if (section === "detectionStores" || section === "pathsLaunch") {
        const launchRows = [...sections.pathsLaunch];
        if (launchIndex >= 0 && launchRows[launchIndex]) launchRows[launchIndex] = replaceField(launchRows[launchIndex], "Executable", selected);
        sections.pathsLaunch = launchRows;
      }
      const detectionRows = [...sections.detectionStores];
      if (section === "pathsLaunch") {
        for (let detectionIndex = 0; detectionIndex < detectionRows.length; detectionIndex += 1) {
          if (detectionRows[detectionIndex].enabled !== false) detectionRows[detectionIndex] = replaceField(detectionRows[detectionIndex], "Expected executable", selected);
        }
        sections.detectionStores = detectionRows;
      }
      return { ...current, sections };
    });
  }

  async function chooseMarker(section: SectionId, index: number, folder: boolean) {
    const selected = await pickNativePath(folder ? "Choose marker folder" : "Choose marker file", folder ? { directory: true, multiple: false } : { multiple: false });
    if (selected) setItemField(section, index, "Required markers", selected);
  }

  async function chooseGameFolder() {
    const selected = await pickNativePath("Choose game folder", { directory: true, multiple: false });
    if (!selected) return;
    setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleGameRoot: selected } }));
    try {
      const scan = await invoke<GameFolderScanResult>("scan_game_folder_basic", { gameFolder: selected });
      setGameFolderScan(scan);
      const exeCount = scan.executables?.length ?? 0;
      const folderCount = scan.folders?.filter((folder) => folder.relativePath).length ?? 0;
      setMessage(`Game folder scanned: ${exeCount} executable${exeCount === 1 ? "" : "s"}, ${folderCount} folder hint${folderCount === 1 ? "" : "s"}. Review suggestions before applying.`);
    } catch (error) {
      setGameFolderScan(null);
      setMessage(`Game folder selected, but scan failed: ${dialogError(error)}`);
    }
  }
  function applyGameFolderSuggestions(scan: GameFolderScanResult) {
    const suggestedName = scan.suggestedGameName?.trim() || "";
    const suggestedExecutable = scan.suggestedExecutable && scan.suggestedExecutable.path ? scan.suggestedExecutable : scan.executables?.[0];
    const suggestedFolders = (scan.folders ?? []).filter((folder) => folder.relativePath && folder.relativePath.trim());
    const markerText = suggestedFolders.slice(0, 8).map((folder) => folder.relativePath).join("|");
    const frameworkText = (scan.frameworks ?? []).join(", ");
    const architectureText = (scan.architectureHints ?? []).join(", ");
    const steamText = (scan.steamAppIds ?? []).join(", ");

    setDraft((current) => {
      const nextOverview = { ...current.overview };
      if (!nextOverview.gameName.trim() && suggestedName) nextOverview.gameName = suggestedName;
      if (!nextOverview.profileTitle.trim() && suggestedName) nextOverview.profileTitle = `${suggestedName} Profile`;
      if (!nextOverview.gameKey.trim() && suggestedName) nextOverview.gameKey = safeKey(suggestedName);
      if (!nextOverview.storefronts.trim() && steamText) nextOverview.storefronts = `Steam (${steamText})`;

      const detection = item(
        `scan-detection-${Date.now()}`,
        "Selected Game Folder",
        "Created from the reviewed folder scan. Edit before exporting if the executable or markers are wrong.",
        [
          { label: "Detection Type", value: "User selected game folder" },
          { label: "Root Folder", value: scan.gameFolder },
          { label: "Expected executable", value: suggestedExecutable?.path ?? "" },
          { label: "Required markers", value: markerText },
          { label: "Steam App ID", value: steamText },
          { label: "Architecture", value: architectureText },
          { label: "Condition mode", value: suggestedExecutable ? "Executable match AND reviewed marker folders" : "Reviewed marker folders" },
        ],
        ["Folder scan", ...(scan.frameworks ?? []), ...(scan.architectureHints ?? [])].filter(Boolean),
      );

      const pathRows = [...current.customPaths];
      const existingPathKeys = new Set(pathRows.map((row) => `${row.baseRoot}:${row.relativePath}`.toLowerCase()));
      for (const folder of suggestedFolders.slice(0, 10)) {
        const key = `game_root:${folder.relativePath}`.toLowerCase();
        if (existingPathKeys.has(key)) continue;
        const label = folder.name || folder.relativePath.split(/[\\/]/).filter(Boolean).pop() || "Game Folder";
        pathRows.push({
          id: pathVariableId(label),
          name: label,
          baseRoot: "game_root",
          relativePath: folder.relativePath,
          required: false,
          createIfMissing: false,
          writable: true,
          description: `Discovered during folder scan: ${folder.relativePath}`,
          userPrompt: "",
          validationMarkers: folder.relativePath,
        });
        existingPathKeys.add(key);
      }

      const launchFields = [
        { label: "Executable", value: suggestedExecutable?.path ?? "" },
        { label: "Working Directory", value: suggestedExecutable?.path ? suggestedExecutable.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "") : scan.gameFolder },
        { label: "Storefront launch", value: steamText ? `Steam app ${steamText}` : "Direct executable fallback" },
        { label: "Pre-launch checks", value: [frameworkText, architectureText, markerText ? "Marker folders reviewed" : ""].filter(Boolean).join("; ") },
      ];
      const launch = item("launch", "Launch Configuration", "Created from the reviewed game folder scan.", launchFields, ["Folder scan"]);
      const nextPathsLaunch = [...current.sections.pathsLaunch.filter((entry) => entry.id !== "launch"), launch];

      const nextDependencies = [...current.sections.dependencies];
      for (const framework of scan.frameworks ?? []) {
        if (nextDependencies.some((dependency) => dependency.title.toLowerCase() === framework.toLowerCase())) continue;
        let dependency = makeDependency(framework);
        dependency = replaceField(dependency, "Marker Folder", suggestedFolders.find((folder) => folder.name.toLowerCase().includes(framework.toLowerCase()))?.relativePath ?? "");
        dependency = replaceField(dependency, "Required", "Optional");
        nextDependencies.push(dependency);
      }

      return {
        ...current,
        overview: nextOverview,
        customTest: { ...current.customTest, sampleGameRoot: scan.gameFolder },
        customPaths: pathRows,
        sections: {
          ...current.sections,
          detectionStores: [...current.sections.detectionStores, detection],
          pathsLaunch: nextPathsLaunch,
          dependencies: nextDependencies,
        },
      };
    });
    setTestedSections((current) => ({ ...current, detectionStores: true, pathsLaunch: true }));
    setMessage("Folder scan suggestions applied. Review the new detection, paths, launch config, and dependency cards before export.");
  }
  async function chooseDestinationFolder(pathIndex?: number) {
    const selected = await pickNativePath("Choose destination folder", { directory: true, multiple: false });
    if (!selected) return;
    if (typeof pathIndex === "number") {
      setDraft((current) => {
        const rows = [...current.customPaths];
        const relative = relativeToRoot(selected, current.customTest.sampleGameRoot);
        rows[pathIndex] = { ...rows[pathIndex], baseRoot: relative.baseRoot, relativePath: relative.relativePath, userPrompt: relative.baseRoot === "user_selected_folder" ? selected : rows[pathIndex].userPrompt };
        return { ...current, customPaths: rows };
      });
    } else {
      setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleGameRoot: selected } }));
    }
  }

  async function chooseSampleArchive() {
    const selected = await pickNativePath("Choose sample archive", { multiple: false, filters: [{ name: "Mod archives", extensions: ["zip", "rar", "7z", "pak", "utoc", "ucas"] }] });
    if (selected) setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleArchive: selected, sampleFilename: fileNameFromPath(selected) || current.customTest.sampleFilename } }));
  }

  async function chooseDependencyArchive(index: number) {
    const selected = await pickNativePath("Choose dependency installer or archive", { multiple: false, filters: [{ name: "Dependency packages", extensions: ["zip", "rar", "7z", "exe", "dll"] }] });
    if (selected) setItemField("dependencies", index, "Installer or archive", selected);
  }

  async function importProfilePackage() {
    const selected = await pickNativePath("Import .tsukiprofile", { multiple: false, filters: [{ name: "Tsuki profile packages", extensions: ["tsukiprofile", "json"] }] });
    if (!selected) return;
    try {
      const contents = await invoke<string>("read_profile_creator_import_file", { path: selected });
      const parsed = JSON.parse(contents) as Draft;
      if (!parsed.schemaVersion || !parsed.profileId) throw new Error("File is not a Profile Creator draft.");
      if (!parsed.overview || !parsed.sections || !parsed.artwork) throw new Error("Profile package is missing required fields.");
      const imported = cleanTutorialExamples({ ...parsed, profileId: `user.${makeUserId()}`, profileType: "user_created", status: "draft", updatedAt: new Date().toISOString() });
      await invoke("save_game_profile_draft", { profileId: imported.profileId, draft: imported });
      setDraft(imported);
      void onDraftSaved?.();
      setMessage(`Imported profile package: ${fileNameFromPath(selected)}`);
    } catch (error) {
      setMessage(`Import failed: ${dialogError(error)}`);
    }
  }

  async function importRule(kind: "json" | "txt") {
    const selected = await pickNativePath(`Import ${kind.toUpperCase()} rule`, { multiple: false, filters: [{ name: `${kind.toUpperCase()} rules`, extensions: [kind] }] });
    if (!selected) return;
    try {
      const contents = await invoke<string>("read_profile_creator_import_file", { path: selected });
      setDraft((current) => ({ ...current, advancedJson: contents.trim() || current.advancedJson }));
      setMessage(`Imported rule file: ${fileNameFromPath(selected)}`);
    } catch (error) {
      setMessage(`Import failed: ${dialogError(error)}`);
    }
  }

  async function exportText(kind: "json" | "txt", contents: string, defaultName: string) {
    try {
      const target = await save({ defaultPath: defaultName, filters: [{ name: `${kind.toUpperCase()} files`, extensions: [kind] }] });
      if (!target) {
        setMessage(`${kind.toUpperCase()} export cancelled.`);
        return;
      }
      const result = await invoke<string>("write_profile_creator_text_file", { path: target, contents, extension: kind });
      setMessage(result);
    } catch (error) {
      setMessage(`${kind.toUpperCase()} export failed: ${dialogError(error)}`);
    }
  }

  async function exportDraft() {
    validate();
    if (blocked) return;
    try {
      await invoke("save_game_profile_draft", { profileId: draft.profileId, draft: cleanTutorialExamples({ ...draft, updatedAt: new Date().toISOString() }) });
      const target = await save({ defaultPath: defaultProfileExportName(draft), filters: [{ name: "Tsuki profiles", extensions: ["tsukiprofile", "json"] }] });
      if (!target) {
        setMessage("Profile export cancelled.");
        return;
      }
      const result = await invoke<string>("export_game_profile_draft_to_path", { profileId: draft.profileId, exportPath: target });
      setMessage(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function runtimeDraftSnapshot() {
    return cleanTutorialExamples({ ...draft, updatedAt: new Date().toISOString() });
  }

  function runtimeOpenOutput(result: ProfileRuntimeOpenResult, label: string) {
    return [
      `${label}: ${result.blocking.length ? `${result.blocking.length} blocker(s)` : "ready"}`,
      `Profile data: ${result.storagePath}`,
      `Profile JSON: ${result.profilePath}`,
      `Draft JSON: ${result.draftPath}`,
      `Setup state: ${result.setupStatePath}`,
      `Source index: ${result.indexPath}`,
      `Test workspace: ${result.testWorkspacePath}`,
      `Revision: ${result.revision}`,
      ...result.blocking.map((issue) => `BLOCKED [${issue.code}]: ${issue.message}`),
      ...result.warnings.map((issue) => `Warning [${issue.code}]: ${issue.message}`),
    ];
  }

  function runtimeTestOutput(result: ProfileCreatorRuntimeTestResult) {
    return [
      `${result.status}: ${result.whatWasTested}`,
      `Revision: ${result.profileRevision}${result.outdated ? " (outdated)" : ""}`,
      ...result.inputUsed.map((line) => `Input: ${line}`),
      ...result.resolvedPaths.map((line) => `Path: ${line}`),
      ...result.actions.map((line) => `Action: ${line}`),
      ...result.warnings.map((line) => `Warning: ${line}`),
      ...result.errors.map((line) => `Blocked: ${line}`),
      ...result.technicalDetails.map((line) => `Detail: ${line}`),
    ];
  }

  async function saveDraftNow() {
    try {
      const next = runtimeDraftSnapshot();
      await invoke("save_game_profile_draft", { profileId: draft.profileId, draft: next });
      setSaveState("saved");
      void onDraftSaved?.();
      setMessage("Draft saved.");
    } catch (error) {
      setSaveState("error");
      setMessage(`Save failed: ${dialogError(error)}`);
    }
  }

  async function openProfileRuntime(previewSetup = false) {
    try {
      const next = runtimeDraftSnapshot();
      setSaveState("saving");
      const result = await invoke<ProfileRuntimeOpenResult>(previewSetup ? "preview_game_profile_setup" : "open_game_profile_draft_runtime", { profileId: draft.profileId, draft: next });
      setSaveState("saved");
      void onDraftSaved?.();
      const output = runtimeOpenOutput(result, previewSetup ? "Setup preview" : "Open profile");
      setDraft((current) => ({ ...current, testOutput: output }));
      const blockerCount = result.blocking.length;
      if (blockerCount && !previewSetup) {
        const first = result.blocking[0];
        if (first?.section && sectionInfo.some((section) => section.id === first.section)) setActive(first.section as SectionId);
        setMessage(`Open Profile blocked by ${blockerCount} required issue${blockerCount === 1 ? "" : "s"}. Review the runtime output.`);
        return;
      }
      setMessage(previewSetup ? "Setup preview profile opened in the normal runtime shell." : "Draft profile opened in the normal runtime shell.");
      await onOpenProfile?.(result.profileId || draft.profileId, { previewSetup, activeSection: active, result });
    } catch (error) {
      setSaveState("error");
      setMessage(`${previewSetup ? "Preview Setup" : "Open Profile"} failed: ${dialogError(error)}`);
    }
  }

  async function detectAutomatically() {
    try {
      const result = await invoke<string>("detect_payday3_path");
      setMessage(result);
      if (/^[a-z]:|^\\\\/i.test(result)) {
        setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleGameRoot: result } }));
        setTestedSections((current) => ({ ...current, detectionStores: true }));
      }
    } catch (error) {
      setMessage(`Detection failed: ${dialogError(error)}`);
    }
  }

  async function applyProfileTemplate(templateId: ProfileTemplateId) {
    const additions = profileTemplateAdditions(templateId);
    if (templateId === "superblt" || templateId === "reframework") {
      try { additions.customFileTypes = await invoke<CustomFileType[]>("get_profile_creator_install_rules", { templateId }); }
      catch (error) { setMessage(`Template rules could not be loaded: ${dialogError(error)}`); return; }
    }
    setDraft((current) => ({
      ...current,
      customPaths: [...current.customPaths, ...additions.customPaths],
      customFileTypes: [...current.customFileTypes, ...additions.customFileTypes],
      sections: {
        ...current.sections,
        dependencies: [...current.sections.dependencies, ...additions.dependencies],
        installBehavior: [...current.sections.installBehavior, ...additions.installBehavior],
        enableDisable: [...current.sections.enableDisable, ...additions.enableDisable],
        loadOrder: [...current.sections.loadOrder, ...additions.loadOrder],
      },
    }));
    setTemplateStep("done");
    setMessage(templateId === "blank" || templateId === "custom" ? "Blank profile ready." : `${profileTemplateOptions.find((option) => option.value === templateId)?.label ?? "Template"} suggestions added. Review and edit anything before saving.`);
  }
  async function dryRun(label: string, section: SectionId = active) {
    try {
      setMessage(`${label} running through runtime checks...`);
      const result = await invoke<ProfileCreatorRuntimeTestResult>("run_profile_creator_test_action", { profileId: draft.profileId, draft: runtimeDraftSnapshot(), section, label });
      const passed = result.status.toLowerCase() === "passed";
      setDraft((current) => ({ ...current, testOutput: runtimeTestOutput(result) }));
      setTestedSections((current) => ({ ...current, [section]: passed, testProfile: section === "testProfile" ? passed : current.testProfile }));
      setMessage(`${label}: ${result.status}. ${result.errors.length ? `${result.errors.length} blocker(s).` : result.warnings.length ? `${result.warnings.length} warning(s).` : "No blockers."}`);
    } catch (error) {
      setTestedSections((current) => ({ ...current, [section]: false }));
      setMessage(`${label} failed: ${dialogError(error)}`);
    }
  }

  function validate() {
    setValidationOpen(true);
    setMessage(blocked ? `${issues.filter((issue) => issue.level === "error").length} required issue(s) must be fixed before export.` : "Profile draft validation completed. Review warnings and untested sections before release.");
  }

  function renderActiveSection() {
    const shared = { mode, dryRun, setEditorTarget };
    if (active === "gameArtwork") return <GameArtwork draft={draft} source={sourceProfile} mode={mode} setOverview={setOverview} setArtwork={setArtwork} setArtworkReference={setArtworkReference} setDraft={setDraft} chooseProfileImage={chooseProfileImage} storeProfileArtworkReference={storeProfileArtworkReference} />;
    if (active === "detectionStores") return <DetectionStoresPanel draft={draft} mode={mode} scan={gameFolderScan} applyScan={applyGameFolderSuggestions} clearScan={() => setGameFolderScan(null)} update={(i, p) => setItem("detectionStores", i, p)} addDetectionMethod={addDetectionMethod} openEditor={(index) => openEditItem("detectionStores", index)} duplicateItem={(index) => duplicateItem("detectionStores", index)} removeItem={(index) => removeItem("detectionStores", index)} toggleItem={(index) => toggleItem("detectionStores", index)} chooseExecutable={chooseExecutable} chooseMarker={chooseMarker} chooseGameFolder={chooseGameFolder} detectAutomatically={detectAutomatically} dryRun={dryRun} />;
    if (active === "pathsLaunch") return <PathsPanel draft={draft} mode={mode} tab={pathsTab} setTab={setPathsTab} scan={gameFolderScan} applyScan={applyGameFolderSuggestions} clearScan={() => setGameFolderScan(null)} update={(i, p) => setItem("pathsLaunch", i, p)} setDraft={setDraft} chooseDestinationFolder={chooseDestinationFolder} chooseExecutable={chooseExecutable} addCustomPath={addCustomPath} editCustomPath={openEditCustomPath} duplicateCustomPath={duplicateCustomPath} removeCustomPath={removeCustomPath} dryRun={dryRun} />;
    if (active === "sources") return <SourcesPanel items={draft.sections.sources} openAddSource={openAddSource} openEditSource={openEditSource} testSource={testSource} toggleSource={toggleSource} duplicateSource={duplicateSource} removeSource={removeSource} />;
    if (active === "modTypes") return <ModTypesPanel draft={draft} mode={mode} update={(i, p) => setItem("modTypes", i, p)} addCustomFileType={addCustomFileType} setDraft={setDraft} dryRun={dryRun} openEditor={(target: EditorTarget) => setEditorTarget(target)} openCustomFileType={openEditCustomFileType} duplicateCustomFileType={duplicateCustomFileType} removeCustomFileType={removeCustomFileType} />;
    if (active === "installBehavior") return <InstallRulesPanel items={draft.sections.installBehavior} mode={mode} update={(i, p) => setItem("installBehavior", i, p)} addRule={addInstallRule} openEditor={(index) => openEditItem("installBehavior", index)} duplicateItem={(index) => duplicateItem("installBehavior", index)} removeItem={(index) => removeItem("installBehavior", index)} toggleItem={(index) => toggleItem("installBehavior", index)} dryRun={dryRun} />;
    if (active === "enableDisable") return <EnableDisablePanel items={draft.sections.enableDisable} mode={mode} update={(i, p) => setItem("enableDisable", i, p)} addStrategy={addToggleStrategy} openEditor={(index) => openEditItem("enableDisable", index)} duplicateItem={(index) => duplicateItem("enableDisable", index)} removeItem={(index) => removeItem("enableDisable", index)} toggleItem={(index) => toggleItem("enableDisable", index)} dryRun={dryRun} />;
    if (active === "loadOrder") return <LoadOrderPanel draft={draft} mode={mode} setDraft={setDraft} />;
    if (active === "dependencies") return <DependenciesPanel profileId={draft.profileId} items={draft.sections.dependencies} mode={mode} update={(i, p) => setItem("dependencies", i, p)} addDependency={addDependency} openEditor={(index) => openEditItem("dependencies", index)} duplicateItem={(index) => duplicateItem("dependencies", index)} removeItem={(index) => removeItem("dependencies", index)} toggleItem={(index) => toggleItem("dependencies", index)} dryRun={dryRun} />;
    if (active === "conflicts") return <ConflictsPanel items={draft.sections.conflicts} mode={mode} update={(i, p) => setItem("conflicts", i, p)} addConflictRule={addConflictRule} openEditor={(index) => openEditItem("conflicts", index)} duplicateItem={(index) => duplicateItem("conflicts", index)} removeItem={(index) => removeItem("conflicts", index)} toggleItem={(index) => toggleItem("conflicts", index)} />;
    if (active === "updatesUninstall") return <UpdatesPanel items={draft.sections.updatesUninstall} mode={mode} update={(i, p) => setItem("updatesUninstall", i, p)} />;
    if (active === "taxonomy") return <TaxonomyPanel items={draft.sections.taxonomy} mode={mode} update={(i, p) => setItem("taxonomy", i, p)} />;
    if (active === "advancedRules") return <AdvancedRulesPanel draft={draft} mode={mode} setDraft={setDraft} importRule={importRule} exportText={exportText} />;
    if (active === "testProfile") return <TestWorkspace draft={draft} setDraft={setDraft} chooseGameFolder={chooseGameFolder} chooseSampleArchive={chooseSampleArchive} dryRun={dryRun} />;
    if (active === "reviewExport") return <ReviewPanel sectionStates={mode === "guided" ? navigationSections : sectionStates} issues={issues} blocked={blocked} setActive={openCreatorSection} exportDraft={exportDraft} draft={draft} exportJson={() => exportText("json", JSON.stringify(draft, null, 2), `${safeKey(draft.overview.profileTitle || "profile")}.json`)} />;
    return <GenericSummaryPanel section={active} items={draft.sections[active]} update={(i, p) => setItem(active, i, p)} add={() => addSectionItem(active)} {...shared} />;
  }

  return (
    <section className="profile-creator-flow creator-redesign-shell">
      <header className="profile-creator-toolbar creator-topbar-v2">
        <div className="creator-top-left">
          <button className="creator-button secondary" type="button" onClick={onBack}>Back</button>
          <div className="creator-title-block"><strong>{draft.overview.profileTitle || "New Game Profile"}</strong><span className={`creator-save-state ${saveState}`}>{saveState} - {message}</span></div>
        </div>
        <div className="creator-top-center">
          <div className="creator-mode-toggle creator-mode-toggle-v2"><button className={mode === "guided" ? "active" : ""} type="button" onClick={() => changeCreatorMode("guided")}>Guided</button><button className={mode === "advanced" ? "active" : ""} type="button" onClick={() => changeCreatorMode("advanced")}>Advanced</button></div>
        </div>
        <div className="profile-creator-actions creator-top-actions-v2">
          <button className="creator-button secondary" type="button" onClick={saveDraftNow}>Save Draft</button>
          <button className="creator-button primary" type="button" title={validationSummary} onClick={validate}>Check Setup{issueCount ? ` (${issueCount})` : ""}</button>
          <details className="creator-more-menu"><summary>More</summary><div><button type="button" onClick={() => void openProfileRuntime(false)}>Open Profile</button><button type="button" onClick={() => void openProfileRuntime(true)}>Preview Setup</button><button type="button" disabled={blocked} onClick={exportDraft}>{draft.profileType === "builtin_official" ? "Save Release Candidate" : "Export"}</button><button type="button" onClick={importProfilePackage}>Import .tsukiprofile</button><button type="button" onClick={() => exportText("json", JSON.stringify(draft, null, 2), `${safeKey(draft.overview.profileTitle || "profile")}.json`)}>Export JSON</button><button type="button" disabled title="Publishing remains disabled until validation, tests, and signed maintainer release flow are complete.">Publish Official Update</button></div></details>
        </div>
      </header>
      {!sourceProfile && templateStep !== "done" && <ProfileTemplateChooser selected={selectedProfileTemplate} setSelected={setSelectedProfileTemplate} step={templateStep} setStep={setTemplateStep} apply={applyProfileTemplate} />}
      {(sourceProfile || templateStep === "done") && <div className="profile-creator-layout creator-layout-v2">
        <StepNavigation sections={navigationSections} active={active} setActive={openCreatorSection} readyCount={readyCount} issueCount={issueCount} mode={mode} />
        <main className="profile-creator-main creator-workspace-v2">
          <section className="creator-panel creator-panel-v2">
            <PageIntro meta={activeMeta} mode={mode} helpOpen={helpOpen} setHelpOpen={setHelpOpen} />
            {renderActiveSection()}
            {mode === "guided" && <GuidedPageNavigation sections={navigationSections} active={active} setActive={openCreatorSection} />}
          </section>
        </main>
      </div>}
      {validationOpen && <ValidationDrawer issues={issues} close={() => setValidationOpen(false)} setActive={openCreatorSection} dryRun={(label, section) => dryRun(label, section)} />}
      {editorTarget && <FocusedEditor target={editorTarget} draft={draft} mode={mode} setDraft={setDraft} close={() => setEditorTarget(null)} dryRun={dryRun} chooseDestinationFolder={chooseDestinationFolder} chooseDependencyArchive={chooseDependencyArchive} />}
      {itemEditor && <ItemEditorSheet editor={itemEditor} mode={mode} draft={draft} onChange={setItemEditorDraft} onSave={saveItemEditor} onCancel={cancelItemEditor} dryRun={dryRun} />}
      {customPathEditor && <CustomPathEditorSheet editor={customPathEditor} mode={mode} sampleRoot={draft.customTest.sampleGameRoot} onChange={setCustomPathDraft} onSave={saveCustomPathEditor} onCancel={cancelCustomPathEditor} />}
      {customTypeEditor && <CustomTypeEditorSheet editor={customTypeEditor} mode={mode} draft={draft} onChange={setCustomTypeDraft} onSave={saveCustomTypeEditor} onCancel={cancelCustomTypeEditor} dryRun={dryRun} />}
      {sourceEditor && <SourceEditorSheet editor={sourceEditor} mode={mode} sources={draft.sections.sources} onChange={setSourceEditorDraft} onSave={saveSourceEditor} onCancel={cancelSourceEditor} onTest={testSourceDraft} onEditExisting={(existing) => { const index = draft.sections.sources.findIndex((source) => sourceInstanceId(source) === sourceInstanceId(existing)); if (index >= 0) openEditSource(index); }} />}
    </section>
  );
}
function ProfileTemplateChooser({ selected, setSelected, step, setStep, apply }: { selected: ProfileTemplateId; setSelected: (value: ProfileTemplateId) => void; step: "choose" | "review" | "done"; setStep: (value: "choose" | "review" | "done") => void; apply: (value: ProfileTemplateId) => void }) {
  const additions = profileTemplateAdditions(selected);
  const selectedLabel = profileTemplateOptions.find((option) => option.value === selected)?.label ?? "Blank Profile";
  const rows = [
    { label: "Named paths", values: additions.customPaths.map((path) => path.name) },
    { label: "Mod types", values: additions.customFileTypes.map((fileType) => fileType.name || modTypePresetById(selectedModTypePresetId(fileType)).label) },
    { label: "Dependencies", values: additions.dependencies.map((dependency) => dependency.title) },
    { label: "Install rules", values: additions.installBehavior.map((rule) => rule.title) },
    { label: "Enable/disable", values: additions.enableDisable.map((rule) => rule.title) },
    { label: "Load order", values: additions.loadOrder.map((rule) => rule.title) },
  ];
  return <main className="profile-creator-template-shell creator-workspace-v2"><section className="creator-panel creator-panel-v2"><PageIntro meta={{ id: "gameArtwork", label: "Choose Starting Template", subtitle: "Templates are optional suggestions used only while creating a new profile." }} mode="guided" helpOpen={false} setHelpOpen={() => undefined} />{step === "choose" ? <div className="creator-form-stack"><section className="creator-builder-section"><header><div><h3>Start With</h3><p>Blank creates an empty profile. Other templates show a review before adding suggestions.</p></div></header><OptionCards value={selected} options={profileTemplateOptions} onChange={(value) => setSelected(value as ProfileTemplateId)} /></section><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={() => selected === "blank" || selected === "custom" ? apply(selected) : setStep("review")}>{selected === "blank" || selected === "custom" ? "Start Blank" : "Review Suggestions"}</button></div></div> : <div className="creator-form-stack"><section className="creator-builder-section"><header><div><h3>{selectedLabel}</h3><p>Review exactly what will be added. Everything stays editable after applying.</p></div></header><div className="creator-guided-summary">{rows.map((row) => <><span key={`${row.label}-label`}>{row.label}</span><strong key={`${row.label}-value`}>{row.values.length ? row.values.join(", ") : "None"}</strong></>)}</div></section><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => setStep("choose")}>Back</button><button className="creator-button ghost" type="button" onClick={() => apply("blank")}>Use Blank Instead</button><button className="creator-button primary" type="button" onClick={() => apply(selected)}>Apply Suggestions</button></div></div>}</section></main>;
}
function bestCustomMatch(draft: Draft) {
  return [...draft.customFileTypes]
    .filter((fileType) => customFileTypeIssues(fileType, draft.customPaths).every((issue) => issue.level !== "error"))
    .filter((fileType) => matchFileType(fileType, draft.customTest.sampleFilename))
    .sort((a, b) => b.confidence - a.confidence || a.priority - b.priority)[0] ?? null;
}

type BuilderOption = { value: string; label: string; description: string; example?: string };

const fileTypeKindOptions: BuilderOption[] = [
  { value: "common", label: "Common", description: "Use this for a familiar mod file shape that Tsuki should recognize by extension.", example: ".pak, .dll, .lua" },
  { value: "custom_extension", label: "Custom Extension", description: "Match one or more file extensions without writing a glob pattern.", example: "" },
  { value: "filename_pattern", label: "Filename Pattern", description: "Match files by a safe archive filename pattern.", example: "mod_*.bundle" },
  { value: "folder_based", label: "Folder-Based", description: "Match a mod when a folder contains a marker file or folder.", example: "manifest.json" },
  { value: "paired_file_set", label: "Paired File Set", description: "Keep a main file and companion files together during install and rollback.", example: "*.main + *.meta" },
];

const destinationOptions: BuilderOption[] = [
  { value: "${GAME_ROOT}", label: "Game Root", description: "Install directly under the detected game folder.", example: "C:/Games/SelectedGame" },
  { value: "${GAME_EXE_DIR}", label: "Executable Folder", description: "Install beside the detected game executable.", example: ".../ExecutableFolder" },
  { value: "${DOCUMENTS}", label: "Documents", description: "Use the user's Documents folder when a game stores user-facing mods there.", example: "Documents/My Games" },
  { value: "${APP_DATA}", label: "Tsuki App Data", description: "Use Tsuki-managed profile data for generated metadata or manifests.", example: "Tsuki/game_profiles" },
  { value: "${LOCAL_APP_DATA}", label: "Local AppData", description: "Use local application data for games that store user mods there.", example: "AppData/Local/Game" },
];

const dependencyOptions: BuilderOption[] = [
  { value: "None", label: "No Dependency", description: "This mod type works without a separate framework.", example: "PAK files" },
  { value: "REFramework", label: "REFramework", description: "Framework required by REFramework scripts and plugins.", example: "reframework/autorun" },
  { value: "RED4ext", label: "RED4ext", description: "Cyberpunk framework dependency used by many supporting libraries.", example: "red4ext/plugins" },
  { value: "redscript", label: "redscript", description: "Script compiler/runtime dependency.", example: "r6/scripts" },
  { value: "ArchiveXL", label: "ArchiveXL", description: "Archive extension library for ArchiveXL content mods.", example: "archive/pc/mod" },
  { value: "TweakXL", label: "TweakXL", description: "Tweak database extension library.", example: "r6/tweaks" },
  { value: "Codeware", label: "Codeware", description: "Shared Cyberpunk scripting library.", example: "Codeware" },
  { value: "Cyber Engine Tweaks", label: "Cyber Engine Tweaks", description: "CET loader/tool dependency.", example: "plugins/cyber_engine_tweaks" },
  { value: "UE4SS", label: "UE4SS", description: "Unreal Engine scripting loader.", example: "UE4SS.dll" },
  { value: "BepInEx", label: "BepInEx", description: "Unity plugin and patcher framework.", example: "BepInEx/plugins" },
  { value: "MelonLoader", label: "MelonLoader", description: "Unity loader for MelonLoader mods.", example: "Mods/*.dll" },
  { value: "SuperBLT", label: "SuperBLT", description: "PAYDAY loader dependency.", example: "IPHLPAPI.dll" },
  { value: "BeardLib", label: "BeardLib", description: "Supporting mod dependency for BeardLib content.", example: "mods/BeardLib" },
  { value: "Logic Mod Loader", label: "Logic Mod Loader", description: "Loader dependency for logic mods.", example: "LogicMods" },
  { value: "custom", label: "Create Custom", description: "Name another framework, loader, library, tool, or supporting mod.", example: "Northstar" },
];

const enableDisableOptions: BuilderOption[] = [
  { value: "Move tracked files to disabled storage; restore by moving them back to the destination.", label: "Move To Disabled Storage", description: "Fast, reversible, and receipt-safe for most file-based mods.", example: "~mods -> Tsuki_Disabled_Mods" },
  { value: "Rename tracked files with a .disabled suffix; restore by removing the suffix.", label: "Rename With Suffix", description: "Useful when files must remain near their original folder.", example: "mod.pak.disabled" },
  { value: "Toggle loader manifest entries; restore the previous manifest from the receipt.", label: "Toggle Manifest", description: "Use when a loader owns the enable state instead of the filesystem.", example: "enabled = false" },
];

const loadOrderOptions: BuilderOption[] = [
  { value: "Filename order", label: "Filename Order", description: "The game or loader resolves order from filenames and paths.", example: "zzz_override.pak" },
  { value: "Priority layer", label: "Priority Layer", description: "Tsuki stores a layer for sorting, preview, and future manifests.", example: "300 Gameplay" },
  { value: "Loader manifest", label: "Loader Manifest", description: "A framework manifest controls the order.", example: "manifest.json" },
  { value: "Keep archive order", label: "Keep Archive Order", description: "Preserve the order discovered in the archive preview.", example: "paired files" },
];

const conflictOptions: BuilderOption[] = [
  { value: "Ask user on same destination file", label: "Ask On Same File", description: "Stop before replacing a file already owned by another receipt.", example: "overwrite, keep, or patch" },
  { value: "Warn and allow overwrite with backup", label: "Warn With Backup", description: "Create a rollback backup before replacing a tracked file.", example: "runtime DLL updates" },
  { value: "Block same destination file", label: "Block Same File", description: "Reject installs that would collide with an existing receipt.", example: "exclusive loader" },
  { value: "Allow side-by-side files", label: "Allow Side By Side", description: "Multiple mods can coexist when filenames differ.", example: "separate PAK files" },
];

const priorityOptions = [
  { value: "lowest", label: "Lowest", score: 900, description: "Late cosmetic or override files.", example: "900" },
  { value: "low", label: "Low", score: 700, description: "Normal content that should not beat framework files.", example: "700" },
  { value: "normal", label: "Normal", score: 500, description: "Default gameplay or content mods.", example: "500" },
  { value: "high", label: "High", score: 300, description: "Libraries or early support files.", example: "300" },
  { value: "critical", label: "Critical", score: 100, description: "Frameworks and loader prerequisites.", example: "100" },
];

const extensionSuggestions = [".pak", ".utoc", ".ucas", ".dll", ".lua", ".ini", ".json", ".bundle", ""];

type FileCatalogEntry = { value: string; kind: FileCatalogKind; label?: string; description?: string };

type FileCatalogGroup = { title: string; items: FileCatalogEntry[] };

const fileCatalogGroups: FileCatalogGroup[] = [
  { title: "ARCHIVES", items: [".zip", ".7z", ".rar", ".tar", ".gz", ".xz", ".tar.gz", ".tar.xz"].map((value) => ({ value, kind: "extension" })) },
  { title: "UNREAL ENGINE PACKAGES", items: [".pak", ".utoc", ".ucas", ".sig"].map((value) => ({ value, kind: "extension" })) },
  { title: "SCRIPTS", items: [".lua", ".js", ".ts", ".py", ".cs", ".json", ".xml", ".yaml", ".yml", ".toml"].map((value) => ({ value, kind: "extension" })) },
  { title: "RUNTIME AND LOADER FILES", items: [".dll", ".asi", ".exe", ".so", ".dylib", ".ini", ".cfg", ".conf"].map((value) => ({ value, kind: "extension" })) },
  { title: "UNITY AND MANAGED FILES", items: [".dll", ".bundle", ".assets", ".resource", ".resS", ".manifest"].map((value) => ({ value, kind: "extension" })) },
  { title: "TEXTURES AND MATERIALS", items: [".png", ".jpg", ".jpeg", ".webp", ".dds", ".tga", ".bmp", ".texture", ".material", ".material_config"].map((value) => ({ value, kind: "extension" })) },
  { title: "AUDIO", items: [".wav", ".ogg", ".mp3", ".flac", ".wem", ".bnk", ".stream"].map((value) => ({ value, kind: "extension" })) },
  { title: "VIDEO", items: [".mp4", ".webm", ".bk2", ".bik", ".usm"].map((value) => ({ value, kind: "extension" })) },
  { title: "MODELS AND ANIMATION", items: [".fbx", ".obj", ".mesh", ".model", ".animation", ".anim"].map((value) => ({ value, kind: "extension" })) },
  { title: "MOD METADATA AND MARKERS", items: ["mod.txt", "main.xml", "main.lua", "manifest.json", "mod.json", "info.json", "metadata.json", "package.json"].map((value) => ({ value, kind: "exact" })) },
  { title: "LEGACY OR SPECIAL PACKAGES", items: [".pdmod", ".patch", ".mod", ".pack", ".vpk"].map((value) => ({ value, kind: "extension" })) },
];

const fileMatchModeOptions: BuilderOption[] = [
  { value: "any", label: "Any Selected Type", description: "Match when at least one selected extension, exact file, or marker is present." },
  { value: "all", label: "All Selected Types", description: "Archive-level rule: require every selected type during install preview." },
  { value: "exact_file", label: "One Exact File", description: "Match by a specific filename such as manifest.json or mod.txt." },
  { value: "folder", label: "Contains Folder Or Marker", description: "Match a folder or structure marker inside the archive." },
  { value: "whole_folder", label: "Whole Mod Is One Folder", description: "Treat the top-level folder as the mod package." },
  { value: "same_basename", label: "Files Share Same Name", description: "Use for paired files such as .pak + .utoc + .ucas." },
  { value: "custom", label: "Custom Rule", description: "Advanced glob-style match rule written by a maintainer." },
];

const disableRecipeOptions: BuilderOption[] = [
  { value: "move_folder", label: "Move Whole Mod Folder", description: "Disable by moving the tracked mod folder, then restore it to the same path." },
  { value: "move_files", label: "Move Every Installed File", description: "Disable each tracked receipt file individually and keep exact restore paths." },
  { value: "suffix_files", label: "Add .disabled To Every File", description: "Keep files in place but rename each tracked file with a disabled suffix." },
  { value: "move_and_suffix", label: "Move Files Into Disabled Folder And Add .disabled", description: "Move tracked files into disabled storage and rename each moved file." },
  { value: "rename_main_file", label: "Rename One Main File", description: "Disable by renaming a loader's primary file only." },
  { value: "config_value", label: "Change A Config Value", description: "Disable by flipping a manifest, INI, JSON, or config value." },
  { value: "loader_controlled", label: "Let Loader Control It", description: "Tsuki records the state while the loader owns enable/disable behavior." },
  { value: "unsupported", label: "Disabling Not Supported", description: "Users can install and uninstall, but Tsuki will not offer a disable action." },
  { value: "custom", label: "Custom Behavior", description: "Advanced maintainer-defined reversible behavior." },
];

const disabledFolderLocationOptions: Array<{ value: DisabledFolderLocation; label: string; description: string }> = [
  { value: "inside_install_folder", label: "Inside Install Folder", description: "Create the disabled folder inside the mod type destination." },
  { value: "selected_mods_folder", label: "Selected Mods Folder", description: "Use the selected mod type destination as the disabled storage root." },
  { value: "game_folder", label: "Game Folder", description: "Create the disabled folder directly under the game folder." },
  { value: "profile_disabled_storage", label: "Profile-Managed Disabled Storage", description: "Use Tsuki's profile-managed disabled storage." },
  { value: "choose_another_folder", label: "Choose Another Folder", description: "Let the profile choose a specific disabled storage folder." },
  { value: "custom_path", label: "Custom Path", description: "Use a named path or approved path expression." },
];

const renameBehaviorOptions: Array<{ value: RenameBehavior; label: string }> = [
  { value: "after_filename", label: "After Complete Filename" },
  { value: "before_extension", label: "Before Extension" },
  { value: "replace_extension", label: "Replace Extension" },
  { value: "custom_suffix", label: "Custom Suffix" },
  { value: "custom_rule", label: "Custom Rule" },
];

const toggleMoveModeOptions: Array<{ value: ToggleMoveMode; label: string }> = [
  { value: "tracked_files", label: "Every Tracked File" },
  { value: "whole_folder", label: "Whole Folder" },
  { value: "auto", label: "Automatically Choose" },
];

const folderSuffixTargetOptions: Array<{ value: FolderSuffixTarget; label: string }> = [
  { value: "folder", label: "Suffix Folder" },
  { value: "files", label: "Suffix Files" },
  { value: "folder_and_files", label: "Suffix Folder And Files" },
];

const disableConflictOptions: Array<{ value: DisableConflictBehavior; label: string }> = [
  { value: "ask", label: "Ask User" },
  { value: "replace_same_receipt", label: "Replace Only If Same Receipt" },
  { value: "numbered_name", label: "Create Numbered Name" },
  { value: "stop_error", label: "Stop With Error" },
];

const rootDescriptions: Record<string, string> = {
  game_root: "The detected installation folder for this game.",
  game_exe_dir: "The folder containing the game executable.",
  profile_data: "Tsuki profile data storage for this game.",
  profile_disabled_storage: "Receipt-safe storage for disabled files.",
  profile_backup_storage: "Rollback backups created by Tsuki.",
  profile_cache: "Temporary profile cache managed by Tsuki.",
  documents: "The user's Documents folder.",
  appdata: "Roaming application data.",
  localappdata: "Local application data.",
  user_selected_folder: "Ask the user to choose a folder during setup.",
};

const sectionExamples: Partial<Record<SectionId, string>> = {
  detectionStores: "Example: If the selected executable and required marker folder exist, this profile matches.",
  sources: "Example: ModWorkshop and Nexus cards keep source IDs, URLs, metadata, categories, and downloads separate.",
  installBehavior: "Example: If an archive contains a recognized mod file, copy it to the configured destination and write a receipt.",
  enableDisable: "Example: Disable by moving only tracked receipt files, then enable by restoring those exact paths.",
  loadOrder: "Example: Framework files can sit at priority 100 while late overrides sit at 900.",
  dependencies: "Example: UE4SS is a framework dependency, not a mod category.",
  conflicts: "Example: If two mods want the same destination file, ask before replacing it.",
  updatesUninstall: "Example: Update replaces tracked files, removes obsolete receipt entries, and keeps rollback data until success.",
  taxonomy: "Example: ModWorkshop Audio and Nexus Audio are separate source/type tags even if the label matches.",
  testProfile: "Example: Drop in a sample filename to see which custom type wins before exporting.",
};

function copyText(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

type NativePathFile = File & { path?: string; webkitRelativePath?: string };

function nativePathFromFile(file: File) {
  const native = file as NativePathFile;
  return native.path || native.webkitRelativePath || "";
}

function firstTransferLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
}

function isImageReference(value: string) {
  const clean = value.trim();
  return /^data:image\//i.test(clean) || /^blob:/i.test(clean) || /^https?:\/\//i.test(clean) || /^file:\/\//i.test(clean) || /\.(png|jpe?g|webp|gif|bmp|avif)([?#].*)?$/i.test(clean) || /^[a-z]:[\\/].*\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(clean);
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read clipboard image."));
    reader.readAsDataURL(file);
  });
}

async function fileReferenceValue(file: File, imageOnly: boolean) {
  const nativePath = nativePathFromFile(file);
  if (nativePath && (!imageOnly || isImageReference(nativePath) || file.type.startsWith("image/"))) return nativePath;
  if (imageOnly && file.type.startsWith("image/")) return fileToDataUrl(file);
  if (!imageOnly) return nativePath || file.name;
  return null;
}

async function transferReferenceValue(data: DataTransfer, imageOnly = false) {
  for (const file of Array.from(data.files ?? [])) {
    const value = await fileReferenceValue(file, imageOnly);
    if (value) return value;
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const value = await fileReferenceValue(file, imageOnly);
    if (value) return value;
  }
  const text = firstTransferLine(data.getData("text/uri-list") || data.getData("text/plain") || "");
  if (text && (!imageOnly || isImageReference(text))) return text;
  return null;
}

async function droppedReferenceValue(event: DragEvent<HTMLElement>, imageOnly = false) {
  event.preventDefault();
  return transferReferenceValue(event.dataTransfer, imageOnly);
}

async function pastedReferenceValue(event: ClipboardEvent<HTMLElement>, imageOnly = false) {
  const value = await transferReferenceValue(event.clipboardData, imageOnly);
  if (value) event.preventDefault();
  return value;
}

async function readClipboardReference(imageOnly = false) {
  const clipboard = navigator.clipboard as (Clipboard & { read?: () => Promise<ClipboardItem[]> }) | undefined;
  if (!clipboard) return null;
  if (imageOnly && clipboard.read) {
    try {
      const items = await clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        return fileToDataUrl(new File([blob], "clipboard-image", { type: imageType }));
      }
    } catch {
      // Text clipboard remains available even when image clipboard access is denied.
    }
  }
  try {
    const text = firstTransferLine(await clipboard.readText());
    if (text && (!imageOnly || isImageReference(text))) return text;
  } catch {
    return null;
  }
  return null;
}

function isImageFieldLabel(label: string) {
  return /image|artwork|thumbnail|icon|cover/i.test(label);
}

function TransferTextInput({ value, onChange, imageOnly = false, placeholder = "", className = "setting-input", readOnly = false }: { value: string; onChange: (value: string) => void; imageOnly?: boolean; placeholder?: string; className?: string; readOnly?: boolean }) {
  const applyTransfer = (next: string | null) => {
    if (next && !readOnly) onChange(next);
  };
  return <input className={className} value={value} placeholder={placeholder} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void droppedReferenceValue(event, imageOnly).then(applyTransfer)} onPaste={(event) => void pastedReferenceValue(event, imageOnly).then(applyTransfer)} />;
}

function priorityLevelFromValue(value: number) {
  return priorityOptions.reduce((best, option) => Math.abs(option.score - value) < Math.abs(best.score - value) ? option : best, priorityOptions[0]).value;
}

function priorityScore(level: string) {
  return priorityOptions.find((option) => option.value === level)?.score ?? 500;
}

function optionValueOrCustom(value: string, options: BuilderOption[]) {
  return options.some((option) => option.value === value) ? value : "custom";
}

function CreatorGuide({ title, description, example, children }: { title: string; description: string; example?: string; children?: ReactNode }) {
  return <article className="creator-guide-card"><div><p className="eyebrow">Builder guide</p><h2>{title}</h2><p>{description}</p>{example && <small>{example}</small>}</div>{children && <div className="creator-guide-actions">{children}</div>}</article>;
}

function BuilderSection({ title, description, example, children }: { title: string; description: string; example?: string; children: ReactNode }) {
  return <section className="creator-builder-section"><header><div><h3>{title}</h3><p>{description}</p>{example && <small>{example}</small>}</div></header>{children}</section>;
}

type FormGridColumns = "one" | "two" | "three" | "auto";
type FormFieldSize = "small" | "medium" | "wide";

function creatorLayoutClass(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function FormGrid({ columns = "one", compact = false, className = "", children }: { columns?: FormGridColumns; compact?: boolean; className?: string; children: ReactNode }) {
  return <div className={creatorLayoutClass("creator-form-grid-v3", `columns-${columns}`, compact && "compact", className)}>{children}</div>;
}

function FormRow({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={creatorLayoutClass("creator-form-row-v3", className)}>{children}</div>;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="creator-field-label">{children}</span>;
}

function FieldHelp({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <small className="creator-field-help">{children}</small>;
}

function FormField({ label, help, size = "medium", className = "", children }: { label: ReactNode; help?: ReactNode; size?: FormFieldSize; className?: string; children: ReactNode }) {
  return <label className={creatorLayoutClass("creator-form-field", `field-${size}`, className)}><FieldLabel>{label}</FieldLabel>{help && <FieldHelp>{help}</FieldHelp>}{children}</label>;
}

function FormActions({ align = "right", className = "", children }: { align?: "left" | "right" | "between"; className?: string; children: ReactNode }) {
  return <div className={creatorLayoutClass("creator-form-actions", `align-${align}`, className)}>{children}</div>;
}

function WizardSection({ title, className = "", children }: { title: string; className?: string; children: ReactNode }) {
  return <section className={creatorLayoutClass("creator-field-section", "creator-wizard-section", className)}><header><h2>{title}</h2></header>{children}</section>;
}

function PickerCards({ value, options, onChange, compact = false }: { value: string; options: BuilderOption[]; onChange: (value: string) => void; compact?: boolean }) {
  return <div className={"creator-picker-grid " + (compact ? "compact" : "")}>{options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" key={option.value} onClick={() => onChange(option.value)}><strong>{option.label}</strong><span>{option.description}</span>{option.example && <small>{option.example}</small>}</button>)}</div>;
}

function ToggleCards({ options }: { options: Array<{ label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }> }) {
  return <div className="creator-toggle-grid">{options.map((option) => <label className={option.checked ? "selected" : ""} key={option.label}><input type="checkbox" checked={option.checked} onChange={(event) => option.onChange(event.target.checked)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</div>;
}

function ValidationCard({ issues, empty = "Ready to export." }: { issues: Array<{ level: IssueLevel; text: string }>; empty?: string }) {
  if (!issues.length) return <div className="creator-validation-card ready"><strong>Ready</strong><span>{empty}</span></div>;
  return <div className="creator-validation-card">{issues.map((issue) => <span className={issue.level} key={issue.text}><strong>{issue.level === "error" ? "Fix required" : issue.level === "warning" ? "Review" : "Suggestion"}</strong>{issue.text}</span>)}</div>;
}

function FolderSelector({ path, sampleRoot, update }: { path: CustomPath; sampleRoot: string; update: (patch: Partial<CustomPath>) => void }) {
  const rootOptions = approvedRoots.map((root) => ({ value: root, label: nice(root), description: rootDescriptions[root] ?? "Approved folder root.", example: rootPreview(root, sampleRoot) }));
  const preview = resolvePathPreview(path, sampleRoot);
  async function chooseFolder() {
    const selected = await openPath("folder");
    if (selected) update({ baseRoot: "user_selected_folder", userPrompt: formatFriendlyPath(selected), relativePath: "" });
  }
  return <BuilderSection title="Folder Picker" description="Choose an approved root, then add only the relative folder inside that root." example="Example: Game Root + CustomMods becomes a reusable profile path."><PickerCards value={path.baseRoot} options={rootOptions} onChange={(baseRoot) => update({ baseRoot })} compact /><div className="creator-folder-compose"><label>Folder name or relative path<TransferTextInput value={path.relativePath} placeholder="Mods/MyCustomFolder" onChange={(relativePath) => update({ relativePath })} /></label><div className="creator-picker-actions"><button className="creator-button primary" type="button" onClick={() => void chooseFolder()}>Choose Folder</button></div></div><div className="creator-live-preview"><span>Resolved preview</span><code>{preview}</code></div></BuilderSection>;
}

function ExtensionEditor({ fileType, update }: { fileType: CustomFileType; update: (patch: Partial<CustomFileType>) => void }) {
  const activeExtensions = [fileType.extension, ...(fileType.allowMultipleExtensions ? fileType.extensions : [])];
  const shownExtensions = activeExtensions.length ? activeExtensions : [""];
  function setExtension(index: number, value: string) {
    if (index === 0) update({ extension: value });
    else {
      const next = [...fileType.extensions];
      next[index - 1] = value;
      update({ extensions: next });
    }
  }
  function addExtension(value = ".custommod") {
    if (!fileType.allowMultipleExtensions) update({ allowMultipleExtensions: true, extensions: [value] });
    else update({ extensions: [...fileType.extensions, value] });
  }
  function removeExtension(index: number) {
    if (index === 0) {
      const rest = fileType.extensions;
      update({ extension: rest[0] ?? "", extensions: rest.slice(1) });
      return;
    }
    update({ extensions: fileType.extensions.filter((_, extensionIndex) => extensionIndex !== index - 1) });
  }
  return <BuilderSection title="Extension Picker" description="Add extensions as chips. Tsuki normalizes them before matching." example="Add custom extensions as chips. Examples are placeholders only."><div className="creator-extension-chip-row">{shownExtensions.map((extension, index) => <span className="creator-editable-chip" key={index}><input aria-label={index === 0 ? "Primary extension" : "Additional extension"} value={extension} placeholder="" onChange={(event) => setExtension(index, event.target.value)} onBlur={(event) => setExtension(index, normalizeExtensionInput(event.target.value, fileType.caseSensitive))} />{(index > 0 || shownExtensions.length > 1) && <button type="button" onClick={() => removeExtension(index)}>Remove</button>}</span>)}<button className="creator-add-chip" type="button" onClick={() => addExtension()}>Add Extension</button></div><div className="creator-suggestion-row">{extensionSuggestions.map((extension) => <button type="button" key={extension} onClick={() => fileType.allowMultipleExtensions ? addExtension(extension) : update({ extension })}>{extension}</button>)}</div><label className="creator-inline-toggle"><input type="checkbox" checked={fileType.allowMultipleExtensions} onChange={(event) => update({ allowMultipleExtensions: event.target.checked })} />Match more than one extension</label>{fileType.allowMultipleExtensions && <label>Extension group behavior<select className="setting-input" value={fileType.extensionGroupMode} onChange={(event) => update({ extensionGroupMode: event.target.value as ExtensionGroupMode })}><option value="any">Any extension matches</option><option value="all_paired">All paired extensions are required</option><option value="optional_companions">Companion files are optional</option></select></label>}</BuilderSection>;
}

function DetectionBuilder({ fileType, update }: { fileType: CustomFileType; update: (patch: Partial<CustomFileType>) => void }) {
  return <BuilderSection title="Detection Builder" description="Tell Tsuki how to recognize this mod type inside an archive." example="Builds a safe declarative rule; it does not run code."><div className="creator-rule-builder"><span>If</span><select className="setting-input" value={fileType.kind} onChange={(event) => update({ kind: event.target.value as CustomFileTypeKind })}>{fileTypeKindOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>{(fileType.kind === "custom_extension" || fileType.kind === "common") && <strong>extension matches the selected chip list</strong>}{fileType.kind === "filename_pattern" && <input className="setting-input" value={fileType.filenamePattern} placeholder="mod_*.bundle" onChange={(event) => update({ filenamePattern: event.target.value })} />}{fileType.kind === "folder_based" && <input className="setting-input" value={fileType.folderMarker} placeholder="manifest.json or Mods/" onChange={(event) => update({ folderMarker: event.target.value })} />}{fileType.kind === "paired_file_set" && <><input className="setting-input" value={fileType.filenamePattern} placeholder="*.main" onChange={(event) => update({ filenamePattern: event.target.value })} /><span>and companion</span><input className="setting-input" value={fileType.companionPattern} placeholder="*.meta" onChange={(event) => update({ companionPattern: event.target.value })} /></>}<span>Then</span><strong>Matches this mod type</strong></div><ToggleCards options={[{ label: "Case sensitive", description: "Only enable for loaders that treat names differently by case.", checked: fileType.caseSensitive, onChange: (checked) => update({ caseSensitive: checked }) }, { label: "Paired file required", description: "Install only when companion files are present.", checked: fileType.pairedRequired, onChange: (checked) => update({ pairedRequired: checked }) }]} /></BuilderSection>;
}

function DestinationPicker({ destination, paths, sampleRoot, fileName, preserveStructure, update }: { destination: string; paths: CustomPath[]; sampleRoot: string; fileName: string; preserveStructure: boolean; update: (destination: string) => void }) {
  const pathOptions = paths.map((path) => ({ value: pathVariable(path), label: path.name || path.id, description: "Profile-scoped custom path.", example: resolvePathPreview(path, sampleRoot) }));
  const options = [...destinationOptions, ...pathOptions, { value: "custom", label: "Custom", description: "Use an approved variable or custom path expression.", example: "${PATH:CUSTOM_PATH}" }];
  const selected = optionValueOrCustom(destination, [...destinationOptions, ...pathOptions]);
  return <BuilderSection title="Destination Selector" description="Choose where matched files are installed. Absolute paths are blocked; use approved roots or custom paths." example="Preview updates without writing files."><PickerCards value={selected} options={options} onChange={(value) => value === "custom" ? update(destination || "${GAME_ROOT}") : update(value)} />{selected === "custom" && <label>Custom destination<TransferTextInput value={destination} onChange={update} /></label>}<div className="creator-live-preview"><span>Example operation</span><code>{fileName} -&gt; {resolveDestination(destination, paths, fileName, preserveStructure, sampleRoot)}</code></div></BuilderSection>;
}

function DependencyPicker({ value, update }: { value: string; update: (value: string) => void }) {
  const selected = optionValueOrCustom(value, dependencyOptions.filter((option) => option.value !== "custom"));
  return <BuilderSection title="Dependency Builder" description="Choose a framework or loader required before this mod type can work." example="Dependency checks warn users before install; they do not remove shared frameworks."><PickerCards value={selected} options={dependencyOptions} onChange={(next) => next === "custom" ? update(value && value !== "None" ? value : "Custom Framework") : update(next)} />{selected === "custom" && <label>Custom dependency name<input className="setting-input" value={value} onChange={(event) => update(event.target.value)} /></label>}</BuilderSection>;
}

function PriorityPicker({ value, update }: { value: number; update: (value: number) => void }) {
  return <BuilderSection title="Load Priority" description="Pick a human label first. Raw numbers stay in Advanced for maintainers." example="Lower numbers represent earlier framework-style layers."><PickerCards value={priorityLevelFromValue(value)} options={priorityOptions.map(({ score: _score, ...option }) => option)} onChange={(level) => update(priorityScore(level))} compact /><div className="creator-live-preview"><span>Stored priority</span><code>{value}</code></div></BuilderSection>;
}

function StrategyBuilder({ fileType, update }: { fileType: CustomFileType; update: (patch: Partial<CustomFileType>) => void }) {
  return <BuilderSection title="Install Behavior" description="Choose reversible behavior that keeps receipts and rollback paths intact." example="Editing a card never changes tracked installed files; it only updates the profile draft."><PickerCards value={optionValueOrCustom(fileType.enableDisableStrategy, enableDisableOptions)} options={enableDisableOptions} onChange={(value) => update({ enableDisableStrategy: value })} /><PickerCards value={optionValueOrCustom(fileType.loadOrderStrategy, loadOrderOptions)} options={loadOrderOptions} onChange={(value) => update({ loadOrderStrategy: value })} compact /><PickerCards value={optionValueOrCustom(fileType.conflictPolicy, conflictOptions)} options={conflictOptions} onChange={(value) => update({ conflictPolicy: value })} compact /><ToggleCards options={[{ label: "Preserve folder structure", description: "Keep archive subfolders below the destination.", checked: fileType.preserveStructure, onChange: (checked) => update({ preserveStructure: checked }) }, { label: "Flatten wrapper folder", description: "Remove one top-level wrapper folder when safe.", checked: fileType.flattenWrapper, onChange: (checked) => update({ flattenWrapper: checked }) }]} /></BuilderSection>;
}

function filtersForMode(mode: SelectorMode) {
  if (mode === "executable") return [{ name: "Executables", extensions: ["exe"] }];
  if (mode === "archive") return [{ name: "Mod archives", extensions: ["zip", "7z", "rar", "pak", "utoc", "ucas"] }];
  if (mode === "image") return [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }];
  if (mode === "dependencyFile") return [{ name: "Dependency files", extensions: ["dll", "exe", "ini", "json", "xml", "txt"] }];
  if (mode === "file" || mode === "markerFile") return [{ name: "Files", extensions: ["*"] }];
  return undefined;
}

async function openPath(mode: SelectorMode, multiple = false) {
  try {
    const result = await open({ multiple, directory: mode === "folder" || mode === "markerFolder", filters: filtersForMode(mode) });
    if (Array.isArray(result)) return result.join("|");
    return result ?? "";
  } catch (error) {
    const message = `Profile Creator picker failed: ${dialogError(error)}`;
    window.dispatchEvent(new CustomEvent("tsuki-profile-creator-picker-error", { detail: { mode, message } }));
    throw new Error(message);
  }
}
function FileSelector({ value, onChange, dryRun, label = "File", mode = "file", multiple = false, showOverride = false }: { value: string; onChange: (value: string) => void; dryRun: (label: string) => void; label?: string; mode?: SelectorMode; multiple?: boolean; showOverride?: boolean }) {
  const imageOnly = mode === "image";
  async function browse() {
    try {
      const selected = await openPath(mode, multiple);
      if (selected) onChange(selected);
    } catch {
      // openPath dispatches a creator-level error message.
    }
  }
  async function paste() {
    const selected = await readClipboardReference(imageOnly);
    if (selected) onChange(selected);
  }
  return <div className="creator-selector file-selector" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void droppedReferenceValue(event, imageOnly).then((selected) => selected && onChange(selected))}><div className="creator-selector-main"><strong>{label}</strong><span>{value ? fileNameFromPath(value) : "Not selected"}</span>{showOverride && <details className="creator-advanced-panel" open><summary>Advanced File Override</summary><TransferTextInput value={value} onChange={onChange} imageOnly={imageOnly} placeholder={imageOnly ? "Paste image URL or local image path" : "Paste or type a local path"} /></details>}</div><FormActions className="creator-picker-actions" align="right"><button className="creator-button secondary" type="button" onClick={() => void browse()}>{mode === "archive" ? "Choose Archive" : mode === "executable" ? "Choose Executable" : mode === "image" ? "Choose Image" : "Browse"}</button><button className="creator-button secondary" type="button" onClick={() => void paste()}>Paste</button><button className="creator-button primary" type="button" onClick={() => dryRun(`Test ${label}`)}>Test</button><button className="creator-button secondary danger-button" type="button" onClick={() => onChange("")}>Clear</button></FormActions></div>;
}

function PathSelector({ label, value, mode, paths = [], sampleRoot, onChange, dryRun, allowNamed = true }: { label: string; value: string; mode: Mode; paths?: CustomPath[]; sampleRoot: string; onChange: (value: string) => void; dryRun: (label: string) => void; allowNamed?: boolean }) {
  const pathOptions = paths.map((path) => ({ value: pathVariable(path), label: path.name || path.id }));
  const namedOptions = [...destinationOptions.map((option) => ({ value: option.value, label: option.label })), ...pathOptions];
  const selected = namedOptions.find((option) => option.value === value);
  const resolvedPath = value ? friendlyPath(resolvePathExpression(value, paths, sampleRoot)) : "Not selected";
  async function browseFolder() {
    try {
      const selectedPath = await openPath("folder");
      if (selectedPath) onChange(selectedPath);
    } catch {
      // openPath dispatches a creator-level error message.
    }
  }
  async function paste() {
    const selectedPath = await readClipboardReference(false);
    if (selectedPath) onChange(selectedPath);
  }
  return <div className="creator-selector path-selector" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void droppedReferenceValue(event, false).then((selectedPath) => selectedPath && onChange(selectedPath))}><div className="creator-selector-main"><strong>{label}</strong><span>{selected?.label ?? (value ? friendlyPath(value) : "Not selected")}</span>{allowNamed && <FormField label="Named path" help="Choose a neutral destination or one of this profile's custom paths." size="wide" className="creator-path-select-field"><select className="setting-input" value={selected?.value ?? ""} onChange={(event) => event.target.value && onChange(event.target.value)}><option value="">Choose named path...</option>{namedOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField>}<div className="creator-path-summary"><span>Resolved path</span><code>{resolvedPath}</code></div><details className="creator-advanced-panel" open={mode === "advanced"}><summary>{mode === "advanced" ? "Advanced Path Override" : "Type Or Paste Path"}</summary><FormField label="Path" help="Browse, drag a folder, paste a path, or type manually." size="wide"><TransferTextInput value={value} onChange={onChange} placeholder="Paste or type a folder path" /></FormField></details></div><FormActions className="creator-picker-actions" align="right"><button className="creator-button secondary" type="button" onClick={() => void browseFolder()}>Choose Folder</button><button className="creator-button secondary" type="button" onClick={() => void paste()}>Paste</button><button className="creator-button primary" type="button" onClick={() => dryRun(`Test ${label}`)}>Test</button><button className="creator-button secondary danger-button" type="button" onClick={() => onChange("")}>Clear</button></FormActions></div>;
}
function ValueBuilder({ field, onChange, dryRun }: { field: Field; onChange: (value: string) => void; dryRun: (label: string) => void }) {
  const lower = field.label.toLowerCase();
  if (lower.includes("executable")) return <FileSelector value={field.value} onChange={onChange} dryRun={dryRun} />;
  if (lower === "when" || lower === "then" || lower.includes("detection") || lower.includes("marker")) return <div className="creator-value-card rule-value-card"><strong>{field.label}</strong><p>{lower === "then" ? "The action Tsuki previews and tracks in the receipt." : "A visual detection rule written in plain language."}</p><code>{field.value || "Not configured"}</code><details><summary>Edit rule text</summary><input className="setting-input" value={field.value} onChange={(event) => onChange(event.target.value)} /></details></div>;
  if (lower.includes("destination") || lower.includes("install location") || lower.includes("folder") || lower.includes("directory")) return <div className="creator-value-card folder-value-card"><strong>{field.label}</strong><p>Use approved roots, path variables, or a configured folder picker.</p><code>{field.value || "Not configured"}</code><div className="creator-picker-actions"><button className="ghost-button compact" type="button" onClick={() => copyText(field.value)}>Copy</button><button className="ghost-button compact" type="button" onClick={() => dryRun(`Preview ${field.label}`)}>Preview</button></div><details><summary>Edit path</summary><TransferTextInput value={field.value} onChange={onChange} /></details></div>;
  return <div className="creator-value-card"><strong>{field.label}</strong><code>{field.value || "Not configured"}</code><details><summary>Edit value</summary><input className="setting-input" value={field.value} onChange={(event) => onChange(event.target.value)} /></details></div>;
}

function SourceCard({ item: it, index, update, dryRun }: { item: Item; index: number; update: (index: number, patch: Partial<Item>) => void; dryRun: (label: string) => void }) {
  return <article className={`creator-config-card creator-source-card ${it.enabled ? "enabled" : ""}`}><header><label className="creator-toggle"><input type="checkbox" checked={Boolean(it.enabled)} onChange={(event) => update(index, { enabled: event.target.checked })} />{it.title}</label><span>{it.enabled ? "Enabled" : "Disabled"}</span></header><p>{it.summary}</p><div className="creator-builder-list">{it.fields.map((field, fieldIndex) => <ValueBuilder key={`${it.id}-${field.label}`} field={field} dryRun={dryRun} onChange={(value) => { const fields = [...it.fields]; fields[fieldIndex] = { ...fields[fieldIndex], value }; update(index, { fields }); }} />)}</div>{it.chips?.length ? <div className="creator-chip-row">{it.chips.map((chip) => <span key={chip}>{chip}</span>)}</div> : null}<div className="creator-card-actions"><button className="ghost-button compact" type="button" onClick={() => dryRun(`Test ${it.title}`)}>Test</button></div><details className="creator-advanced-panel"><summary>Advanced text</summary><textarea className="setting-input" value={it.summary} onChange={(event) => update(index, { summary: event.target.value })} /></details></article>;
}

function ModTypeCard({ section, item: it, index, update, dryRun }: { section: SectionId; item: Item; index: number; update: (index: number, patch: Partial<Item>) => void; dryRun: (label: string) => void }) {
  return <article className={`creator-config-card creator-modtype-card ${it.enabled ? "enabled" : ""}`}><header><label className="creator-toggle"><input type="checkbox" checked={Boolean(it.enabled)} onChange={(event) => update(index, { enabled: event.target.checked })} />{it.title}</label><span>{it.enabled ? "Ready" : "Disabled"}</span></header><p>{it.summary}</p><div className="creator-builder-list">{it.fields.map((field, fieldIndex) => <ValueBuilder key={`${it.id}-${field.label}`} field={field} dryRun={dryRun} onChange={(value) => { const fields = [...it.fields]; fields[fieldIndex] = { ...fields[fieldIndex], value }; update(index, { fields }); }} />)}</div>{it.chips?.length ? <div className="creator-chip-row">{it.chips.map((chip) => <span key={chip}>{chip}</span>)}</div> : null}<div className="creator-card-actions"><button className="ghost-button compact" type="button" onClick={() => dryRun(section === "conflicts" ? `Simulate ${it.title}` : section === "installBehavior" ? `Dry-run ${it.title}` : `Test ${it.title}`)}>{section === "installBehavior" ? "Dry-Run Rule" : section === "conflicts" ? "Simulate Conflict" : "Test"}</button></div><details className="creator-advanced-panel"><summary>Advanced text</summary><textarea className="setting-input" value={it.summary} onChange={(event) => update(index, { summary: event.target.value })} /></details></article>;
}
function GameArtwork({ draft, source, mode = "guided", setOverview, setArtwork, setArtworkReference, setDraft, chooseProfileImage, storeProfileArtworkReference }: { draft: Draft; source: GameProfile | null; mode?: Mode; setOverview: (name: string, value: string) => void; setArtwork: (name: string, value: string | number | ProfileImageReference) => void; setArtworkReference: (reference: ProfileImageReference) => void; setDraft: Dispatch<SetStateAction<Draft>>; chooseProfileImage?: () => Promise<void> | void; storeProfileArtworkReference: (value: string | null) => Promise<void> }) {
  const value = (name: string) => draft.overview[name] ?? "";
  const imageReference = useMemo(() => normalizeProfileImageReference(draft.artwork.imageReference, draft.artwork.imageUrl), [draft.artwork.imageReference, draft.artwork.imageUrl]);
  const [manualImageInput, setManualImageInput] = useState(imageReference.kind === "none" ? "" : imageReference.value);

  useEffect(() => {
    setManualImageInput(imageReference.kind === "none" ? "" : imageReference.value);
  }, [imageReference.kind, imageReference.value]);

  const imageSourceLabel = imageReference.kind === "none"
    ? "No image selected"
    : imageReference.kind === "bundled"
      ? "Built-in artwork"
      : imageReference.kind === "cached_remote"
        ? "Cached remote artwork"
        : "Managed local artwork";

  const applyImageReference = (next: string | null) => {
    if (next) void storeProfileArtworkReference(next);
  };
  async function pasteImage() {
    applyImageReference(await readClipboardReference(true));
  }
  const renderInput = (name: string, label: string, hint?: string) => (
    <FormField key={name} label={label} help={hint} size="wide" className="creator-overview-field"><input className="setting-input" value={value(name)} onChange={(event) => setOverview(name, event.target.value)} /></FormField>
  );
  const renderTextarea = (name: string, label: string, rows: number) => (
    <FormField key={name} label={label} size="wide" className="creator-overview-field creator-textarea-field"><textarea className="setting-input" rows={rows} value={value(name)} onChange={(event) => setOverview(name, event.target.value)} /></FormField>
  );

  return <div className="creator-artwork-layout"><div className="creator-artwork-preview-column" tabIndex={0} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void droppedReferenceValue(event, true).then(applyImageReference)} onPaste={(event) => void pastedReferenceValue(event, true).then(applyImageReference)}><article className="creator-portrait-preview creator-profile-image-preview"><ProfileArtwork profileId={draft.profileId} imageReference={imageReference} legacySrc={draft.artwork.imageUrl} alt="Profile artwork preview" fit={draft.artwork.objectFit} focalX={draft.artwork.focalX} focalY={draft.artwork.focalY} scale={draft.artwork.scale} fallback={<div>No image selected</div>} onReferenceUpdated={setArtworkReference} /><strong>{draft.overview.gameName || "Game Name"}</strong><span>{draft.overview.shortDescription || "Profile image preview"}</span></article><article className="creator-selector-card-preview"><ProfileArtwork className="creator-selector-artwork" profileId={draft.profileId} imageReference={imageReference} legacySrc={draft.artwork.imageUrl} alt="Selector card preview" fit={draft.artwork.objectFit} focalX={draft.artwork.focalX} focalY={draft.artwork.focalY} fallback={null} onReferenceUpdated={setArtworkReference} /><div><strong>{draft.overview.gameName || "Game"}</strong><span>{draft.overview.profileTitle || "Profile"}</span></div></article><article className="creator-sidebar-preview"><ProfileArtwork className="creator-sidebar-artwork" profileId={draft.profileId} imageReference={imageReference} legacySrc={draft.artwork.imageUrl} alt="Sidebar thumbnail preview" fit={draft.artwork.objectFit} focalX={draft.artwork.focalX} focalY={draft.artwork.focalY} fallback={null} onReferenceUpdated={setArtworkReference} /><div><strong>{draft.overview.gameName || "Game"}</strong><span>{draft.overview.profileTitle || "Profile"}</span></div></article><FormActions className="creator-artwork-actions" align="left"><button className="creator-button primary" type="button" onClick={() => void chooseProfileImage?.()}>Choose Image</button><button className="creator-button secondary" type="button" onClick={() => void pasteImage()}>Paste Image</button><details className="creator-crop-controls"><summary>Adjust Crop</summary><FormGrid columns="one" compact className="creator-crop-grid"><FormField label="Crop" size="wide"><select className="setting-input" value={draft.artwork.objectFit} onChange={(event) => setArtwork("objectFit", event.target.value as Draft["artwork"]["objectFit"])}><option value="cover">Cover</option><option value="contain">Contain</option></select></FormField><FormField label="Zoom" help={`${Math.round(draft.artwork.scale * 100)}%`} size="wide"><input type="range" min="0.8" max="1.6" step="0.05" value={draft.artwork.scale} onChange={(event) => setArtwork("scale", Number(event.target.value))} /></FormField><FormField label="Focal X" help={`${draft.artwork.focalX}%`} size="wide"><input type="range" min="0" max="100" value={draft.artwork.focalX} onChange={(event) => setArtwork("focalX", Number(event.target.value))} /></FormField><FormField label="Focal Y" help={`${draft.artwork.focalY}%`} size="wide"><input type="range" min="0" max="100" value={draft.artwork.focalY} onChange={(event) => setArtwork("focalY", Number(event.target.value))} /></FormField><button className="creator-button secondary" type="button" onClick={() => setDraft((current) => { const reference = source ? normalizeProfileImageReference(source.imageReference, source.image, "bundled") : normalizeProfileImageReference(current.artwork.imageReference, current.artwork.imageUrl); return { ...current, artwork: { ...current.artwork, imageReference: reference, imageUrl: reference.kind === "none" ? "" : reference.value, focalX: source?.artwork?.focalX ?? 50, focalY: source?.artwork?.focalY ?? 50, scale: source?.artwork?.scale ?? 1 } }; })}>Reset Crop</button></FormGrid></details><button className="creator-button secondary" type="button" onClick={() => setArtworkReference(noneProfileImageReference())}>Remove Image</button></FormActions><div className="creator-image-source-note"><span>Image source</span><strong>{imageSourceLabel}</strong></div><details className="creator-advanced-panel creator-advanced-image-details"><summary>Advanced Image Details</summary><FormRow className="creator-advanced-image-row"><FormField label="Image URL or local path" help={mode === "guided" ? "Paste, drag, or browse for an image." : "Paste a URL, local path, or clipboard image reference."} size="wide"><TransferTextInput value={manualImageInput} onChange={setManualImageInput} imageOnly placeholder="Paste image URL or local path" /></FormField><button className="creator-button secondary" type="button" onClick={() => void storeProfileArtworkReference(manualImageInput)}>Apply Image</button></FormRow></details></div><div className="creator-artwork-details"><WizardSection title="Basic Details"><FormGrid columns="two" className="basic-details">{renderInput("gameName", "Game Name", "The actual game title shown throughout Tsuki.")}{renderInput("profileTitle", "Profile Name", "The support profile name users select.")}{renderInput("version", "Profile Version")}{renderInput("gameVersion", "Game / Engine Version")}{renderInput("author", "Author")}</FormGrid></WizardSection><WizardSection title="Description"><div className="creator-description-grid">{renderTextarea("shortDescription", "Short Description", 4)}{renderTextarea("fullDescription", "Full Description", 7)}</div></WizardSection><details className="creator-field-section creator-optional-details"><summary>Optional Details</summary><FormGrid columns="two" className="optional-details">{renderInput("supportedVersions", "Supported Game Versions (comma-separated)")}{renderInput("license", "License")}{renderInput("documentationUrl", "Documentation URL")}{renderInput("supportUrl", "Support URL")}{renderInput("gameKey", "Game Key", mode === "guided" ? "Permanent maintainer key." : "Permanent internal profile ID.")}</FormGrid></details></div></div>;
}
function PathsPanel({ draft, mode = "guided", tab = "folders", setTab, scan, applyScan, clearScan, update, setDraft, chooseDestinationFolder, chooseExecutable, addCustomPath, editCustomPath, duplicateCustomPath, removeCustomPath, dryRun }: { draft: Draft; mode?: Mode; tab?: "folders" | "launch" | "variables" | "named"; setTab?: Dispatch<SetStateAction<"folders" | "launch" | "variables" | "named">>; scan?: GameFolderScanResult | null; applyScan: (scan: GameFolderScanResult) => void; clearScan: () => void; setDraft: Dispatch<SetStateAction<Draft>>; update: (index: number, patch: Partial<Item>) => void; dryRun: (label: string) => void; chooseDestinationFolder?: (pathIndex?: number) => void; chooseExecutable?: (section: SectionId, index: number, label?: string) => void; addCustomPath: () => void; editCustomPath: (index: number) => void; duplicateCustomPath: (index: number) => void; removeCustomPath: (index: number) => void }) {
  const launchIndex = draft.sections.pathsLaunch.findIndex((it) => it.id === "launch");
  const launch = launchIndex >= 0 ? draft.sections.pathsLaunch[launchIndex] : null;
  function addLaunchConfiguration() {
    setDraft((current) => ({ ...current, sections: { ...current.sections, pathsLaunch: [...current.sections.pathsLaunch, item("launch", "Launch Configuration", "Configure the executable, working directory, and launch checks for this game.", [{ label: "Executable", value: "" }, { label: "Working Directory", value: "" }, { label: "Storefront launch", value: "" }, { label: "Pre-launch checks", value: "" }])] } }));
  }
  const folderRows = draft.sections.pathsLaunch.filter((it) => it.id !== "launch");
  const tabs: Array<{ id: "folders" | "launch" | "variables" | "named"; label: string }> = [{ id: "folders", label: "Folders" }, { id: "launch", label: "Launch" }, { id: "variables", label: "Variables" }, { id: "named", label: "Named Paths" }];
  return <PanelSection title="Paths and launch"><GameFolderScanReview scan={scan} applyScan={applyScan} clearScan={clearScan} selectedExecutable={fieldValue(draft.sections.pathsLaunch.find((entry) => entry.id === "launch") ?? item("launch", "", ""), "Executable") || draft.sections.detectionStores.map((entry) => fieldValue(entry, "Expected executable")).find(Boolean) || ""} /><div className="creator-tabs-v2">{tabs.map((entry) => <button className={tab === entry.id ? "active" : ""} type="button" key={entry.id} onClick={() => setTab?.(entry.id)}>{entry.label}</button>)}</div>{tab === "folders" && <><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={addCustomPath}>Add Named Path</button><button className="creator-button secondary" type="button" onClick={() => chooseDestinationFolder?.()}>Select Game Folder</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Test Paths")}>Test Paths</button></div>{folderRows.length ? <div className="creator-compact-list">{folderRows.map((it) => { const index = draft.sections.pathsLaunch.indexOf(it); return <article className="creator-source-row" key={it.id}><div><strong>{it.title}</strong><span>{it.summary}</span></div><span>{fieldValue(it, "Destination") || fieldValue(it, "Path") || "Folder mapping"}</span><em>{it.enabled === false ? "Disabled" : "Configured"}</em><div className="creator-card-actions"><button className="creator-button secondary" type="button" onClick={() => chooseDestinationFolder?.(index)}>Browse</button><button className="creator-button secondary" type="button" onClick={() => update(index, { enabled: it.enabled === false })}>{it.enabled === false ? "Enable" : "Disable"}</button></div>{mode === "advanced" && <FieldList fields={it.fields} mode={mode} />}</article>; })}</div> : <article className="creator-empty-state"><strong>No folder mappings yet.</strong><p>Choose a game folder or add named destinations when this profile needs them.</p></article>}</>}{tab === "named" && <><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={addCustomPath}>Add Named Path</button></div>{draft.customPaths.length ? <div className="creator-compact-list">{draft.customPaths.map((customPath, index) => <article className="creator-source-row" key={customPath.id}><div><strong>{customPath.name || "Named Path"}</strong><span>{customPath.description || "Profile-scoped destination folder."}</span></div><span>{friendlyPath(resolvePathPreview(customPath, draft.customTest.sampleGameRoot))}</span><em>{customPath.required ? "Required" : "Optional"}</em><div className="creator-card-actions"><button className="creator-button secondary" type="button" onClick={() => editCustomPath(index)}>Edit</button><button className="creator-button secondary" type="button" onClick={() => chooseDestinationFolder?.(index)}>Browse</button><button className="creator-button secondary" type="button" onClick={() => duplicateCustomPath(index)}>Duplicate</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeCustomPath(index)}>Remove</button></div>{mode === "advanced" && <div className="creator-rule-preview"><span>Variable</span><strong>{pathVariable(customPath)}</strong><span>Base</span><strong>{customPath.baseRoot}</strong></div>}</article>)}</div> : <article className="creator-empty-state"><strong>No named paths yet.</strong><p>Add reusable destinations like Mods, Plugins, Assets, or any custom folder this game needs.</p></article>}</>}{tab === "variables" && <div className="creator-card-grid two">{approvedRoots.map((root) => <SummaryCard key={root} title={nice(root)} summary={rootDescriptions[root] ?? "Approved path root."} status={mode === "advanced" ? root : undefined}><div className="creator-rule-preview"><span>Preview</span><strong>{rootPreview(root, draft.customTest.sampleGameRoot)}</strong>{mode === "advanced" && <><span>Raw variable</span><strong>{root}</strong></>}</div></SummaryCard>)}</div>}{tab === "launch" && <>{launch ? <SummaryCard title={launch.title} summary={launch.summary} status="Configured" actions={<><button className="creator-button secondary" type="button" onClick={() => chooseExecutable?.("pathsLaunch", launchIndex, "Executable")}>Choose Executable</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Test Launch Dry Run")}>Dry-Run Launch</button></>}><FieldList fields={launch.fields} mode={mode} /><div className="creator-form-grid compact">{launch.fields.map((field, fieldIndex) => <label key={field.label}>{field.label}<TransferTextInput value={mode === "guided" ? friendlyFieldValue(field, mode) : field.value} readOnly={mode === "guided"} imageOnly={isImageFieldLabel(field.label)} onChange={(value) => { const fields = [...launch.fields]; fields[fieldIndex] = { ...fields[fieldIndex], value }; update(launchIndex, { fields }); }} /></label>)}</div></SummaryCard> : <article className="creator-empty-state"><strong>No launch configuration yet.</strong><p>Add launch settings only if Tsuki should start or test this game.</p><button className="creator-button secondary" type="button" onClick={addLaunchConfiguration}>Add Launch Configuration</button></article>}<div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => dryRun("Test Launch Checks")}>Test Launch Checks</button></div></>}</PanelSection>;
}
function CustomPathEditor({ path, sampleRoot, update, remove }: { path: CustomPath; sampleRoot: string; update: (patch: Partial<CustomPath>) => void; remove: () => void }) {
  const issues = customPathIssues(path);
  return <article className="creator-config-card custom-builder-card path-builder-card"><header><div><strong>{path.name || "Custom Path"}</strong><span>PathCard</span></div><button className="ghost-button compact danger-button" type="button" onClick={remove}>Remove</button></header><BuilderSection title="What is this path?" description="Name the folder in language users will recognize, then Tsuki generates the safe variable." example="Use a stable name because install rules can reference this path."><div className="creator-form-grid compact"><label>Display name<input className="setting-input" value={path.name} onChange={(event) => update({ name: event.target.value })} /></label><label>Description<input className="setting-input" value={path.description} onChange={(event) => update({ description: event.target.value })} /></label></div></BuilderSection><FolderSelector path={path} sampleRoot={sampleRoot} update={update} /><BuilderSection title="Folder behavior" description="Choose what Tsuki is allowed to do when this folder is missing or protected."><ToggleCards options={[{ label: "Required", description: "Profile setup should warn if this path cannot be resolved.", checked: path.required, onChange: (checked) => update({ required: checked }) }, { label: "Create if missing", description: "Tsuki may create the folder during setup or install preview.", checked: path.createIfMissing, onChange: (checked) => update({ createIfMissing: checked }) }, { label: "Writable", description: "Install rules may write tracked receipt files here.", checked: path.writable, onChange: (checked) => update({ writable: checked }) }]} /></BuilderSection><details className="creator-advanced-panel"><summary>Advanced path details</summary><div className="creator-form-grid compact"><label>User prompt<input className="setting-input" value={path.userPrompt ?? ""} onChange={(event) => update({ userPrompt: event.target.value })} /></label><label>Validation markers<input className="setting-input" value={path.validationMarkers ?? ""} onChange={(event) => update({ validationMarkers: event.target.value })} /></label><label>Canonical key<input className="setting-input" value={path.id} readOnly /></label></div></details><ValidationCard issues={issues} empty="Path is scoped to an approved root and ready for install rules." /></article>;
}

function ModTypesPanel({ draft, mode = "guided", setDraft, update, dryRun, addCustomFileType, openEditor, openCustomFileType, duplicateCustomFileType, removeCustomFileType }: { draft: Draft; mode?: Mode; setDraft: Dispatch<SetStateAction<Draft>>; update: (index: number, patch: Partial<Item>) => void; dryRun: (label: string) => void; addCustomFileType: (kind?: CustomFileTypeKind, presetId?: ModTypePresetId) => void; openEditor?: (target: EditorTarget) => void; openCustomFileType: (index: number) => void; duplicateCustomFileType: (index: number) => void; removeCustomFileType: (index: number) => void }) {
  return <PanelSection title="Mod type catalog"><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={() => addCustomFileType("custom_extension", "custom")}>Add Mod Type</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Test Custom File Type")}>Test Match</button></div><div className="creator-card-grid two">{draft.sections.modTypes.map((it, index) => <SummaryCard key={it.id} title={it.title} summary={it.summary} status={it.enabled === false ? "Disabled" : "Built-in"} actions={<><button className="creator-button secondary" type="button" onClick={() => openEditor?.({ section: "modTypes", index })}>Edit</button><label className="creator-inline-toggle"><input type="checkbox" checked={it.enabled !== false} onChange={(event) => update(index, { enabled: event.target.checked })} />Enabled</label></>}><FieldList fields={it.fields} mode={mode} /><ChipRow chips={it.chips} /></SummaryCard>)}</div><div className="creator-card-grid two">{draft.customFileTypes.map((fileType, index) => <SummaryCard key={fileType.id} title={fileType.name || "Custom Mod Type"} summary={mode === "advanced" ? `${fileTypeKindOptions.find((option) => option.value === fileType.kind)?.label ?? "Custom"} matched at ${fileType.confidence}% confidence.` : modTypeSummary(fileType)} status={matchFileType(fileType, draft.customTest.sampleFilename) ? "Matches sample" : "Ready"} actions={<><button className="creator-button primary" type="button" onClick={() => openCustomFileType(index)}>Edit</button><button className="creator-button secondary" type="button" onClick={() => duplicateCustomFileType(index)}>Duplicate</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeCustomFileType(index)}>Remove</button></>}><dl className="creator-field-list"><div><dt>Matcher</dt><dd>{fileTypePatterns(fileType).join(", ") || "Not configured"}</dd></div><div><dt>Destination</dt><dd>{mode === "guided" ? friendlyPath(fileType.destination) : fileType.destination}</dd></div><div><dt>Dependency</dt><dd>{fileType.requiredDependency || "No dependency"}</dd></div><div><dt>Layer</dt><dd>{mode === "advanced" ? `${priorityLabel(fileType.priority)} (${fileType.priority})` : priorityLabel(fileType.priority)}</dd></div></dl></SummaryCard>)}</div>{!draft.customFileTypes.length && <article className="creator-empty-state"><strong>No custom mod types yet.</strong><p>Add a custom extension, filename pattern, folder marker, or paired file set. The profile is not changed until Save Mod Type.</p></article>}<SummaryCard title="Unknown file fallback" summary="Unknown archive content is never silently guessed."><select className="setting-input" value={draft.unknownFileFallback} onChange={(event) => setDraft((current) => ({ ...current, unknownFileFallback: event.target.value }))}><option value="">Not configured</option><option>Ask user to choose a mod type.</option><option>Show install preview and ask user to choose a mod type.</option><option>Install using a declared generic rule.</option><option>Reject with explanation.</option><option>Keep as an unmatched local mod.</option></select></SummaryCard></PanelSection>;
}
function CustomFileTypeEditor({ fileType, paths, sampleRoot, sampleFilename, update, remove }: { fileType: CustomFileType; paths: CustomPath[]; sampleRoot: string; sampleFilename: string; update: (patch: Partial<CustomFileType>) => void; remove: () => void }) {
  const issues = customFileTypeIssues(fileType, paths);
  const patterns = fileTypePatterns(fileType);
  const matched = matchFileType(fileType, sampleFilename);
  const kindLabel = fileTypeKindOptions.find((option) => option.value === fileType.kind)?.label ?? "Custom Type";
  const previewFile = fileType.kind === "filename_pattern" ? "archive/MyMod/mod_audio.bundle" : fileType.kind === "paired_file_set" ? "archive/MyMod/example.custommod" : fileType.kind === "folder_based" ? `archive/MyMod/${fileType.folderMarker || "manifest.json"}` : "archive/MyMod/example.custommod";
  const previewRelativeFile = previewFile.replace(/^archive\//, "");
  return <article className="creator-config-card custom-builder-card filetype-builder-card"><header><div><strong>{fileType.name || "Custom File Type"}</strong><span>{kindLabel}</span></div><button className="ghost-button compact danger-button" type="button" onClick={remove}>Remove</button></header><BuilderSection title="What is this mod type?" description="Give the card a user-facing name and pick the kind of matcher Tsuki should generate." example="Name the mod type and choose how it should be detected."><div className="creator-form-grid compact"><label>Display name<input className="setting-input" value={fileType.name} onChange={(event) => update({ name: event.target.value })} /></label><label>Confidence <span className="creator-range-value">{fileType.confidence}%</span><input type="range" min="0" max="100" value={fileType.confidence} onChange={(event) => update({ confidence: Number(event.target.value) })} /></label></div><PickerCards value={fileType.kind} options={fileTypeKindOptions} onChange={(kind) => update({ kind: kind as CustomFileTypeKind })} /></BuilderSection>{(fileType.kind === "custom_extension" || fileType.kind === "common" || fileType.kind === "paired_file_set") && <ExtensionEditor fileType={fileType} update={update} />}<DetectionBuilder fileType={fileType} update={update} /><DestinationPicker destination={fileType.destination} paths={paths} sampleRoot={sampleRoot} fileName={previewRelativeFile} preserveStructure={fileType.preserveStructure} update={(destination) => update({ destination })} /><DependencyPicker value={fileType.requiredDependency} update={(requiredDependency) => update({ requiredDependency })} /><PriorityPicker value={fileType.priority} update={(priority) => update({ priority })} /><StrategyBuilder fileType={fileType} update={update} /><BuilderSection title="Live Preview" description="Review the generated rule before testing or exporting." example="The preview is declarative only; no files are written from this editor."><div className="creator-rule-preview"><span>Files matching</span><strong>{patterns.join(", ") || "No matcher configured"}</strong><span>Will install to</span><strong>{fileType.destination || "No destination"}</strong><span>Example operation</span><strong>{previewFile} -&gt; {resolveDestination(fileType.destination, paths, previewRelativeFile, fileType.preserveStructure, sampleRoot)}</strong><span>Sample test</span><strong>{sampleFilename || "No sample"}: {matched ? `Matched ${fileType.name} at confidence ${fileType.confidence}` : "Does not match"}</strong>{(fileType.kind === "custom_extension" || fileType.kind === "common") && <span>Canonical extension: {normalizeExtensionInput(fileType.extension, fileType.caseSensitive) || "invalid"}</span>}</div></BuilderSection><details className="creator-advanced-panel"><summary>Advanced and expert values</summary><div className="creator-form-grid compact"><label>Raw priority<input className="setting-input" type="number" value={fileType.priority} onChange={(event) => update({ priority: Number(event.target.value) })} /></label><label>Enable/disable strategy<input className="setting-input" value={fileType.enableDisableStrategy} onChange={(event) => update({ enableDisableStrategy: event.target.value })} /></label><label>Load-order strategy<input className="setting-input" value={fileType.loadOrderStrategy} onChange={(event) => update({ loadOrderStrategy: event.target.value })} /></label><label>Conflict policy<input className="setting-input" value={fileType.conflictPolicy} onChange={(event) => update({ conflictPolicy: event.target.value })} /></label><label className="creator-wide-field">Detection conditions<textarea className="setting-input" value={fileType.conditions} onChange={(event) => update({ conditions: event.target.value })} /></label></div></details><ValidationCard issues={issues} empty="This custom file type has a matcher, destination, and receipt-safe behavior." /></article>;
}

function SectionItems({ section, items, update, dryRun, add }: { section: SectionId; items: Item[]; update: (index: number, patch: Partial<Item>) => void; dryRun: (label: string) => void; add: () => void }) {
  const meta = sectionInfo.find((entry) => entry.id === section) ?? sectionInfo[0];
  return <><CreatorGuide title={`${meta.label} builder`} description={meta.subtitle} example={sectionExamples[section]}>{section !== "pathsLaunch" && section !== "modTypes" && section !== "testProfile" && <button className="ghost-button compact" type="button" onClick={add}>Add {meta.label}</button>}</CreatorGuide>{items.length ? <div className="creator-card-grid two">{items.map((it, index) => section === "sources" ? <SourceCard key={it.id} item={it} index={index} update={update} dryRun={dryRun} /> : <ModTypeCard key={it.id} section={section} item={it} index={index} update={update} dryRun={dryRun} />)}</div> : <article className="creator-empty-state"><strong>Nothing configured yet.</strong><p>This section is ready for a template, builder card, or custom rule.</p><button className="ghost-button compact" type="button" onClick={add}>Add {nice(section)}</button></article>}{section === "modTypes" && <select className="setting-input creator-template-select" defaultValue="" onChange={(event) => event.target.value && add()}><option value="">Templates: {templates.join(", ")}</option></select>}</>;
}
function TestPanel({ draft, setDraft, items, update, dryRun }: { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; items: Item[]; update: (index: number, patch: Partial<Item>) => void; dryRun: (label: string) => void }) {
  const match = bestCustomMatch(draft);
  return <><SectionItems section="testProfile" items={items} update={update} dryRun={dryRun} add={() => undefined} /><div className="creator-form-grid custom-test-inputs"><label>Sample Filename or Archive Path<input className="setting-input" value={draft.customTest.sampleFilename} onChange={(event) => setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleFilename: event.target.value } }))} /></label><label>Sample Archive<input className="setting-input" value={draft.customTest.sampleArchive} onChange={(event) => setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleArchive: event.target.value } }))} /></label><label>Test Game Root<input className="setting-input" value={draft.customTest.sampleGameRoot} onChange={(event) => setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleGameRoot: event.target.value } }))} /></label></div><div className="creator-test-grid">{["Test Detection", "Test Paths", "Test Custom File Type", "Dry-Run Install", "Dry-Run Enable", "Dry-Run Disable", "Dry-Run Update", "Dry-Run Uninstall", "Test Load Order", "Test Conflict", "Test Rollback"].map((label) => <button className="ghost-button compact" type="button" key={label} onClick={() => dryRun(label)}>{label}</button>)}</div><div className="creator-rule-preview"><span>Custom type result</span>{match ? <><strong>Matched: {match.name}</strong><strong>Confidence: {match.confidence}</strong><strong>Destination: {match.destination}</strong><strong>Resolved destination: {resolveDestination(match.destination, draft.customPaths, draft.customTest.sampleFilename, match.preserveStructure, draft.customTest.sampleGameRoot)}</strong><strong>Enable/disable: {match.enableDisableStrategy}</strong></> : <strong>Unknown file fallback: {draft.unknownFileFallback}. Unknown files are not silently guessed.</strong>}<span>Dry-run output</span>{draft.testOutput.map((line) => <strong key={line}>{line}</strong>)}</div></>;
}

function Advanced({ draft, setDraft }: { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>> }) {
  const raw = JSON.stringify({ customPaths: draft.customPaths, customFileTypes: draft.customFileTypes, unknownFileFallback: draft.unknownFileFallback, sections: draft.sections.advancedRules }, null, 2);
  return <><p className="creator-safety-note">Advanced rules can use Tsuki's approved actions. They cannot run arbitrary programs, shell commands, registry edits, or unrestricted system writes.</p><div className="creator-tabs"><button className="active" type="button">Raw Profile JSON</button><button type="button">Action Registry</button><button type="button">Condition Registry</button></div><textarea className="setting-input creator-code-box" value={draft.advancedJson === "{}" ? raw : draft.advancedJson} onChange={(event) => setDraft((current) => ({ ...current, advancedJson: event.target.value }))} /><div className="creator-rule-preview"><span>Approved actions</span><strong>copy, backup_then_copy, move_tracked_files, restore_tracked_files, patch_ini, patch_json, verify_hash, write_manifest_entry</strong><span>Approved roots</span><strong>{approvedRoots.map(nice).join(", ")}</strong></div></>;
}

function Review({ sections, issues, blocked, setActive, exportDraft, draft }: { sections: typeof sectionInfo; issues: Array<{ section: SectionId; text: string }>; blocked: boolean; setActive: (section: SectionId) => void; exportDraft: () => void; draft: Draft }) {
  return <><div className="creator-review-grid">{sections.slice(0, -1).map((section) => <button className="creator-review-row" type="button" key={section.id} onClick={() => setActive(section.id)}><strong>{section.label}</strong><span>{issues.some((issue) => issue.section === section.id) ? "review" : "ready"}</span></button>)}</div><div className="creator-rule-preview"><span>Export readiness</span><strong>{blocked ? "Blocked by required validation errors." : "Ready to export as a draft package."}</strong><strong>{draft.customFileTypes.length} custom file type(s), {draft.customPaths.length} custom path(s)</strong><strong>Custom data is stored inside the draft JSON and exported with the .tsukiprofile.</strong><strong>Maintainer publishing remains intentionally disabled until signed release flow exists.</strong></div><button className="ghost-button compact" type="button" disabled={blocked} onClick={exportDraft}>Export .tsukiprofile</button></>;
}

function singlePath(value: string | string[] | null): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function dialogError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function fileNameFromPath(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function defaultProfileExportName(draft: Draft) {
  return `${safeKey(draft.overview.profileTitle || draft.overview.gameName || draft.profileId)}.tsukiprofile`;
}

function relativeToRoot(selectedPath: string, gameRoot: string) {
  const normalized = selectedPath.replace(/\\/g, "/").replace(/\/+$/g, "");
  const root = gameRoot.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (root && normalized.toLowerCase().startsWith(root.toLowerCase())) {
    return { baseRoot: "game_root", relativePath: normalized.slice(root.length).replace(/^\/+/, "") };
  }
  return { baseRoot: "user_selected_folder", relativePath: "", selectedPath: normalized };
}

function fieldValue(it: Item, label: string) {
  return it.fields.find((field) => field.label === label)?.value ?? "";
}

function replaceField(it: Item, label: string, value: string): Item {
  const fields = [...it.fields];
  const index = fields.findIndex((field) => field.label === label);
  if (index >= 0) fields[index] = { ...fields[index], value };
  else fields.push({ label, value });
  return { ...it, fields };
}


function listField(it: Item, label: string) {
  return fieldValue(it, label).split("|").map((value) => value.trim()).filter(Boolean);
}

function replaceListField(it: Item, label: string, values: string[]) {
  return replaceField(it, label, values.filter(Boolean).join("|"));
}

function parseNexusDependencyUrl(value: string): ParsedDependencySource | null {
  const clean = value.trim();
  const match = clean.match(/^https?:\/\/(?:www\.)?nexusmods\.com\/([^/?#]+)\/mods\/(\d+)/i);
  if (!match) return null;
  return { sourceType: "nexus", pageUrl: clean, gameDomain: match[1], modId: match[2] };
}

function parseModWorkshopDependencyUrl(value: string): ParsedDependencySource | null {
  const clean = value.trim();
  if (!/^https?:\/\/(?:www\.)?modworkshop\.net\//i.test(clean)) return null;
  const game = clean.match(/\/g\/([^/?#]+)/i)?.[1] ?? "";
  const modId = clean.match(/\/(?:mod|mods)\/(\d+)/i)?.[1] ?? clean.match(/[?&](?:mod|mod_id|id)=(\d+)/i)?.[1] ?? "";
  const numericGame = clean.match(/[?&](?:game|game_id)=(\d+)/i)?.[1] ?? "";
  return { sourceType: "modworkshop", pageUrl: clean, gameSlug: game, gameId: numericGame, modId };
}

function parseGitHubDependencyUrl(value: string): ParsedDependencySource | null {
  const clean = value.trim();
  const match = clean.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)(?:\/releases(?:\/tag\/([^/?#]+))?)?/i);
  if (!match) return null;
  const repositoryName = match[2].replace(/\.git$/i, "");
  return { sourceType: "github", pageUrl: clean, repositoryOwner: match[1], repositoryName, releaseChannel: match[3] ? "Specific release" : "Latest stable" };
}

function parseDependencySourceUrl(value: string): ParsedDependencySource | null {
  return parseNexusDependencyUrl(value) ?? parseModWorkshopDependencyUrl(value) ?? parseGitHubDependencyUrl(value);
}

function dependencySourceFromFields(entry: Item): ParsedDependencySource {
  const sourceType = (fieldValue(entry, "Download Source Type") || "manual") as DependencyDownloadSourceType;
  return {
    sourceType,
    pageUrl: fieldValue(entry, "Dependency Page URL") || fieldValue(entry, "Direct Download URL"),
    gameDomain: fieldValue(entry, "Nexus Game Domain"),
    gameSlug: fieldValue(entry, "ModWorkshop Game Slug"),
    gameId: fieldValue(entry, "ModWorkshop Game ID"),
    modId: fieldValue(entry, "Nexus Mod ID") || fieldValue(entry, "ModWorkshop Mod ID"),
    repositoryOwner: fieldValue(entry, "GitHub Owner"),
    repositoryName: fieldValue(entry, "GitHub Repository"),
    releaseChannel: fieldValue(entry, "GitHub Release Channel"),
  };
}

function dependencySourceJson(entry: Item) {
  const source = dependencySourceFromFields(entry);
  return JSON.stringify({
    sourceType: source.sourceType,
    pageUrl: source.pageUrl,
    gameDomain: source.gameDomain,
    gameId: source.gameId || source.gameSlug,
    modId: source.modId,
    repositoryOwner: source.repositoryOwner,
    repositoryName: source.repositoryName,
    releaseChannel: source.releaseChannel,
    fileSelection: {
      mode: fieldValue(entry, "File Selection Mode") || "Latest compatible main file",
      includePatterns: listField(entry, "Include Asset Patterns"),
      excludePatterns: listField(entry, "Exclude Asset Patterns"),
    },
  }, null, 2);
}

function normalizeDependencyItem(entry: Item): Item {
  let next = entry;
  const type = fieldValue(next, "Dependency Type") || next.title || "Custom Dependency";
  const preset = dependencyPresetDetails[type];
  if (!fieldValue(next, "Dependency ID")) next = replaceField(next, "Dependency ID", safeKey(type) || "custom-dependency");
  if (!fieldValue(next, "Dependency Kind")) next = replaceField(next, "Dependency Kind", preset?.kind ?? "Custom");
  if (!fieldValue(next, "Download Source Type")) next = replaceField(next, "Download Source Type", preset?.sourceType ?? "manual");
  if (!fieldValue(next, "File Selection Mode")) next = replaceField(next, "File Selection Mode", "Latest compatible main file");
  if (!fieldValue(next, "Exclude Asset Patterns")) next = replaceField(next, "Exclude Asset Patterns", "source code|src|source-code");
  if (!fieldValue(next, "Create Dependency Receipt")) next = replaceField(next, "Create Dependency Receipt", "Yes");
  next = replaceField(next, "Dependency Source JSON", dependencySourceJson(next));
  return next;
}

function applyDependencyPreset(entry: Item, type: string): Item {
  const preset = dependencyPresetDetails[type] ?? dependencyPresetDetails["Custom Dependency"];
  let next: Item = { ...entry, title: type, summary: preset.description, chips: [preset.kind, preset.setupGroup] };
  next = replaceField(next, "Dependency Type", type);
  next = replaceField(next, "Dependency Kind", preset.kind);
  next = replaceField(next, "Dependency ID", safeKey(type) || "custom-dependency");
  next = replaceField(next, "Required", preset.setupGroup === "Core dependency" ? "Required for profile" : preset.setupGroup === "Mod-type dependency" ? "Required by Mod Type" : "Optional / Recommended");
  next = replaceField(next, "Setup Group", preset.setupGroup);
  next = replaceField(next, "Detection Method", "Known dependency preset");
  next = replaceField(next, "Marker File", preset.markers[0] ?? "");
  next = replaceField(next, "Marker Folder", preset.folders[0] ?? "");
  next = replaceField(next, "Marker Filenames", preset.markers.join("|"));
  next = replaceField(next, "Marker Folders", preset.folders.join("|"));
  next = replaceField(next, "Download Source Type", preset.sourceType);
  next = replaceField(next, "Install Method", preset.installMethod);
  next = replaceField(next, "Destination", preset.destination);
  next = replaceField(next, "Requires Dependencies", (preset.requires ?? []).join("|"));
  return normalizeDependencyItem(next);
}

function applyDependencySource(entry: Item, parsed: ParsedDependencySource): Item {
  let next = replaceField(entry, "Download Source Type", parsed.sourceType);
  next = replaceField(next, "Dependency Page URL", parsed.pageUrl);
  if (parsed.sourceType === "nexus") {
    next = replaceField(next, "Nexus Game Domain", parsed.gameDomain ?? "");
    next = replaceField(next, "Nexus Mod ID", parsed.modId ?? "");
  }
  if (parsed.sourceType === "modworkshop") {
    next = replaceField(next, "ModWorkshop Game ID", parsed.gameId ?? "");
    next = replaceField(next, "ModWorkshop Game Slug", parsed.gameSlug ?? "");
    next = replaceField(next, "ModWorkshop Mod ID", parsed.modId ?? "");
  }
  if (parsed.sourceType === "github") {
    next = replaceField(next, "GitHub Owner", parsed.repositoryOwner ?? "");
    next = replaceField(next, "GitHub Repository", parsed.repositoryName ?? "");
    next = replaceField(next, "GitHub Release Channel", parsed.releaseChannel ?? "Latest stable");
  }
  return normalizeDependencyItem(next);
}

function dependencyDownloadSummary(entry: Item) {
  const type = fieldValue(entry, "Download Source Type") || "manual";
  if (type === "nexus") return fieldValue(entry, "Nexus Mod ID") ? `Nexus Mods #${fieldValue(entry, "Nexus Mod ID")}` : "Nexus Mods";
  if (type === "modworkshop") return fieldValue(entry, "ModWorkshop Mod ID") ? `ModWorkshop #${fieldValue(entry, "ModWorkshop Mod ID")}` : "ModWorkshop";
  if (type === "github") return fieldValue(entry, "GitHub Owner") && fieldValue(entry, "GitHub Repository") ? `GitHub ${fieldValue(entry, "GitHub Owner")}/${fieldValue(entry, "GitHub Repository")}` : "GitHub Releases";
  if (type === "direct") return "Direct approved download";
  if (type === "included") return "Included with profile";
  if (type === "custom") return "Custom source";
  return "User installs manually";
}

function dependencyIssues(entry: Item, dependencies: Item[]) {
  const issues: Array<{ level: IssueLevel; text: string }> = [];
  const sourceType = fieldValue(entry, "Download Source Type") || "manual";
  const labels = entry.fields.map((field) => field.label.toLowerCase());
  if (labels.some((label) => /api key|token|oauth|cookie|password|secret/.test(label))) issues.push({ level: "error", text: `${entry.title}: dependency profile fields must not store credentials.` });
  if (!entry.title.trim()) issues.push({ level: "error", text: "Dependency needs a name." });
  if (!fieldValue(entry, "Dependency Kind")) issues.push({ level: "warning", text: `${entry.title}: choose whether this is a framework, loader, library, tool, or supporting mod.` });
  if (!fieldValue(entry, "Marker File") && !fieldValue(entry, "Marker Folder") && !listField(entry, "Marker Filenames").length && !listField(entry, "Marker Folders").length) issues.push({ level: "warning", text: `${entry.title}: add at least one detection marker.` });
  if (sourceType === "nexus" && (!fieldValue(entry, "Nexus Game Domain") || !fieldValue(entry, "Nexus Mod ID"))) issues.push({ level: "warning", text: `${entry.title}: Nexus source needs a game domain and mod ID.` });
  if (sourceType === "modworkshop" && !fieldValue(entry, "ModWorkshop Mod ID")) issues.push({ level: "warning", text: `${entry.title}: ModWorkshop source should include a mod ID when available.` });
  if (sourceType === "github" && (!fieldValue(entry, "GitHub Owner") || !fieldValue(entry, "GitHub Repository"))) issues.push({ level: "warning", text: `${entry.title}: GitHub source needs owner and repository.` });
  if (sourceType === "github" && !listField(entry, "Exclude Asset Patterns").some((pattern) => /source/i.test(pattern))) issues.push({ level: "warning", text: `${entry.title}: GitHub asset rules should ignore source-code archives by default.` });
  for (const parent of listField(entry, "Requires Dependencies")) {
    if (!dependencies.some((dependency) => dependency.title === parent)) issues.push({ level: "warning", text: `${entry.title}: parent dependency ${parent} is not configured.` });
  }
  return issues;
}

function dependencyGraphPlan(dependencies: Item[]) {
  const byName = new Map(dependencies.map((dependency) => [dependency.title, dependency]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const cycles: string[] = [];
  const missing: string[] = [];
  function visit(name: string, path: string[]) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      cycles.push([...path, name].join(" -> "));
      return;
    }
    const dependency = byName.get(name);
    if (!dependency) {
      missing.push(name);
      return;
    }
    visiting.add(name);
    for (const parent of listField(dependency, "Requires Dependencies")) visit(parent, [...path, name]);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }
  for (const dependency of dependencies) visit(dependency.title, []);
  return { order, cycles: Array.from(new Set(cycles)), missing: Array.from(new Set(missing)) };
}

function friendlyPath(value: string) {
  const formatted = formatFriendlyPath(value);
  return formatted
    .replace(/\$\{GAME_ROOT\}/g, "Game folder")
    .replace(/\$\{GAME_EXE_DIR\}/g, "Executable folder")
    .replace(/\$\{DOCUMENTS\}/g, "Documents")
    .replace(/\$\{APP_DATA\}/g, "Tsuki app data")
    .replace(/\$\{LOCAL_APP_DATA\}/g, "Local app data")
    .replace(/\$\{PATH:([A-Z0-9_]+)\}/g, (_match: string, key: string) => nice(key));
}

function friendlyFieldValue(field: Field, mode: Mode) {
  if (mode === "advanced") return field.value;
  if (/url/i.test(field.label)) return field.value ? fileNameFromPath(field.value) || "Configured link" : "Not configured";
  if (/id|key|domain|slug|priority/i.test(field.label)) return field.value ? "Configured" : "Not configured";
  if (/path|folder|directory|destination|location|executable|marker/i.test(field.label)) return friendlyPath(field.value || "Not configured");
  if (/color/i.test(field.label)) return field.value ? "Configured color" : "No color selected";
  return field.value || "Not configured";
}

function priorityLabel(value: number) {
  return priorityOptions.find((option) => option.score === value)?.label ?? priorityOptions.reduce((best, option) => Math.abs(option.score - value) < Math.abs(best.score - value) ? option : best, priorityOptions[0]).label;
}

function sectionRequiresTest(section: SectionId) {
  return ["detectionStores", "pathsLaunch", "sources", "modTypes", "installBehavior", "enableDisable", "loadOrder", "dependencies", "conflicts", "updatesUninstall", "advancedRules", "testProfile"].includes(section);
}

function sectionHasConfiguration(draft: Draft, section: SectionId) {
  if (section === "gameArtwork") return Boolean(draft.overview.gameName.trim() || draft.overview.profileTitle.trim() || profileImageHasValue(draft.artwork.imageReference, draft.artwork.imageUrl));
  if (section === "pathsLaunch") return draft.sections.pathsLaunch.length > 0 || draft.customPaths.length > 0;
  if (section === "modTypes") return draft.sections.modTypes.length > 0 || draft.customFileTypes.length > 0;
  if (section === "testProfile") return Boolean(draft.customTest.sampleArchive || draft.customTest.sampleFilename || draft.customTest.sampleGameRoot || draft.testOutput.length > 1);
  if (section === "reviewExport") return true;
  return draft.sections[section].some((it) => it.enabled !== false || it.fields.length > 0 || it.chips?.length);
}

function sectionStatus(section: SectionId, issues: Array<{ level: IssueLevel; section: SectionId; text: string }>, draft: Draft, testedSections: Partial<Record<SectionId, boolean>>): SectionStatus {
  if (issues.some((issue) => issue.section === section && issue.level === "error")) return "error";
  if (issues.some((issue) => issue.section === section && issue.level === "warning")) return "warning";
  const configured = sectionHasConfiguration(draft, section);
  if (!configured) return "notConfigured";
  if (sectionRequiresTest(section)) return testedSections[section] ? "tested" : "untested";
  return "configured";
}

function statusLabel(status: SectionStatus) {
  const labels: Record<SectionStatus, string> = {
    notConfigured: "Not configured",
    configured: "Configured",
    untested: "Untested",
    tested: "Tested",
    warning: "Warning",
    error: "Error",
  };
  return labels[status];
}

function summarizeIssues(issues: Array<{ level: IssueLevel }>) {
  const errors = issues.filter((issue) => issue.level === "error").length;
  const untested = issues.filter((issue) => issue.level === "untested").length;
  const warnings = issues.filter((issue) => issue.level === "warning").length;
  if (errors) return `${errors} fix${errors === 1 ? "" : "es"}`;
  if (untested) return `${untested} untested`;
  if (warnings) return `${warnings} warning${warnings === 1 ? "" : "s"}`;
  return "Ready";
}

function StepNavigation({ sections, active, setActive, readyCount, issueCount, mode }: { sections: Array<{ id: SectionId; label: string; subtitle: string; status: SectionStatus }>; active: SectionId; setActive: (section: SectionId) => void; readyCount: number; issueCount: number; mode: Mode }) {
  return <aside className="creator-step-nav" aria-label="Profile creator steps"><header className="creator-step-nav-header"><span>{mode === "guided" ? "Setup" : "All sections"}</span><strong>{readyCount}/{sections.length}</strong></header><div className="creator-step-list">{sections.map((section, index) => <button className={active === section.id ? "active" : ""} type="button" key={section.id} onClick={() => setActive(section.id)} title={`${section.label}: ${statusLabel(section.status)}`}><span className="creator-step-number">{index + 1}</span><span className="creator-step-label"><strong>{section.label}</strong>{mode === "advanced" && <small>{section.subtitle}</small>}</span><i className={`creator-status-dot ${section.status}`} aria-label={statusLabel(section.status)} /></button>)}</div><div className="creator-nav-progress"><span>{issueCount ? `${issueCount} item${issueCount === 1 ? "" : "s"} to review` : "No blocking issues"}</span><strong>{mode === "guided" ? "Guided" : "Advanced"}</strong></div></aside>;
}

function GuidedPageNavigation({ sections, active, setActive }: { sections: Array<{ id: SectionId; label: string }>; active: SectionId; setActive: (section: SectionId) => void }) {
  const index = Math.max(0, sections.findIndex((section) => section.id === active));
  const previous = sections[index - 1];
  const next = sections[index + 1];
  return <footer className="creator-guided-footer"><button className="creator-button secondary" type="button" disabled={!previous} onClick={() => previous && setActive(previous.id)}>Previous</button><span>Step {index + 1} of {sections.length}</span><button className="creator-button primary" type="button" disabled={!next} onClick={() => next && setActive(next.id)}>{next ? `Next: ${next.label}` : "Setup reviewed"}</button></footer>;
}

function PageIntro({ meta, mode, helpOpen, setHelpOpen }: { meta: { id: SectionId; label: string; subtitle: string }; mode: Mode; helpOpen: boolean; setHelpOpen: (open: boolean) => void }) {
  return <header className="creator-page-intro"><div><p className="eyebrow">{mode === "guided" ? "Guided setup" : "Advanced setup"}</p><h1>{meta.label}</h1><p>{meta.subtitle}</p></div><button className="creator-button secondary" type="button" onClick={() => setHelpOpen(!helpOpen)}>{helpOpen ? "Hide Guide" : "Guide"}</button>{helpOpen && <div className="creator-help-drawer"><strong>Terms used here</strong><div>{glossary.map((entry) => <span key={entry}>{entry}</span>)}</div></div>}</header>;
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="creator-section-block"><header><h2>{title}</h2></header>{children}</section>;
}

function SummaryCard({ title, summary, status, children, actions }: { title: string; summary: string; status?: string; children?: ReactNode; actions?: ReactNode }) {
  return <article className="creator-summary-card"><header><div><strong>{title}</strong>{status && <span>{status}</span>}</div>{actions && <div className="creator-card-actions">{actions}</div>}</header><p>{summary}</p>{children}</article>;
}

function FieldList({ fields, mode }: { fields: Field[]; mode: Mode }) {
  if (!fields.length) return null;
  return <dl className="creator-field-list">{fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{friendlyFieldValue(field, mode)}</dd></div>)}</dl>;
}

function ChipRow({ chips }: { chips?: string[] }) {
  if (!chips?.length) return null;
  return <div className="creator-chip-row">{chips.map((chip) => <span key={chip}>{chip}</span>)}</div>;
}

function ValidationDrawer({ issues, close, setActive, dryRun }: { issues: Array<{ level: IssueLevel; section: SectionId; text: string }>; close: () => void; setActive: (section: SectionId) => void; dryRun: (label: string, section: SectionId) => void }) {
  return <div className="creator-drawer-backdrop" role="presentation"><aside className="creator-validation-drawer" role="dialog" aria-modal="true" aria-label="Validation"><header><div><h2>Validation</h2><p>{summarizeIssues(issues)}</p></div><button className="creator-button ghost" type="button" onClick={close}>Close</button></header>{issues.length ? <div className="creator-validation-list">{issues.map((issue) => <article className={issue.level} key={`${issue.section}-${issue.text}`}><strong>{statusLabel(issue.level === "untested" ? "untested" : issue.level === "suggestion" ? "configured" : issue.level)}</strong><span>{issue.text}</span><div><button type="button" onClick={() => { setActive(issue.section); close(); }}>Open Section</button>{issue.level === "untested" && <button type="button" onClick={() => dryRun(`Test ${nice(issue.section)}`, issue.section)}>Run Dry-Run</button>}</div></article>)}</div> : <p>No validation issues found.</p>}</aside></div>;
}

function GameFolderScanReview({ scan, applyScan, clearScan, selectedExecutable = "" }: { scan?: GameFolderScanResult | null; applyScan: (scan: GameFolderScanResult) => void; clearScan: () => void; selectedExecutable?: string }) {
  if (!scan) return null;
  const executable = scan.suggestedExecutable ?? scan.executables?.[0] ?? null;
  const manualExecutable = selectedExecutable && !executable ? selectedExecutable : "";
  const executableLabel = executable?.relativePath || executable?.fileName || (manualExecutable ? `${fileNameFromPath(manualExecutable)} - Selected manually` : "No executable found");
  const folders = (scan.folders ?? []).filter((folder) => folder.relativePath).slice(0, 8);
  const hints = [...(scan.frameworks ?? []), ...(scan.architectureHints ?? []), ...(scan.steamAppIds ?? []).map((id) => `Steam ${id}`)];
  return <article className="creator-config-card detected-game-setup"><header><div><strong>Folder Scan Suggestions</strong><span>{scan.suggestedGameName || fileNameFromPath(scan.gameFolder)}</span></div><span>{scan.visitedEntries ?? 0} scanned</span></header><div className="detected-game-grid"><div><span>Game folder</span><code>{friendlyPath(scan.gameFolder)}</code></div><div><span>Primary executable</span><code>{executableLabel}</code></div><div><span>Suggested folders</span><code>{folders.length ? folders.map((folder) => folder.relativePath).join(" | ") : "No common folders found"}</code></div><div><span>Hints</span><code>{hints.length ? hints.join(" | ") : "No framework or store hints found"}</code></div></div>{scan.executables?.length > 1 && <details className="creator-advanced-panel"><summary>Other executables</summary><div className="creator-compact-list">{scan.executables.slice(0, 8).map((entry) => <span key={entry.path}>{entry.relativePath || entry.fileName}</span>)}</div></details>}<div className="creator-card-actions"><button className="creator-button primary" type="button" onClick={() => applyScan(scan)}>Apply Suggestions</button><button className="creator-button ghost" type="button" onClick={clearScan}>Dismiss</button></div></article>;
}
function DetectionStoresPanel({ draft, mode, scan, applyScan, clearScan, addDetectionMethod, openEditor, duplicateItem, removeItem, toggleItem, chooseExecutable, chooseMarker, chooseGameFolder, detectAutomatically, dryRun }: { draft: Draft; mode: Mode; scan?: GameFolderScanResult | null; applyScan: (scan: GameFolderScanResult) => void; clearScan: () => void; update: (index: number, patch: Partial<Item>) => void; addDetectionMethod: () => void; openEditor: (index: number) => void; duplicateItem: (index: number) => void; removeItem: (index: number) => void; toggleItem: (index: number) => void; chooseExecutable: (section: SectionId, index: number, label?: string) => void; chooseMarker: (section: SectionId, index: number, folder: boolean) => void; chooseGameFolder: () => void; detectAutomatically: () => void; dryRun: (label: string) => void }) {
  const canAutoDetectPayday = draft.overview.gameKey === "payday3" || draft.profileId.includes("payday3");
  return <PanelSection title="Detection methods"><GameFolderScanReview scan={scan} applyScan={applyScan} clearScan={clearScan} selectedExecutable={fieldValue(draft.sections.pathsLaunch.find((entry) => entry.id === "launch") ?? item("launch", "", ""), "Executable") || draft.sections.detectionStores.map((entry) => fieldValue(entry, "Expected executable")).find(Boolean) || ""} /><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={addDetectionMethod}>Add Detection Method</button><button className="creator-button secondary" type="button" onClick={chooseGameFolder}>Select Game Folder</button>{canAutoDetectPayday && <button className="creator-button secondary" type="button" onClick={detectAutomatically}>Auto Detect PAYDAY 3</button>}</div>{draft.sections.detectionStores.length ? <div className="creator-compact-list">{draft.sections.detectionStores.map((it, index) => <article className="creator-source-row" key={it.id}><div><strong>{it.title}</strong><span>{fieldValue(it, "Detection Type") || it.summary}</span></div><span>{[fieldValue(it, "Expected executable"), fieldValue(it, "Required markers")].filter(Boolean).join(" + ") || "Executable + marker folders"}</span><em>{it.enabled === false ? "Disabled" : "Configured - Untested"}</em><div className="creator-card-actions"><button className="creator-button secondary" type="button" onClick={() => openEditor(index)}>Edit</button><button className="creator-button secondary" type="button" onClick={() => dryRun(`Test ${it.title}`)}>Test</button><button className="creator-button secondary" type="button" onClick={() => duplicateItem(index)}>Duplicate</button><button className="creator-button secondary" type="button" onClick={() => toggleItem(index)}>{it.enabled === false ? "Enable" : "Disable"}</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeItem(index)}>Remove</button></div>{mode === "advanced" && <FieldList fields={it.fields} mode={mode} />}{it.enabled !== false && mode === "advanced" && <div className="creator-card-actions"><button className="creator-button secondary" type="button" onClick={() => chooseExecutable("detectionStores", index)}>Choose Executable</button><button className="creator-button secondary" type="button" onClick={() => chooseMarker("detectionStores", index, true)}>Marker Folder</button></div>}</article>)}</div> : <article className="creator-empty-state"><strong>No detection methods yet.</strong><p>Add one method when you are ready to tell Tsuki how to find this game. You can inspect every other section before doing this.</p></article>}</PanelSection>;
}

function SourcesPanel({ items, openAddSource, openEditSource, testSource, toggleSource, duplicateSource, removeSource }: { items: Item[]; openAddSource: (type?: ProfileSourceType) => void; openEditSource: (index: number) => void; testSource: (index: number) => void; toggleSource: (index: number) => void; duplicateSource: (index: number) => void; removeSource: (index: number) => void }) {
  return <PanelSection title="Sources"><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={() => openAddSource("nexus")}>Add Source</button></div><p className="creator-section-note">Sources determine where users can browse, search, download, and update mods for this game. Nothing is inserted until Save Source.</p>{items.length ? <div className="creator-compact-list">{items.map((entry, index) => { const normalized = normalizeSourceItem(entry); const capabilities = listField(normalized, "Capabilities"); const status = sourceStatus(normalized); const lastTested = sourceValue(normalized, "Last Tested"); return <article className={`creator-source-row ${status.toLowerCase().replace(/\s+/g, "-")}`} key={sourceInstanceId(normalized)}><div><strong>{normalized.title}</strong><span>{sourceMappingSummary(normalized)}</span></div><span>{capabilities.length ? capabilities.slice(0, 4).join(" - ") : "No capabilities selected"}</span><em>{status}{lastTested ? ` - ${new Date(lastTested).toLocaleString()}` : ""}</em><div className="creator-card-actions"><button className="creator-button secondary" type="button" onClick={() => openEditSource(index)}>Configure</button><button className="creator-button secondary" type="button" disabled={normalized.enabled === false} onClick={() => testSource(index)}>Test</button><button className="creator-button secondary" type="button" onClick={() => duplicateSource(index)}>Duplicate</button><button className="creator-button secondary" type="button" onClick={() => toggleSource(index)}>{normalized.enabled === false ? "Enable" : "Disable"}</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeSource(index)}>Remove</button></div></article>; })}</div> : <article className="creator-empty-state"><strong>No sources configured.</strong><p>Add Nexus, ModWorkshop, local files, GitHub releases, a direct catalog, or a protected browser source when this game is ready for browsing and updates.</p></article>}</PanelSection>;
}

function GenericSummaryPanel({ section, items, mode, update, add, dryRun, setEditorTarget }: { section: SectionId; items: Item[]; mode: Mode; update: (index: number, patch: Partial<Item>) => void; add: () => void; dryRun: (label: string) => void; setEditorTarget: Dispatch<SetStateAction<EditorTarget>> }) {
  const meta = sectionInfo.find((entry) => entry.id === section) ?? sectionInfo[0];
  return <PanelSection title={meta.label}><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={add}>Add {meta.label}</button><button className="creator-button secondary" type="button" onClick={() => dryRun(`Test ${meta.label}`)}>Dry-Run</button></div>{items.length ? <div className="creator-card-grid two">{items.map((it, index) => <SummaryCard key={it.id} title={it.title} summary={it.summary} status={it.enabled === false ? "Disabled" : "Configured"} actions={<><button className="creator-button secondary" type="button" onClick={() => setEditorTarget({ section, index })}>Edit</button><label className="creator-inline-toggle"><input type="checkbox" checked={it.enabled !== false} onChange={(event) => update(index, { enabled: event.target.checked })} />Enabled</label></>}><FieldList fields={it.fields} mode={mode} /><ChipRow chips={it.chips} /></SummaryCard>)}</div> : <article className="creator-empty-state"><strong>Nothing configured yet.</strong><p>This section is optional until the profile needs it.</p></article>}</PanelSection>;
}

function InstallRulesPanel({ items, mode, addRule, openEditor, duplicateItem, removeItem, toggleItem, dryRun }: { items: Item[]; mode: Mode; update: (index: number, patch: Partial<Item>) => void; addRule: () => void; openEditor: (index: number) => void; duplicateItem: (index: number) => void; removeItem: (index: number) => void; toggleItem: (index: number) => void; dryRun: (label: string) => void }) {
  return <PanelSection title="Install behavior"><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={addRule}>Add Install Rule</button></div>{items.length ? <div className="creator-compact-list">{items.map((entry, index) => <article className="creator-source-row" key={entry.id}><div><strong>{entry.title}</strong><span>{entry.summary}</span></div><span>{listField(entry, "Conditions").slice(0, 2).join(" + ") || fieldValue(entry, "Conditions") || "No conditions"}</span><em>{listField(entry, "Actions").slice(0, 2).join(" + ") || fieldValue(entry, "Actions") || "No actions"}</em><div className="creator-card-actions"><button className="creator-button secondary" type="button" onClick={() => openEditor(index)}>Edit</button><button className="creator-button secondary" type="button" onClick={() => dryRun(`Dry-run ${entry.title}`)}>Dry Run</button><button className="creator-button secondary" type="button" onClick={() => duplicateItem(index)}>Duplicate</button><button className="creator-button secondary" type="button" onClick={() => toggleItem(index)}>{entry.enabled === false ? "Enable" : "Disable"}</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeItem(index)}>Remove</button></div>{mode === "advanced" && <FieldList fields={entry.fields} mode={mode} />}</article>)}</div> : <article className="creator-empty-state"><strong>No install behavior yet.</strong><p>Add a rule when you know where recognized files should go. Common presets and custom/manual rules are available in the editor.</p></article>}</PanelSection>;
}

function EnableDisablePanel({ items, mode, addStrategy, openEditor, duplicateItem, removeItem, toggleItem, dryRun }: { items: Item[]; mode: Mode; update: (index: number, patch: Partial<Item>) => void; addStrategy: () => void; openEditor: (index: number) => void; duplicateItem: (index: number) => void; removeItem: (index: number) => void; toggleItem: (index: number) => void; dryRun: (label: string) => void }) {
  return <PanelSection title="Toggle strategies"><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={addStrategy}>Add Toggle Strategy</button></div>{items.length ? <div className="creator-card-grid two">{items.map((entry, index) => <SummaryCard key={entry.id} title={entry.title} summary={entry.summary} status={entry.enabled === false ? "Disabled" : "Enabled"} actions={<><button className="creator-button secondary" type="button" onClick={() => openEditor(index)}>Edit</button><button className="creator-button secondary" type="button" onClick={() => dryRun(`Test ${entry.title}`)}>Test</button><button className="creator-button secondary" type="button" onClick={() => duplicateItem(index)}>Duplicate</button><button className="creator-button secondary" type="button" onClick={() => toggleItem(index)}>{entry.enabled === false ? "Enable" : "Disable"}</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeItem(index)}>Remove</button></>}><FieldList fields={entry.fields} mode={mode} /></SummaryCard>)}</div> : <article className="creator-empty-state"><strong>No toggle strategies yet.</strong><p>Add one only when this game supports disabling and restoring tracked files.</p></article>}</PanelSection>;
}

function LoadOrderPanel({ draft, mode, setDraft }: { draft: Draft; mode: Mode; setDraft: Dispatch<SetStateAction<Draft>> }) {
  const hasLoadOrder = draft.sections.loadOrder.length > 0 || draft.customFileTypes.length > 0;
  const ordered = [...draft.customFileTypes].sort((a, b) => a.priority - b.priority);
  return <PanelSection title="Load order strategy"><div className="creator-priority-guide">{priorityOptions.map((option) => <button className="creator-priority-card" type="button" key={option.value}><strong>{option.label}</strong><span>{option.description}</span>{mode === "advanced" && <code>{option.score}</code>}</button>)}</div>{hasLoadOrder ? <div className="creator-load-order-list">{draft.sections.loadOrder.map((it) => <SummaryCard key={it.id} title={it.title} summary={it.summary}><FieldList fields={it.fields} mode={mode} /><ChipRow chips={it.chips} /></SummaryCard>)}{ordered.map((fileType) => { const index = draft.customFileTypes.findIndex((candidate) => candidate.id === fileType.id); return <SummaryCard key={fileType.id} title={fileType.name || "Custom Mod Type"} summary={`Layer: ${priorityLabel(fileType.priority)}`}><select className="setting-input" value={priorityLevelFromValue(fileType.priority)} onChange={(event) => setDraft((current) => { const rows = [...current.customFileTypes]; rows[index] = { ...rows[index], priority: priorityScore(event.target.value) }; return { ...current, customFileTypes: rows }; })}>{priorityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="custom">Custom Priority</option></select>{mode === "advanced" && <label>Raw priority<input className="setting-input" type="number" value={fileType.priority} onChange={(event) => setDraft((current) => { const rows = [...current.customFileTypes]; rows[index] = { ...rows[index], priority: Number(event.target.value) }; return { ...current, customFileTypes: rows }; })} /></label>}</SummaryCard>; })}</div> : <article className="creator-empty-state"><strong>No load order rules yet.</strong><p>Load order stays empty until a mod type or explicit rule needs ordering. You can still review the priority model above.</p></article>}</PanelSection>;
}

function DependenciesPanel({ profileId, items, mode, addDependency, openEditor, duplicateItem, removeItem, toggleItem: _toggleItem, dryRun }: { profileId: string; items: Item[]; mode: Mode; update: (index: number, patch: Partial<Item>) => void; addDependency: (type?: string) => void; openEditor: (index: number) => void; duplicateItem: (index: number) => void; removeItem: (index: number) => void; toggleItem: (index: number) => void; dryRun: (label: string) => void }) {
  const graph = dependencyGraphPlan(items);
  const catalogDependencies = dependenciesForProfile(profileId);
  if (catalogDependencies.length > 0) {
    return <PanelSection title="Dependencies">
      <div className="creator-action-row"><button className="creator-button primary" type="button" onClick={() => addDependency("Custom Dependency")}>Add Dependency</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Check Dependency Updates")}>Check Dependency Updates</button></div>
      <p className="creator-section-note">Built-in dependency identities are enriched automatically; existing profile records and receipts remain valid.</p>
      <div className="creator-compact-list dependency-row-list">
        {catalogDependencies.map((dependency) => <article className="creator-source-row dependency-summary-row" key={dependency.id}>
          <div><DependencyName dependency={dependency} /><span>{dependency.description}</span></div>
          <span>{dependency.required ? "Required" : dependency.optional ? "Optional" : "Recommended"}</span>
          <span>{dependency.requires?.length ? `Requires ${dependency.requires.map((id) => catalogDependencies.find((candidate) => candidate.id === id)?.name ?? id).join(", ")}` : "No parent dependency"}</span>
          <DependencyActions profileId={profileId} dependency={dependency} />
        </article>)}
      </div>
      <SummaryCard title="Dependency Graph" summary="Tsuki resolves parent dependencies first and deduplicates shared frameworks."><div className="creator-guided-summary"><span>Profile records enriched</span><strong>{items.length}</strong><span>Catalog identities</span><strong>{catalogDependencies.length}</strong><span>Cycles</span><strong>{graph.cycles.length ? graph.cycles.join(" | ") : "None"}</strong></div></SummaryCard>
    </PanelSection>;
  }
  return <PanelSection title="Dependencies"><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={() => addDependency("Custom Dependency")}>Add Dependency</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Check Dependency Updates")}>Check Dependency Updates</button></div><p className="creator-section-note">Add the loaders, frameworks, libraries, tools, or supporting mods that other mods need.</p>{items.length ? <><div className="creator-compact-list dependency-row-list">{items.map((rawEntry, index) => { const entry = normalizeDependencyItem(rawEntry); const usedBy = listField(entry, "Used By"); const requires = listField(entry, "Requires Dependencies"); const configured = Boolean(fieldValue(entry, "Marker File") || fieldValue(entry, "Marker Folder") || listField(entry, "Marker Filenames").length || listField(entry, "Marker Folders").length || fieldValue(entry, "Dependency Page URL") || fieldValue(entry, "GitHub Repository")); return <article className="creator-source-row dependency-summary-row" key={entry.id}><div><strong>{entry.title}</strong><span>{entry.summary || `${fieldValue(entry, "Dependency Kind") || "Dependency"} required by supported mods.`}</span></div><span>Status: {entry.enabled === false ? "Disabled" : configured ? "Configured - Untested" : "Needs setup"}</span><span>Used by: {usedBy.length ? usedBy.join(", ") : "Not linked yet"}</span><em>Download: {dependencyDownloadSummary(entry)}</em><div className="creator-card-actions"><button className="creator-button secondary" type="button" onClick={() => openEditor(index)}>Edit</button><button className="creator-button secondary" type="button" onClick={() => dryRun(`Test ${entry.title}`)}>Test</button><button className="creator-button secondary" type="button" onClick={() => duplicateItem(index)}>Duplicate</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeItem(index)}>Remove</button></div><div className="creator-chip-row"><span>{fieldValue(entry, "Required") || "Optional / Recommended"}</span><span>{fieldValue(entry, "Dependency Kind") || "Dependency"}</span>{requires.map((parent) => <span key={parent}>Requires {parent}</span>)}</div>{mode === "advanced" && <FieldList fields={entry.fields} mode={mode} />}</article>; })}</div><SummaryCard title="Dependency Graph" summary="Tsuki resolves parent dependencies first, removes duplicates, and blocks cycles before install."><div className="creator-guided-summary"><span>Install order</span><strong>{graph.order.length ? graph.order.join(" -> ") : "No dependencies"}</strong><span>Cycles</span><strong>{graph.cycles.length ? graph.cycles.join(" | ") : "None"}</strong><span>Missing parents</span><strong>{graph.missing.length ? graph.missing.join(", ") : "None"}</strong></div></SummaryCard><SummaryCard title="First-Time Setup" summary="Profiles can prompt users to install required dependencies, recommended dependencies, or mod-type dependencies without forcing optional frameworks."><div className="creator-guided-summary"><span>Core dependencies</span><strong>{items.filter((entry) => fieldValue(entry, "Required") === "Required for profile").map((entry) => entry.title).join(", ") || "None"}</strong><span>Mod-type dependencies</span><strong>{items.filter((entry) => fieldValue(entry, "Required") === "Required by Mod Type").map((entry) => entry.title).join(", ") || "None"}</strong><span>Recommended</span><strong>{items.filter((entry) => fieldValue(entry, "Required") === "Optional / Recommended").map((entry) => entry.title).join(", ") || "None"}</strong></div></SummaryCard></> : <article className="creator-empty-state"><strong>No dependencies configured.</strong><p>Dependencies are frameworks, loaders, libraries, tools, or supporting mods required by other mods. Add one only when another mod type or dependency needs it.</p></article>}</PanelSection>;
}

function ConflictsPanel({ items, mode, update, addConflictRule, openEditor, duplicateItem, removeItem, toggleItem }: { items: Item[]; mode: Mode; update: (index: number, patch: Partial<Item>) => void; addConflictRule: (preset?: string) => void; openEditor: (index: number) => void; duplicateItem: (index: number) => void; removeItem: (index: number) => void; toggleItem: (index: number) => void }) {
  return <PanelSection title="Conflict policy"><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={() => addConflictRule("Ask User")}>Add Conflict Rule</button></div>{items.length ? <div className="creator-card-grid two">{items.map((it, index) => <SummaryCard key={it.id} title={it.title} summary={it.summary} status={it.enabled === false ? "Disabled" : fieldValue(it, "Resolution") || "Configured"} actions={<><button className="creator-button secondary" type="button" onClick={() => openEditor(index)}>Edit</button><button className="creator-button secondary" type="button" onClick={() => duplicateItem(index)}>Duplicate</button><button className="creator-button secondary" type="button" onClick={() => toggleItem(index)}>{it.enabled === false ? "Enable" : "Disable"}</button><button className="creator-button secondary danger-button" type="button" onClick={() => removeItem(index)}>Remove</button></>}><FieldList fields={it.fields} mode={mode} /><label>Resolution<select className="setting-input" value={fieldValue(it, "Resolution") || conflictRulePresets[0]} onChange={(event) => update(index, replaceField(it, "Resolution", event.target.value))}>{conflictRulePresets.map((option) => <option key={option}>{option}</option>)}</select></label></SummaryCard>)}</div> : <article className="creator-empty-state"><strong>No conflict rules configured.</strong><p>Conflict rules define what happens when multiple mods target the same files or cannot coexist.</p></article>}</PanelSection>;
}

function UpdatesPanel({ items, mode, update }: { items: Item[]; mode: Mode; update: (index: number, patch: Partial<Item>) => void }) {
  const choices = ["Replace tracked files", "Preserve marked config", "Remove obsolete receipt files", "Allow downgrade after confirmation", "Keep shared dependencies"];
  return <PanelSection title="Updates and uninstall">{items.length ? <div className="creator-card-grid two">{items.map((it, index) => <SummaryCard key={it.id} title={it.title} summary={it.summary}><FieldList fields={it.fields} mode={mode} /><div className="creator-checkbox-stack">{choices.map((choice) => <label key={choice}><input type="checkbox" checked={it.summary.includes(choice)} onChange={(event) => update(index, { summary: event.target.checked ? `${it.summary} ${choice}.` : it.summary.replace(choice, "").replace(/\s+\./g, ".") })} />{choice}</label>)}</div></SummaryCard>)}</div> : <article className="creator-empty-state"><strong>No update or uninstall rules yet.</strong><p>Receipts stay untouched. Add policies only when this profile needs custom update behavior.</p></article>}</PanelSection>;
}

function TaxonomyPanel({ items, mode, update }: { items: Item[]; mode: Mode; update: (index: number, patch: Partial<Item>) => void }) {
  function addChip(it: Item, index: number) {
    const next = [...(it.chips ?? []), `Custom ${((it.chips?.length ?? 0) + 1)}`];
    update(index, { chips: next });
  }
  return <PanelSection title="Tags and categories"><div className="creator-action-row"><button className="creator-button secondary" type="button" disabled title="Source refresh is handled by the tag registry tools for the selected game.">Refresh Categories</button></div>{items.length ? ["ModWorkshop", "Nexus", "Fallback"].map((group) => <div className="creator-tag-group" key={group}><h3>{group === "Fallback" ? "CUSTOM TAGS" : `${group.toUpperCase()} CATEGORIES`}</h3><div className="creator-card-grid two">{items.filter((it) => it.title.toLowerCase().includes(group.toLowerCase()) || (group === "Fallback" && it.id.includes("fallback"))).map((it) => { const index = items.indexOf(it); return <SummaryCard key={it.id} title={it.title} summary={it.summary}><FieldList fields={it.fields} mode={mode} /><ChipRow chips={it.chips} /><div className="creator-color-picker"><label>Color<input type="color" value={fieldValue(it, "Color") || "#7aa2ff"} onChange={(event) => update(index, replaceField(it, "Color", event.target.value))} /></label><button className="creator-button secondary" type="button" onClick={() => addChip(it, index)}>Create Custom Tag</button></div></SummaryCard>; })}</div></div>) : <article className="creator-empty-state"><strong>No tags or categories yet.</strong><p>Source and custom tags stay empty until discovered or added for this game.</p></article>}</PanelSection>;
}

function AdvancedRulesPanel({ draft, setDraft, importRule, exportText }: { draft: Draft; mode: Mode; setDraft: Dispatch<SetStateAction<Draft>>; importRule: (kind: "json" | "txt") => void; exportText: (kind: "json" | "txt", contents: string, defaultName: string) => void }) {
  const raw = draft.advancedJson === "{}" ? JSON.stringify({ customPaths: draft.customPaths, customFileTypes: draft.customFileTypes, unknownFileFallback: draft.unknownFileFallback, sections: draft.sections.advancedRules }, null, 2) : draft.advancedJson;
  const lineCount = Math.max(1, raw.split("\n").length); return <PanelSection title="Advanced rule entry"><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => { try { setDraft((current) => ({ ...current, advancedJson: JSON.stringify(JSON.parse(raw), null, 2) })); } catch { /* validate below */ } }}>Format</button><button className="creator-button secondary" type="button" onClick={() => { try { JSON.parse(raw); } catch { return; } }}>Validate</button><button className="creator-button secondary" type="button" onClick={() => importRule("json")}>Import JSON</button><button className="creator-button secondary" type="button" onClick={() => importRule("txt")}>Import TXT</button><button className="creator-button secondary" type="button" onClick={() => exportText("json", raw, `${safeKey(draft.overview.profileTitle || "profile")}-rules.json`)}>Export Rule</button></div><p className="creator-safety-note">Approved actions only. Shell commands, arbitrary executables, and unrestricted system writes remain blocked.</p><div className="creator-code-editor"><div className="creator-code-lines">{Array.from({ length: lineCount }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea spellCheck={false} value={raw} onChange={(event) => setDraft((current) => ({ ...current, advancedJson: event.target.value }))} /></div><div className="creator-rule-preview"><span>Approved actions</span><strong>copy, backup_then_copy, move_tracked_files, restore_tracked_files, patch_ini, patch_json, verify_hash, write_manifest_entry</strong><span>Approved roots</span><strong>{approvedRoots.map(nice).join(", ")}</strong></div></PanelSection>;
}

function TestWorkspace({ draft, setDraft, chooseGameFolder, chooseSampleArchive, dryRun }: { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; chooseGameFolder: () => void; chooseSampleArchive: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  const match = bestCustomMatch(draft);
  const operations = ["Test Detection", "Test Paths", "Test Custom File Type", "Dry-Run Install", "Dry-Run Enable", "Dry-Run Disable", "Dry-Run Update", "Dry-Run Uninstall", "Test Load Order", "Test Conflict", "Test Rollback"];
  return <PanelSection title="Dry-run workspace"><div className="creator-test-workspace"><div className="creator-card-grid two"><FileSelector label="Sample File" value={draft.customTest.sampleFilename} mode="file" onChange={(value) => setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleFilename: value } }))} dryRun={(label) => dryRun(label, "testProfile")} /><FileSelector label="Sample Archive" value={draft.customTest.sampleArchive} mode="archive" onChange={(value) => setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleArchive: value } }))} dryRun={(label) => dryRun(label, "testProfile")} /><PathSelector label="Test Game Folder" value={draft.customTest.sampleGameRoot} mode="advanced" sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => setDraft((current) => ({ ...current, customTest: { ...current.customTest, sampleGameRoot: value } }))} dryRun={(label) => dryRun(label, "testProfile")} allowNamed={false} /></div><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={chooseSampleArchive}>Choose Sample Archive</button><button className="creator-button secondary" type="button" onClick={chooseGameFolder}>Choose Game Folder</button></div><div className="creator-test-grid">{operations.map((label) => <button className="creator-button secondary" type="button" key={label} onClick={() => dryRun(label, "testProfile")}>{label}</button>)}</div><div className="creator-compact-preview"><strong>MATCHES</strong><span>{match ? fileTypePatterns(match).join(", ") : "No custom match"}</span><strong>INSTALLS TO</strong><span>{match ? friendlyPath(match.destination) : draft.unknownFileFallback}</span><strong>BEHAVIOR</strong><span>{match ? `${match.enableDisableStrategy}, ${match.conflictPolicy}` : "Preview required"}</span></div><details className="creator-advanced-panel"><summary>Open Full Preview</summary><div className="creator-rule-preview">{draft.testOutput.map((line) => <strong key={line}>{line}</strong>)}</div></details></div></PanelSection>;
}

function ReviewPanel({ sectionStates, issues, blocked, setActive, exportDraft, draft, exportJson }: { sectionStates: Array<{ id: SectionId; label: string; status: SectionStatus }>; issues: Array<{ level: IssueLevel; section: SectionId; text: string }>; blocked: boolean; setActive: (section: SectionId) => void; exportDraft: () => void; draft: Draft; exportJson: () => void }) {
  return <PanelSection title="Review and export"><div className="creator-review-grid">{sectionStates.map((section) => <button className="creator-review-row" type="button" key={section.id} onClick={() => setActive(section.id)}><strong>{section.label}</strong><span>{statusLabel(section.status)}</span></button>)}</div><div className="creator-rule-preview"><span>Export readiness</span><strong>{blocked ? "Blocked by required validation errors." : issues.some((issue) => issue.level === "untested") ? "Configured, but dry-runs are still required before release." : "Ready to export as a draft package."}</strong><strong>{draft.customFileTypes.length} custom file type(s), {draft.customPaths.length} custom path(s)</strong><strong>Custom data is stored inside the draft JSON and exported with the profile package.</strong></div><div className="creator-action-row"><button className="creator-button primary" type="button" disabled={blocked} onClick={exportDraft}>Export .tsukiprofile</button><button className="creator-button secondary" type="button" onClick={exportJson}>Export JSON</button></div></PanelSection>;
}

function FocusedEditor({ target, draft, mode, setDraft, close, dryRun }: { target: EditorTarget; draft: Draft; mode: Mode; setDraft: Dispatch<SetStateAction<Draft>>; close: () => void; dryRun: (label: string, section?: SectionId) => void; chooseDestinationFolder: (pathIndex?: number) => void; chooseDependencyArchive: (index: number) => void }) {
  if (!target) return null;
  if (target.custom) {
    const fileType = draft.customFileTypes[target.index];
    return fileType ? <CustomModTypeSheet fileType={fileType} draft={draft} mode={mode} index={target.index} setDraft={setDraft} close={close} dryRun={dryRun} /> : null;
  }
  const entry = draft.sections[target.section]?.[target.index];
  if (!entry) return null;
  if (target.section === "installBehavior") return <InstallRuleSheet entry={entry} index={target.index} draft={draft} mode={mode} setDraft={setDraft} close={close} dryRun={dryRun} />;
  if (target.section === "dependencies") return <DependencySheet entry={entry} index={target.index} draft={draft} mode={mode} setDraft={setDraft} close={close} dryRun={dryRun} />;
  if (target.section === "enableDisable") return <ToggleStrategySheet entry={entry} index={target.index} draft={draft} mode={mode} setDraft={setDraft} close={close} dryRun={dryRun} />;
  return <GenericItemSheet entry={entry} index={target.index} section={target.section} mode={mode} setDraft={setDraft} close={close} dryRun={dryRun} />;
}

function SheetFrame({ title, subtitle, step, steps, setStep, close, saveLabel = "Done", children }: { title: string; subtitle: string; step?: number; steps?: string[]; setStep?: (step: number) => void; close: () => void; saveLabel?: string; children: ReactNode }) {
  const isStepped = step !== undefined && Boolean(steps?.length) && Boolean(setStep);
  const canGoBack = isStepped && step! > 0;
  const canGoNext = isStepped && step! < steps!.length - 1;
  return <div className="creator-drawer-backdrop" role="presentation"><aside className="creator-editor-sheet" role="dialog" aria-modal="true" aria-label={title}><header className="creator-editor-header"><div><h2>{title}</h2><p>{isStepped ? `Step ${step! + 1} of ${steps!.length}: ${steps![step!]}` : subtitle}</p></div><button className="creator-button ghost" type="button" onClick={close}>Close</button></header><div className="creator-editor-content">{children}</div><footer className="creator-editor-footer"><div className="creator-editor-footer-left">{isStepped && <button className="creator-button ghost" type="button" disabled={!canGoBack} onClick={() => setStep!(Math.max(0, step! - 1))}>Back</button>}</div><div className="creator-editor-footer-right"><button className="creator-button ghost" type="button" onClick={close}>{saveLabel}</button>{isStepped && <button className="creator-button primary" type="button" disabled={!canGoNext} onClick={() => setStep!(Math.min(steps!.length - 1, step! + 1))}>{canGoNext ? "Next" : "Done"}</button>}</div></footer></aside></div>;
}

function OptionCards({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string; description?: string }>; onChange: (value: string) => void }) {
  return <div className="creator-option-grid">{options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" key={option.value} onClick={() => onChange(option.value)}><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</button>)}</div>;
}

function ConditionActionList({ title, values, options, onChange, addLabel }: { title: string; values: string[]; options: string[]; onChange: (values: string[]) => void; addLabel: string }) {
  return <section className="creator-builder-section"><header><div><h3>{title}</h3></div><button className="creator-button secondary" type="button" onClick={() => onChange([...values, options[0]])}>{addLabel}</button></header><div className="creator-rule-list">{values.map((value, index) => <div className="creator-rule-row" key={`${value}-${index}`}><select className="setting-input" value={value} onChange={(event) => { const next = [...values]; next[index] = event.target.value; onChange(next); }}>{options.map((option) => <option key={option}>{option}</option>)}</select><input className="setting-input" placeholder="Value or selector" /><button className="creator-button secondary" type="button" onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></div>)}</div></section>;
}

function RuleBuilder({ conditions, actions, destination, onConditions, onActions, onDestination, draft, mode }: { conditions: string; actions: string; destination: string; onConditions: (value: string) => void; onActions: (value: string) => void; onDestination: (value: string) => void; draft: Draft; mode: Mode }) {
  const conditionOptions = ["File extension is", "Filename matches", "Archive contains file", "Archive contains folder", "Path contains", "Mod type is", "Source is", "Source category is", "Source tag is", "Dependency is installed", "Storefront is", "Game version matches", "User selected component", "AND group", "OR group", "NOT group"];
  const actionOptions = ["Copy matching files", "Copy entire folder", "Preserve archive structure", "Flatten wrapper folder", "Merge into destination", "Move files", "Rename files", "Ignore files", "Back up then overwrite", "Create folder", "Patch INI", "Patch JSON", "Patch XML", "Write manifest entry", "Install approved dependency", "Add to load order", "Track receipt ownership"];
  return <div className="creator-form-stack"><ConditionActionList title="WHEN" values={conditions.split("|").filter(Boolean)} options={conditionOptions} onChange={(values) => onConditions(values.join("|"))} addLabel="Add Condition" /><ConditionActionList title="THEN" values={actions.split("|").filter(Boolean)} options={actionOptions} onChange={(values) => onActions(values.join("|"))} addLabel="Add Action" /><PathSelector label="Destination" value={destination} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={onDestination} dryRun={() => undefined} /></div>;
}

function FieldEditor({ entry, fields, update }: { entry: Item; fields: string[]; update: (entry: Item) => void }) {
  return <div className="creator-form-grid compact">{fields.map((field) => <label key={field}>{field}<TransferTextInput value={fieldValue(entry, field)} imageOnly={isImageFieldLabel(field)} onChange={(value) => update(replaceField(entry, field, value))} /></label>)}</div>;
}
function CustomModTypeSheet({ fileType, draft, mode, index, setDraft, close, dryRun }: { fileType: CustomFileType; draft: Draft; mode: Mode; index: number; setDraft: Dispatch<SetStateAction<Draft>>; close: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  const steps = ["Identity", "Detection", "Files", "Destination", "Install", "Enable / Disable", "Load Order", "Dependency", "Conflicts", "Test & Save"];
  const [step, setStep] = useState(0);
  function update(patch: Partial<CustomFileType>) {
    setDraft((current) => { const rows = [...current.customFileTypes]; rows[index] = { ...rows[index], ...patch }; return { ...current, customFileTypes: rows }; });
  }
  return <SheetFrame title={fileType.name || "Custom Mod Type"} subtitle="Focused editor" step={step} steps={steps} setStep={setStep} close={close}>{step === 0 && <div className="creator-form-stack"><OptionCards value={fileType.kind} options={fileTypeKindOptions} onChange={(value) => update({ kind: value as CustomFileTypeKind })} /><label>Display Name<input className="setting-input" value={fileType.name} placeholder="Custom Mod Type" onChange={(event) => update({ name: event.target.value })} /></label><label>Description<textarea className="setting-input" value={fileType.conditions} placeholder="Describe what this type installs." onChange={(event) => update({ conditions: event.target.value })} /></label></div>}{step === 1 && <div className="creator-form-stack"><OptionCards value={fileType.kind} options={fileTypeKindOptions} onChange={(value) => update({ kind: value as CustomFileTypeKind })} />{fileType.kind === "filename_pattern" && <label>Filename Pattern<input className="setting-input" value={fileType.filenamePattern} placeholder="mod_*.bundle" onChange={(event) => update({ filenamePattern: event.target.value })} /></label>}{fileType.kind === "folder_based" && <FileSelector label="Marker File" value={fileType.folderMarker} mode="markerFile" onChange={(value) => update({ folderMarker: value })} dryRun={(label) => dryRun(label, "modTypes")} />}</div>}{step === 2 && <ExtensionStep fileType={fileType} update={update} dryRun={dryRun} />}{step === 3 && <PathSelector label="Install Destination" value={fileType.destination} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => update({ destination: value })} dryRun={(label) => dryRun(label, "modTypes")} />}{step === 4 && <RuleBuilder conditions={fileType.conditions} actions={fileType.enableDisableStrategy} destination={fileType.destination} onConditions={(value) => update({ conditions: value })} onActions={(value) => update({ enableDisableStrategy: value })} onDestination={(value) => update({ destination: value })} draft={draft} mode={mode} />}{step === 5 && <ToggleFields disableValue={fileType.enableDisableStrategy} enableValue={fileType.loadOrderStrategy} destination={fileType.destination} draft={draft} mode={mode} onDisable={(value) => update({ enableDisableStrategy: value })} onEnable={(value) => update({ loadOrderStrategy: value })} onDestination={(value) => update({ destination: value })} />}{step === 6 && <div className="creator-form-stack"><OptionCards value={priorityLevelFromValue(fileType.priority)} options={priorityOptions.map((option) => ({ value: option.value, label: option.label, description: option.description }))} onChange={(value) => update({ priority: priorityScore(value) })} />{mode === "advanced" && <label>Raw priority<input className="setting-input" type="number" value={fileType.priority} onChange={(event) => update({ priority: Number(event.target.value) })} /></label>}</div>}{step === 7 && <label>Dependency<select className="setting-input" value={fileType.requiredDependency} onChange={(event) => update({ requiredDependency: event.target.value })}><option>None</option>{draft.sections.dependencies.map((dependency) => <option key={dependency.id}>{dependency.title}</option>)}</select></label>}{step === 8 && <label>Conflict Policy<select className="setting-input" value={fileType.conflictPolicy} onChange={(event) => update({ conflictPolicy: event.target.value })}>{["Ask User", "Back Up and Replace", "Block Install", "Allow Side by Side"].map((policy) => <option key={policy}>{policy}</option>)}</select></label>}{step === 9 && <div className="creator-compact-preview"><strong>MATCHES</strong><span>{fileTypePatterns(fileType).join(", ") || "No matcher"}</span><strong>INSTALLS TO</strong><span>{friendlyPath(fileType.destination)}</span><strong>BEHAVIOR</strong><span>{fileType.enableDisableStrategy || "Not configured"}</span><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => dryRun("Test With File", "modTypes")}>Test With File</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Test With Archive", "modTypes")}>Test With Archive</button></div></div>}</SheetFrame>;
}

function catalogEntryValue(entry: FileCatalogEntry, caseSensitive = false) {
  if (entry.kind === "extension") return normalizeExtensionInput(entry.value, caseSensitive);
  if (entry.kind === "exact") return normalizeExactFilename(entry.value, caseSensitive);
  return normalizeFolderMarker(entry.value, caseSensitive);
}

function catalogEntryKey(entry: FileCatalogEntry, caseSensitive = false) {
  return `${entry.kind}:${catalogEntryValue(entry, caseSensitive)}`;
}

function catalogKindLabel(kind: FileCatalogKind) {
  if (kind === "extension") return "File extension";
  if (kind === "exact") return "Exact filename";
  return "Folder marker";
}

function fileSelectionPatch(fileType: CustomFileType, extensions: string[], exactFilenames: string[], folderMarkers: string[]): Partial<CustomFileType> {
  const cleanExtensions = uniqueStrings(extensions.map((value) => normalizeExtensionInput(value, fileType.caseSensitive)).filter(Boolean));
  const cleanExact = uniqueStrings(exactFilenames.map((value) => normalizeExactFilename(value, fileType.caseSensitive)).filter(Boolean));
  const cleanFolders = uniqueStrings(folderMarkers.map((value) => normalizeFolderMarker(value, fileType.caseSensitive)).filter(Boolean));
  const inferredKind: CustomFileTypeKind = cleanFolders.length && !cleanExtensions.length && !cleanExact.length
    ? "folder_based"
    : cleanExact.length && !cleanExtensions.length && !cleanFolders.length
      ? "filename_pattern"
      : cleanExtensions.length > 1 && (fileType.fileMatchMode === "same_basename" || fileType.extensionGroupMode === "all_paired")
        ? "paired_file_set"
        : cleanExtensions.length
          ? "custom_extension"
          : fileType.kind;
  return {
    extension: cleanExtensions[0] ?? "",
    extensions: cleanExtensions.slice(1),
    allowMultipleExtensions: cleanExtensions.length > 1,
    exactFilenames: cleanExact,
    folderMarkers: cleanFolders,
    folderMarker: cleanFolders.join("|"),
    kind: inferredKind,
  };
}

function SelectionChipList({ title, values, onRemove }: { title: string; values: string[]; onRemove: (value: string) => void }) {
  return <div className="creator-selected-file-group"><strong>{title}</strong>{values.length ? <div className="creator-extension-chip-row">{values.map((value) => <span className="creator-editable-chip selected" key={value}>{value}<button type="button" onClick={() => onRemove(value)}>Remove</button></span>)}</div> : <small>None selected</small>}</div>;
}

function FileCatalogSelector({ fileType, update, mode, dryRun }: { fileType: CustomFileType; update: (patch: Partial<CustomFileType>) => void; mode: Mode; dryRun: (label: string, section?: SectionId) => void }) {
  const [search, setSearch] = useState("");
  const [customExtension, setCustomExtension] = useState("");
  const [customExact, setCustomExact] = useState("");
  const [customFolder, setCustomFolder] = useState("");
  const extensions = selectedFileExtensions(fileType);
  const exactFilenames = selectedExactFilenames(fileType);
  const folderMarkers = selectedFolderMarkers(fileType);
  const selectedKeys = new Set([
    ...extensions.map((value) => `extension:${value}`),
    ...exactFilenames.map((value) => `exact:${value}`),
    ...folderMarkers.map((value) => `folder:${value}`),
  ]);
  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return fileCatalogGroups;
    return fileCatalogGroups.map((group) => ({ ...group, items: group.items.filter((entry) => `${entry.value} ${entry.label ?? ""} ${entry.description ?? ""}`.toLowerCase().includes(query)) })).filter((group) => group.items.length);
  }, [search]);
  function applySelections(nextExtensions = extensions, nextExact = exactFilenames, nextFolders = folderMarkers) {
    update(fileSelectionPatch(fileType, nextExtensions, nextExact, nextFolders));
  }
  function toggleEntry(entry: FileCatalogEntry) {
    const value = catalogEntryValue(entry, fileType.caseSensitive);
    if (!value) return;
    if (entry.kind === "extension") applySelections(selectedKeys.has(`extension:${value}`) ? extensions.filter((item) => item !== value) : [...extensions, value], exactFilenames, folderMarkers);
    if (entry.kind === "exact") applySelections(extensions, selectedKeys.has(`exact:${value}`) ? exactFilenames.filter((item) => item !== value) : [...exactFilenames, value], folderMarkers);
    if (entry.kind === "folder") applySelections(extensions, exactFilenames, selectedKeys.has(`folder:${value}`) ? folderMarkers.filter((item) => item !== value) : [...folderMarkers, value]);
  }
  function selectGroup(group: FileCatalogGroup) {
    let nextExtensions = [...extensions];
    let nextExact = [...exactFilenames];
    let nextFolders = [...folderMarkers];
    for (const entry of group.items) {
      const value = catalogEntryValue(entry, fileType.caseSensitive);
      if (!value) continue;
      if (entry.kind === "extension" && !nextExtensions.includes(value)) nextExtensions.push(value);
      if (entry.kind === "exact" && !nextExact.includes(value)) nextExact.push(value);
      if (entry.kind === "folder" && !nextFolders.includes(value)) nextFolders.push(value);
    }
    applySelections(nextExtensions, nextExact, nextFolders);
  }
  function clearGroup(group: FileCatalogGroup) {
    const groupKeys = new Set(group.items.map((entry) => catalogEntryKey(entry, fileType.caseSensitive)));
    applySelections(
      extensions.filter((value) => !groupKeys.has(`extension:${value}`)),
      exactFilenames.filter((value) => !groupKeys.has(`exact:${value}`)),
      folderMarkers.filter((value) => !groupKeys.has(`folder:${value}`)),
    );
  }
  function addCustom(kind: FileCatalogKind, value: string, clear: () => void) {
    const normalized = kind === "extension" ? normalizeExtensionInput(value, fileType.caseSensitive) : kind === "exact" ? normalizeExactFilename(value, fileType.caseSensitive) : normalizeFolderMarker(value, fileType.caseSensitive);
    if (!normalized) return;
    if (kind === "extension" && !extensions.includes(normalized)) applySelections([...extensions, normalized], exactFilenames, folderMarkers);
    if (kind === "exact" && !exactFilenames.includes(normalized)) applySelections(extensions, [...exactFilenames, normalized], folderMarkers);
    if (kind === "folder" && !folderMarkers.includes(normalized)) applySelections(extensions, exactFilenames, [...folderMarkers, normalized]);
    clear();
  }
  function setMatchMode(value: string) {
    const fileMatchMode = value as FileMatchMode;
    update({ fileMatchMode, extensionGroupMode: fileMatchMode === "same_basename" || fileMatchMode === "all" ? "all_paired" : "any", pairedRequired: fileMatchMode === "same_basename" || fileMatchMode === "all" });
  }
  const matchMode = fileType.fileMatchMode ?? (fileType.kind === "folder_based" ? "folder" : fileType.kind === "filename_pattern" ? "custom" : fileType.kind === "paired_file_set" ? "same_basename" : "any");
  return <div className="creator-form-stack creator-file-catalog"><section className="creator-builder-section"><header><div><h3>What files belong to this mod type?</h3><p>Select known file types, exact marker files, or folder markers. Custom entries stay separated from source/catalog entries.</p></div></header><FormField label="Search file catalog" size="wide"><TransferTextInput value={search} placeholder="Search extensions, filenames, or groups" onChange={setSearch} /></FormField><div className="creator-catalog-selected"><SelectionChipList title="FILE EXTENSIONS" values={extensions} onRemove={(value) => applySelections(extensions.filter((item) => item !== value), exactFilenames, folderMarkers)} /><SelectionChipList title="EXACT FILENAMES" values={exactFilenames} onRemove={(value) => applySelections(extensions, exactFilenames.filter((item) => item !== value), folderMarkers)} /><SelectionChipList title="FOLDER / STRUCTURE MARKERS" values={folderMarkers} onRemove={(value) => applySelections(extensions, exactFilenames, folderMarkers.filter((item) => item !== value))} /></div>{visibleGroups.map((group) => <section className="creator-catalog-group" key={group.title}><header><strong>{group.title}</strong><div><button className="creator-button secondary" type="button" onClick={() => selectGroup(group)}>Select All</button><button className="creator-button ghost" type="button" onClick={() => clearGroup(group)}>Clear Group</button></div></header><div className="creator-catalog-grid">{group.items.map((entry) => { const value = catalogEntryValue(entry, fileType.caseSensitive); const selected = selectedKeys.has(`${entry.kind}:${value}`); return <button className={selected ? "creator-catalog-chip selected" : "creator-catalog-chip"} type="button" key={`${group.title}-${entry.kind}-${entry.value}`} onClick={() => toggleEntry(entry)}><strong>{entry.label ?? entry.value}</strong><span>{catalogKindLabel(entry.kind)}</span></button>; })}</div></section>)}</section><section className="creator-builder-section"><header><div><h3>OTHER</h3><p>Add custom extensions, exact filenames, patterns, or folder markers for game-specific loaders.</p></div></header><FormGrid columns="three"><FormField label="Custom extension" size="wide"><div className="creator-extension-entry"><TransferTextInput value={customExtension} placeholder=".mytype" onChange={setCustomExtension} /><button className="creator-button secondary" type="button" onClick={() => addCustom("extension", customExtension, () => setCustomExtension(""))}>Add</button></div></FormField><FormField label="Exact filename" size="wide"><div className="creator-extension-entry"><TransferTextInput value={customExact} placeholder="manifest.json" onChange={setCustomExact} /><button className="creator-button secondary" type="button" onClick={() => addCustom("exact", customExact, () => setCustomExact(""))}>Add</button></div></FormField><FormField label="Folder marker" size="wide"><div className="creator-extension-entry"><TransferTextInput value={customFolder} placeholder="BepInEx/plugins" onChange={setCustomFolder} /><button className="creator-button secondary" type="button" onClick={() => addCustom("folder", customFolder, () => setCustomFolder(""))}>Add</button></div></FormField></FormGrid><FormField label="Custom filename pattern" help="Use this only when selected chips cannot describe the mod type." size="wide"><TransferTextInput value={fileType.customMatchRule ?? ""} placeholder="nativePC/**/*.arc" onChange={(customMatchRule) => update({ customMatchRule, fileMatchMode: customMatchRule ? "custom" : fileType.fileMatchMode })} /></FormField></section><section className="creator-builder-section"><header><div><h3>Matching Options</h3><p>Choose how Tsuki interprets the selected file types during install preview.</p></div></header><OptionCards value={matchMode} options={fileMatchModeOptions} onChange={setMatchMode} />{matchMode === "custom" && <FormField label="Advanced custom rule" size="wide"><textarea className="setting-input" rows={3} value={fileType.customMatchRule ?? ""} onChange={(event) => update({ customMatchRule: event.target.value })} /></FormField>}{mode === "advanced" && <DetectionBuilder fileType={fileType} update={update} />}<div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => dryRun("Test Match", "modTypes")}>Test Match</button></div></section></div>;
}
function ExtensionStep({ fileType, update, dryRun }: { fileType: CustomFileType; update: (patch: Partial<CustomFileType>) => void; dryRun: (label: string, section?: SectionId) => void }) {
  const [draftExtension, setDraftExtension] = useState("");
  const extensions = [fileType.extension, ...fileType.extensions].filter(Boolean);
  function addExtension() {
    const normalized = normalizeExtensionInput(draftExtension);
    if (!normalized || extensions.includes(normalized)) return;
    if (!fileType.extension) update({ extension: normalized });
    else update({ extensions: [...fileType.extensions, normalized], allowMultipleExtensions: true });
    setDraftExtension("");
  }
  return <div className="creator-form-stack"><div className="creator-extension-entry"><input className="setting-input" value={draftExtension} placeholder=".custommod" onChange={(event) => setDraftExtension(event.target.value)} /><button className="creator-button secondary" type="button" onClick={addExtension}>Add Extension</button></div><div className="creator-extension-chip-row">{extensions.map((extension) => <span className="creator-editable-chip" key={extension}>{extension}<button type="button" onClick={() => fileType.extension === extension ? update({ extension: fileType.extensions[0] ?? "", extensions: fileType.extensions.slice(1) }) : update({ extensions: fileType.extensions.filter((value) => value !== extension) })}>Remove</button></span>)}</div><fieldset className="creator-radio-group"><legend>Matching mode</legend><label><input type="radio" checked={fileType.extensionGroupMode === "any"} onChange={() => update({ extensionGroupMode: "any", pairedRequired: false })} />Match if any selected extension exists</label><label><input type="radio" checked={fileType.extensionGroupMode === "all_paired"} onChange={() => update({ extensionGroupMode: "all_paired", pairedRequired: true })} />Require a paired set</label></fieldset>{fileType.extensionGroupMode === "all_paired" && <div className="creator-form-grid compact"><label>Required companion extensions<input className="setting-input" value={fileType.companionPattern} placeholder=".meta, .sig" onChange={(event) => update({ companionPattern: event.target.value })} /></label><label>Optional companion extensions<input className="setting-input" value={fileType.filenamePattern} placeholder=".txt, .json" onChange={(event) => update({ filenamePattern: event.target.value })} /></label><label className="creator-inline-toggle"><input type="checkbox" checked={fileType.pairedRequired} onChange={(event) => update({ pairedRequired: event.target.checked })} />Same basename required</label></div>}<div className="creator-card-grid two"><FileSelector label="Sample File" value="" mode="file" onChange={() => undefined} dryRun={(label) => dryRun(label, "modTypes")} /><FileSelector label="Sample Archive" value="" mode="archive" onChange={() => undefined} dryRun={(label) => dryRun(label, "modTypes")} /></div><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => dryRun("Test Match", "modTypes")}>Test Match</button></div></div>;
}

function ToggleFields({ disableValue, enableValue, destination, draft, mode, onDisable, onEnable, onDestination }: { disableValue: string; enableValue: string; destination: string; draft: Draft; mode: Mode; onDisable: (value: string) => void; onEnable: (value: string) => void; onDestination: (value: string) => void }) {
  const disableMethods = ["Move tracked files", "Rename extension", "Add suffix", "Toggle INI", "Toggle JSON", "Toggle manifest", "Move whole folder", "Unsupported"];
  const enableMethods = ["Restore tracked files", "Restore extension", "Remove suffix", "Toggle INI", "Toggle JSON", "Restore manifest entry"];
  return <div className="creator-form-stack creator-toggle-fields"><FormGrid columns="two" className="creator-enable-disable-grid"><FormField label="Disable Method" size="wide"><select className="setting-input" value={disableValue} onChange={(event) => onDisable(event.target.value)}>{disableMethods.map((method) => <option key={method}>{method}</option>)}</select></FormField><FormField label="Enable Method" size="wide"><select className="setting-input" value={enableValue} onChange={(event) => onEnable(event.target.value)}>{enableMethods.map((method) => <option key={method}>{method}</option>)}</select></FormField></FormGrid><PathSelector label="Destination" value={destination} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={onDestination} dryRun={() => undefined} /></div>;
}
function InstallRuleSheet({ entry, index, draft, mode, setDraft, close, dryRun }: { entry: Item; index: number; draft: Draft; mode: Mode; setDraft: Dispatch<SetStateAction<Draft>>; close: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  function update(next: Item) { setDraft((current) => { const rows = [...current.sections.installBehavior]; rows[index] = next; return { ...current, sections: { ...current.sections, installBehavior: rows } }; }); }
  return <SheetFrame title={entry.title || "Install Rule"} subtitle="Structured condition and action builder" close={close}><div className="creator-form-stack"><label>Rule Name<input className="setting-input" value={entry.title} onChange={(event) => update({ ...entry, title: event.target.value })} /></label><RuleBuilder conditions={fieldValue(entry, "Conditions") || fieldValue(entry, "WHEN")} actions={fieldValue(entry, "Actions") || fieldValue(entry, "THEN")} destination={fieldValue(entry, "Destination")} onConditions={(value) => update(replaceField(entry, "Conditions", value))} onActions={(value) => update(replaceField(entry, "Actions", value))} onDestination={(value) => update(replaceField(entry, "Destination", value))} draft={draft} mode={mode} /><div className="creator-checkbox-stack">{["Track receipt ownership", "Preserve structure", "Overwrite with backup", "Ask before same-destination overwrite", "Require paired files", "Continue on optional-file failure"].map((option) => <label key={option}><input type="checkbox" checked={fieldValue(entry, option) === "Yes"} onChange={(event) => update(replaceField(entry, option, event.target.checked ? "Yes" : "No"))} />{option}</label>)}</div><button className="creator-button secondary" type="button" onClick={() => dryRun("Dry Run with Sample Archive", "installBehavior")}>Dry Run with Sample Archive</button></div></SheetFrame>;
}

function ToggleStrategySheet({ entry, index, draft, mode, setDraft, close, dryRun }: { entry: Item; index: number; draft: Draft; mode: Mode; setDraft: Dispatch<SetStateAction<Draft>>; close: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  function update(next: Item) { setDraft((current) => { const rows = [...current.sections.enableDisable]; rows[index] = next; return { ...current, sections: { ...current.sections, enableDisable: rows } }; }); }
  return <SheetFrame title={entry.title || "Toggle Strategy"} subtitle="Enable and disable are configured separately" close={close}><div className="creator-form-stack"><label>Strategy Name<input className="setting-input" value={entry.title} onChange={(event) => update({ ...entry, title: event.target.value })} /></label><label>Mod Type<select className="setting-input" value={fieldValue(entry, "Mod Type")} onChange={(event) => update(replaceField(entry, "Mod Type", event.target.value))}><option value="">Choose mod type...</option>{draft.sections.modTypes.map((modType) => <option key={modType.id}>{modType.title}</option>)}{draft.customFileTypes.map((modType) => <option key={modType.id}>{modType.name || "Custom Mod Type"}</option>)}</select></label><ToggleFields disableValue={fieldValue(entry, "Disable Method")} enableValue={fieldValue(entry, "Enable Method")} destination={fieldValue(entry, "Destination")} draft={draft} mode={mode} onDisable={(value) => update(replaceField(entry, "Disable Method", value))} onEnable={(value) => update(replaceField(entry, "Enable Method", value))} onDestination={(value) => update(replaceField(entry, "Destination", value))} /><button className="creator-button secondary" type="button" onClick={() => dryRun("Test Toggle Strategy", "enableDisable")}>Test Toggle Strategy</button></div></SheetFrame>;
}

function DependencySheet({ entry, index, draft, mode, setDraft, close, dryRun }: { entry: Item; index: number; draft: Draft; mode: Mode; setDraft: Dispatch<SetStateAction<Draft>>; close: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  const steps = ["Identity", "Detection", "Installation", "Versions", "Updates", "Repair", "Uninstall", "Used By", "Test"];
  const [step, setStep] = useState(0);
  const dependencyTypes = ["UE4SS", "REFramework", "BepInEx", "MelonLoader", "DLL Proxy", "Script Hook", "Loader / Framework", "Custom Dependency"];
  function update(next: Item) { setDraft((current) => { const rows = [...current.sections.dependencies]; rows[index] = next; return { ...current, sections: { ...current.sections, dependencies: rows } }; }); }
  return <SheetFrame title={entry.title || "Dependency"} subtitle="Dependency editor" step={step} steps={steps} setStep={setStep} close={close}>{step === 0 && <div className="creator-form-stack"><OptionCards value={fieldValue(entry, "Dependency Type")} options={dependencyTypes.map((type) => ({ value: type, label: type }))} onChange={(value) => update(replaceField({ ...entry, title: value }, "Dependency Type", value))} /><label>Name<input className="setting-input" value={entry.title} onChange={(event) => update({ ...entry, title: event.target.value })} /></label><label>Description<textarea className="setting-input" value={entry.summary} onChange={(event) => update({ ...entry, summary: event.target.value })} /></label><label>Required<select className="setting-input" value={fieldValue(entry, "Required")} onChange={(event) => update(replaceField(entry, "Required", event.target.value))}><option>Optional</option><option>Required</option></select></label></div>}{step === 1 && <div className="creator-form-stack"><FileSelector label="Marker File" value={fieldValue(entry, "Marker File")} mode="markerFile" onChange={(value) => update(replaceField(entry, "Marker File", value))} dryRun={(label) => dryRun(label, "dependencies")} /><PathSelector label="Marker Folder" value={fieldValue(entry, "Marker Folder")} mode={mode} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => update(replaceField(entry, "Marker Folder", value))} dryRun={(label) => dryRun(label, "dependencies")} /><ConditionActionList title="Detection Rules" values={listField(entry, "Detection Rules")} options={["Marker file exists", "Marker folder exists", "Expected filename", "Version pattern", "AND group", "OR group"]} onChange={(values) => update(replaceListField(entry, "Detection Rules", values))} addLabel="Add Condition" /></div>}{step === 2 && <div className="creator-form-stack"><FileSelector label="Local Installer or Archive" value={fieldValue(entry, "Installer or archive")} mode="archive" onChange={(value) => update(replaceField(entry, "Installer or archive", value))} dryRun={(label) => dryRun(label, "dependencies")} /><PathSelector label="Install Destination" value={fieldValue(entry, "Destination")} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => update(replaceField(entry, "Destination", value))} dryRun={(label) => dryRun(label, "dependencies")} /><FieldEditor entry={entry} fields={["Approved Remote Source", "Archive Extraction Rules", "Component Selection", "Hash Verification"]} update={update} /></div>}{step === 3 && <FieldEditor entry={entry} fields={["Version file", "Version pattern", "Minimum Version", "Maximum Version", "Blocked Versions", "Game Version Compatibility"]} update={update} />}{step === 4 && <FieldEditor entry={entry} fields={["Update Source", "Compare Version", "Compare Hash", "Preserve Config"]} update={update} />}{step === 5 && <FieldEditor entry={entry} fields={["Required Files", "Repair Action", "Redownload Behavior"]} update={update} />}{step === 6 && <FieldEditor entry={entry} fields={["Uninstall Policy", "Remove tracked files", "Restore backups"]} update={update} />}{step === 7 && <label>Used By<select multiple className="setting-input" value={fieldValue(entry, "Used By").split("|").filter(Boolean)} onChange={(event) => update(replaceField(entry, "Used By", Array.from(event.currentTarget.selectedOptions).map((option) => option.value).join("|")))}>{draft.sections.modTypes.map((modType) => <option key={modType.id}>{modType.title}</option>)}{draft.customFileTypes.map((modType) => <option key={modType.id}>{modType.name || "Custom Mod Type"}</option>)}</select></label>}{step === 8 && <div className="creator-test-grid">{["Test Detection", "Dry-Run Install", "Dry-Run Repair", "Dry-Run Uninstall"].map((label) => <button className="creator-button secondary" type="button" key={label} onClick={() => dryRun(label, "dependencies")}>{label}</button>)}</div>}</SheetFrame>;
}

function SourceTextField({ entry, label, onChange, placeholder = "" }: { entry: Item; label: string; onChange: (entry: Item) => void; placeholder?: string }) {
  return <label>{label}<TransferTextInput value={fieldValue(entry, label)} placeholder={placeholder} onChange={(value) => onChange(replaceField(entry, label, value))} /></label>;
}

function SourceSelectField({ entry, label, values, onChange }: { entry: Item; label: string; values: string[]; onChange: (entry: Item) => void }) {
  return <label>{label}<select className="setting-input" value={fieldValue(entry, label)} onChange={(event) => onChange(replaceField(entry, label, event.target.value))}>{values.map((value) => <option key={value}>{value}</option>)}</select></label>;
}

function SourceBooleanField({ entry, label, onChange }: { entry: Item; label: string; onChange: (entry: Item) => void }) {
  const checked = fieldValue(entry, label) === "Yes";
  return <label className="creator-inline-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(replaceField(entry, label, event.target.checked ? "Yes" : "No"))} />{label}</label>;
}

function SourceCapabilityToggles({ entry, onChange }: { entry: Item; onChange: (entry: Item) => void }) {
  const selected = new Set(listField(entry, "Capabilities"));
  return <section className="creator-builder-section"><header><div><h3>Capabilities</h3><p>Recommended defaults are selected when a source is created. Edit them here before saving.</p></div></header><div className="creator-checkbox-stack source-capability-grid">{sourceCapabilities.map((capability) => <label key={capability}><input type="checkbox" checked={selected.has(capability)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(capability); else next.delete(capability); onChange(normalizeSourceItem(replaceField(entry, "Capabilities", Array.from(next).join("|")))); }} />{capability}</label>)}</div></section>;
}

function SourceTypeFields({ entry, mode, onChange }: { entry: Item; mode: Mode; onChange: (entry: Item) => void }) {
  const sourceType = sourceTypeFromItem(entry);
  const queryLabel = sourceType === "nexus" ? "Search Nexus Games" : "Search ModWorkshop Games";
  function updateField(label: string, value: string) {
    onChange(normalizeSourceItem(replaceField(entry, label, value)));
  }
  function updateNexusUrl(label: string, value: string) {
    let next = replaceField(entry, label, value);
    const parsed = parseNexusGameUrl(value);
    if (parsed) {
      next = replaceField(next, "Nexus Domain", parsed.domain);
      next = replaceField(next, parsed.isCategoryUrl ? "Nexus Category URL" : "Nexus Game Page URL", parsed.normalizedUrl);
      if (!sourceValue(next, "Embedded Start URL")) next = replaceField(next, "Embedded Start URL", parsed.normalizedUrl);
    }
    onChange(normalizeSourceItem(next));
  }
  function updateModWorkshopUrl(label: string, value: string) {
    let next = replaceField(entry, label, value);
    const parsed = parseModWorkshopGameUrl(value);
    if (parsed) {
      if (parsed.slug) next = replaceField(next, "ModWorkshop Slug", parsed.slug);
      if (parsed.numericId) next = replaceField(next, "ModWorkshop Game ID", parsed.numericId);
      next = replaceField(next, parsed.isCategoryUrl ? "ModWorkshop Category URL" : "ModWorkshop Game Page URL", parsed.normalizedUrl);
      if (!sourceValue(next, "Embedded Start URL")) next = replaceField(next, "Embedded Start URL", parsed.normalizedUrl);
    }
    onChange(normalizeSourceItem(next));
  }
  function applyManualGameMapping() {
    const query = fieldValue(entry, queryLabel).trim();
    if (!query) return;
    let next = replaceField(entry, "Human Game Name", query);
    if (sourceType === "nexus") {
      const parsed = parseNexusGameUrl(query);
      if (parsed) {
        next = replaceField(next, "Nexus Domain", parsed.domain);
        next = replaceField(next, parsed.isCategoryUrl ? "Nexus Category URL" : "Nexus Game Page URL", parsed.normalizedUrl);
        next = replaceField(next, "Embedded Start URL", parsed.normalizedUrl);
      }
    }
    if (sourceType === "modworkshop") {
      const parsed = parseModWorkshopGameUrl(query);
      if (parsed) {
        if (parsed.slug) next = replaceField(next, "ModWorkshop Slug", parsed.slug);
        if (parsed.numericId) next = replaceField(next, "ModWorkshop Game ID", parsed.numericId);
        next = replaceField(next, parsed.isCategoryUrl ? "ModWorkshop Category URL" : "ModWorkshop Game Page URL", parsed.normalizedUrl);
        next = replaceField(next, "Embedded Start URL", parsed.normalizedUrl);
      }
    }
    onChange(normalizeSourceItem(next));
  }

  if (sourceType === "nexus") return <div className="creator-form-stack source-structured-editor"><section className="creator-builder-section"><header><div><h3>General</h3><p>Name this source without changing its technical game mapping.</p></div></header><FormGrid columns="two"><FormField label="Display Name" size="wide"><TransferTextInput value={sourceValue(entry, "Display Name")} onChange={(value) => updateField("Display Name", value)} /></FormField><FormField label="Browse Mode" size="wide"><select className="setting-input" value={sourceValue(entry, "Browse Mode") || "Built-in/API"} onChange={(event) => updateField("Browse Mode", event.target.value)}><option>Built-in/API</option><option>Embedded</option><option>External</option></select></FormField></FormGrid></section><section className="creator-builder-section"><header><div><h3>Game Identity</h3><p>Human names can contain spaces. Nexus domains and IDs stay separate.</p></div></header><FormGrid columns="two"><FormField label="Search Nexus Games" size="wide"><TransferTextInput value={sourceValue(entry, "Search Nexus Games")} placeholder="Example: Ready or Not" onChange={(value) => updateField("Search Nexus Games", value)} /></FormField><FormField label="Human Game Name" size="wide"><TransferTextInput value={sourceValue(entry, "Human Game Name")} placeholder="Ready or Not" onChange={(value) => updateField("Human Game Name", value)} /></FormField><FormField label="Nexus Domain" help="Example: readyornot. Do not put the game title here." size="wide"><TransferTextInput value={sourceValue(entry, "Nexus Domain")} placeholder="readyornot" onChange={(value) => updateField("Nexus Domain", normalizeNexusDomainInput(value).domain || value)} /></FormField><FormField label="Nexus Game ID" help="Optional numeric Nexus game ID." size="wide"><TransferTextInput value={sourceValue(entry, "Nexus Game ID")} placeholder="Optional numeric ID" onChange={(value) => updateField("Nexus Game ID", value)} /></FormField></FormGrid><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={applyManualGameMapping}>Use Search Text</button></div></section><section className="creator-builder-section"><header><div><h3>Browsing</h3><p>Full Nexus game or category URLs are accepted with paths, queries, and trailing slashes.</p></div></header><FormGrid columns="two"><FormField label="Nexus Game Page URL" size="wide"><TransferTextInput value={sourceValue(entry, "Nexus Game Page URL")} placeholder="https://www.nexusmods.com/readyornot" onChange={(value) => updateNexusUrl("Nexus Game Page URL", value)} /></FormField><FormField label="Nexus Category URL" size="wide"><TransferTextInput value={sourceValue(entry, "Nexus Category URL")} placeholder="https://www.nexusmods.com/readyornot/mods/categories/..." onChange={(value) => updateNexusUrl("Nexus Category URL", value)} /></FormField><FormField label="Embedded Start URL" size="wide"><TransferTextInput value={sourceValue(entry, "Embedded Start URL")} placeholder="https://www.nexusmods.com/readyornot/mods" onChange={(value) => updateNexusUrl("Embedded Start URL", value)} /></FormField><FormField label="Allowed Domains" size="wide"><TransferTextInput value={sourceValue(entry, "Allowed Domains")} onChange={(value) => updateField("Allowed Domains", value)} /></FormField></FormGrid></section>{mode === "advanced" && <section className="creator-builder-section"><header><div><h3>Advanced</h3><p>Credentials are global; profile fields only describe the source mapping.</p></div></header><FormGrid columns="two"><FormField label="Update Checking" size="wide"><select className="setting-input" value={sourceValue(entry, "Update Checking") || "Enabled"} onChange={(event) => updateField("Update Checking", event.target.value)}><option>Enabled</option><option>Disabled</option></select></FormField><FormField label="Authentication/API Status" size="wide"><TransferTextInput value={sourceValue(entry, "Authentication/API Status")} onChange={(value) => updateField("Authentication/API Status", value)} /></FormField></FormGrid></section>}</div>;
  if (sourceType === "modworkshop") return <div className="creator-form-stack source-structured-editor"><section className="creator-builder-section"><header><div><h3>General</h3><p>Name this source without changing its technical game mapping.</p></div></header><FormGrid columns="two"><FormField label="Display Name" size="wide"><TransferTextInput value={sourceValue(entry, "Display Name")} onChange={(value) => updateField("Display Name", value)} /></FormField><FormField label="Browse Mode" size="wide"><select className="setting-input" value={sourceValue(entry, "Browse Mode") || "Built-in/API"} onChange={(event) => updateField("Browse Mode", event.target.value)}><option>Built-in/API</option><option>Embedded</option><option>External</option></select></FormField></FormGrid></section><section className="creator-builder-section"><header><div><h3>Game Identity</h3><p>Human names can contain spaces. ModWorkshop slugs and numeric IDs stay separate.</p></div></header><FormGrid columns="two"><FormField label="Search ModWorkshop Games" size="wide"><TransferTextInput value={sourceValue(entry, "Search ModWorkshop Games")} placeholder="Example: The Outlast Trials" onChange={(value) => updateField("Search ModWorkshop Games", value)} /></FormField><FormField label="Human Game Name" size="wide"><TransferTextInput value={sourceValue(entry, "Human Game Name")} placeholder="The Outlast Trials" onChange={(value) => updateField("Human Game Name", value)} /></FormField><FormField label="ModWorkshop Slug" help="Example: payday-2. Do not put the game title here." size="wide"><TransferTextInput value={sourceValue(entry, "ModWorkshop Slug")} placeholder="payday-2" onChange={(value) => updateField("ModWorkshop Slug", value)} /></FormField><FormField label="ModWorkshop Game ID" help="Optional numeric ModWorkshop game ID." size="wide"><TransferTextInput value={sourceValue(entry, "ModWorkshop Game ID")} placeholder="Optional numeric ID" onChange={(value) => updateField("ModWorkshop Game ID", value)} /></FormField></FormGrid><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={applyManualGameMapping}>Use Search Text</button></div></section><section className="creator-builder-section"><header><div><h3>Browsing</h3><p>Full ModWorkshop game or category URLs are accepted with paths, queries, and trailing slashes.</p></div></header><FormGrid columns="two"><FormField label="ModWorkshop Game Page URL" size="wide"><TransferTextInput value={sourceValue(entry, "ModWorkshop Game Page URL")} placeholder="https://modworkshop.net/g/payday-2/mods" onChange={(value) => updateModWorkshopUrl("ModWorkshop Game Page URL", value)} /></FormField><FormField label="ModWorkshop Category URL" size="wide"><TransferTextInput value={sourceValue(entry, "ModWorkshop Category URL")} placeholder="https://modworkshop.net/g/payday-2/mods?category_id=..." onChange={(value) => updateModWorkshopUrl("ModWorkshop Category URL", value)} /></FormField><FormField label="Embedded Start URL" size="wide"><TransferTextInput value={sourceValue(entry, "Embedded Start URL")} placeholder="https://modworkshop.net/g/payday-2/mods" onChange={(value) => updateModWorkshopUrl("Embedded Start URL", value)} /></FormField><FormField label="Allowed Domains" size="wide"><TransferTextInput value={sourceValue(entry, "Allowed Domains")} onChange={(value) => updateField("Allowed Domains", value)} /></FormField></FormGrid></section>{mode === "advanced" && <section className="creator-builder-section"><header><div><h3>Advanced</h3><p>ModWorkshop is public by default; optional API configuration lives in Settings.</p></div></header><FieldEditor entry={entry} fields={["Source Instance ID", "Source Type", "Capabilities", "Last Test Status", "Last Tested", "Last Test Message", "Last Test URL", "Last Test HTTP Status", "Last Test Details"]} update={(next) => onChange(normalizeSourceItem(next))} /></section>}</div>;
  if (sourceType === "embedded") return <section className="creator-builder-section"><header><div><h3>Embedded Website</h3></div></header><SourceTextField entry={entry} label="Starting Page URL" onChange={onChange} /><SourceTextField entry={entry} label="Allowed Domains" onChange={onChange} /><SourceTextField entry={entry} label="Current-Game URL Patterns" onChange={onChange} /><SourceSelectField entry={entry} label="Download Capture" values={["Prompt before download", "Capture matching downloads", "Disabled"]} onChange={onChange} /><SourceSelectField entry={entry} label="Cross-Game Protection" values={["Enabled", "Disabled"]} onChange={onChange} /><SourceSelectField entry={entry} label="Login Required" values={["No", "Optional", "Required"]} onChange={onChange} /></section>;
  if (sourceType === "github") return <section className="creator-builder-section"><header><div><h3>GitHub Releases</h3><p>Public repositories use GitHub Public API without a token. Source-code archives stay ignored by default.</p></div></header><SourceTextField entry={entry} label="Repository URL" onChange={onChange} placeholder="https://github.com/owner/repository/releases" /><SourceTextField entry={entry} label="Repository Owner" onChange={onChange} /><SourceTextField entry={entry} label="Repository Name" onChange={onChange} /><SourceSelectField entry={entry} label="Release Channel" values={["Latest stable", "Latest prerelease", "Specific tag", "Custom tag pattern"]} onChange={onChange} /><SourceTextField entry={entry} label="Fixed Tag" onChange={onChange} /><SourceTextField entry={entry} label="Custom Tag Pattern" onChange={onChange} /><SourceSelectField entry={entry} label="Asset Selection" values={["First matching release archive", "Filename contains dependency name", "Custom filename pattern", "Ask when multiple assets match"]} onChange={onChange} /><SourceTextField entry={entry} label="Include Asset Patterns" onChange={onChange} placeholder="*.zip|*.7z|*.dll" /><SourceTextField entry={entry} label="Exclude Asset Patterns" onChange={onChange} /><SourceTextField entry={entry} label="Accepted Extensions" onChange={onChange} /><SourceSelectField entry={entry} label="Version Parsing" values={["Release tag", "Asset filename", "Manifest field"]} onChange={onChange} /><SourceSelectField entry={entry} label="Update Checking" values={["Enabled", "Disabled"]} onChange={onChange} /></section>;
  if (sourceType === "local") return <section className="creator-builder-section"><header><div><h3>Local Files</h3></div></header><div className="creator-checkbox-stack source-capability-grid"><SourceBooleanField entry={entry} label="Allow Drag and Drop" onChange={onChange} /><SourceBooleanField entry={entry} label="Allow File Picker" onChange={onChange} /><SourceBooleanField entry={entry} label="Allow Folder Picker" onChange={onChange} /></div><SourceTextField entry={entry} label="Accepted Extensions" onChange={onChange} /><SourceSelectField entry={entry} label="Unmatched File Behavior" values={["Show install preview", "Ask user", "Reject with explanation", "Keep as unmatched local mod"]} onChange={onChange} /></section>;
  if (sourceType === "direct_catalog") return <section className="creator-builder-section"><header><div><h3>Direct Catalog</h3></div></header><SourceTextField entry={entry} label="Catalog URL" onChange={onChange} /><SourceTextField entry={entry} label="Schema Version Field" onChange={onChange} /><SourceTextField entry={entry} label="Mod Name Field" onChange={onChange} /><SourceTextField entry={entry} label="Download URL Field" onChange={onChange} /><SourceTextField entry={entry} label="Version Field" onChange={onChange} /><SourceTextField entry={entry} label="Checksum Field" onChange={onChange} /></section>;
  return <section className="creator-builder-section"><header><div><h3>Custom Browser Source</h3></div></header><SourceTextField entry={entry} label="Allowed Domains" onChange={onChange} /><SourceTextField entry={entry} label="Start URL" onChange={onChange} /><SourceTextField entry={entry} label="Download Capture Rules" onChange={onChange} /><SourceTextField entry={entry} label="Game-Page Validation" onChange={onChange} /><SourceSelectField entry={entry} label="Authentication Requirement" values={["Optional", "Required", "None"]} onChange={onChange} /></section>;
}

function sourceConnectionSummary(entry: Item) {
  const sourceType = sourceTypeFromItem(entry);
  if (sourceType === "nexus") return { title: "Nexus Mods", status: sourceValue(entry, "Authentication/API Status") || "Uses global account", detail: "Nexus credentials are configured in Settings > Accounts & Connections, not inside this profile." };
  if (sourceType === "modworkshop") return { title: "ModWorkshop", status: "Public API", detail: "ModWorkshop browsing uses the public API and does not require profile credentials." };
  if (sourceType === "github") return { title: "GitHub", status: "Public API by default", detail: "Public releases work without a token. Optional GitHub account settings belong in Settings > Accounts & Connections." };
  if (sourceType === "local") return { title: "Local Files", status: "No account required", detail: "Local file, folder, paste, and drag/drop installs do not use source credentials." };
  return { title: sourceTypeLabel(sourceType), status: "Profile mapping only", detail: "Any personal credentials should be configured globally in Settings, not saved on this source row." };
}
function SourceEditorSheet({ editor, mode, sources, onChange, onSave, onCancel, onTest, onEditExisting }: { editor: SourceEditorState; mode: Mode; sources: Item[]; onChange: (entry: Item) => void; onSave: (addAnyway?: boolean) => void; onCancel: () => void; onTest: (entry: Item) => Promise<Item>; onEditExisting: (entry: Item) => void }) {
  const [testing, setTesting] = useState(false);
  const [sourceStep, setSourceStep] = useState(0);
  const [normalizationMessage, setNormalizationMessage] = useState("");
  const entry = normalizeSourceItem(editor.draft);
  const sourceType = sourceTypeFromItem(entry);
  const errors = sourceValidationErrors(entry);
  const duplicate = editor.duplicateOf ?? findDuplicateSource(entry, sources, editor.mode === "edit" ? sourceInstanceId(entry) : undefined);
  const title = editor.mode === "add" ? "Add Source" : `Edit ${entry.title || sourceTypeLabel(sourceType)}`;
  const lastTestMessage = sourceValue(entry, "Last Test Message");
  const lastTestDetails = sourceValue(entry, "Last Test Details");
  const sourceSteps = ["Type", "Game Mapping", "Capabilities", "Connection", "Test"];
  const step = Math.min(sourceStep, sourceSteps.length - 1);
  function setType(value: string) {
    const nextType = canonicalSourceType(value);
    const instanceId = sourceInstanceId(entry).startsWith("source.") ? sourceInstanceId(entry) : `source.${makeUserId()}`;
    setSourceStep(0);
    setNormalizationMessage("");
    onChange(normalizeSourceItem({ ...entry, id: instanceId, title: sourceTypeLabel(nextType), summary: "Not configured.", fields: sourceFieldsForType(nextType, instanceId), chips: sourceDefaultCapabilities[nextType], enabled: entry.enabled !== false }, nextType));
  }
  function updateDisplayName(value: string) {
    onChange(normalizeSourceItem(replaceField({ ...entry, title: value || sourceTypeLabel(sourceType) }, "Display Name", value)));
  }
  function updateField(label: string, value: string) {
    onChange(normalizeSourceItem(replaceField(entry, label, value)));
  }
  function updateGithubRepositoryUrl(value: string) {
    let next = replaceField(entry, "Repository URL", value);
    const parsed = parseGitHubSourceUrl(value);
    if (parsed) {
      next = replaceField(next, "Repository Owner", parsed.owner);
      next = replaceField(next, "Repository Name", parsed.repository);
      if (parsed.fixedTag) next = replaceField(replaceField(next, "Fixed Tag", parsed.fixedTag), "Release Channel", "Specific tag");
      setNormalizationMessage(parsed.fixedTag ? `Parsed GitHub release ${parsed.owner}/${parsed.repository}@${parsed.fixedTag}` : `Parsed GitHub repository ${parsed.owner}/${parsed.repository}`);
    } else {
      setNormalizationMessage("");
    }
    onChange(normalizeSourceItem(next));
  }

  async function testDraft() {
    setTesting(true);
    try {
      onChange(await onTest(entry));
    } finally {
      setTesting(false);
    }
  }
  function renderGuidedMapping() {
    if (sourceType === "nexus" || sourceType === "modworkshop") return <div className="creator-form-stack"><SourceTypeFields entry={entry} mode="guided" onChange={(next) => onChange(normalizeSourceItem(next))} /><div className="creator-action-row"><button className="creator-button primary" type="button" disabled={testing} onClick={() => void testDraft()}>{testing ? "Testing..." : "Test Configuration"}</button></div></div>;
    if (sourceType === "github") return <section className="creator-builder-section"><header><div><h3>GitHub Releases</h3><p>Public repositories use GitHub Public API without a token. Release assets are inspected only; tests never download files.</p></div></header><FormField label="Repository URL" help={normalizationMessage || "Accepts repository, releases, latest release, or release tag URLs."} size="wide"><TransferTextInput value={sourceValue(entry, "Repository URL")} placeholder="https://github.com/owner/repository/releases" onChange={updateGithubRepositoryUrl} /></FormField><FormGrid columns="two"><FormField label="Owner" size="wide"><TransferTextInput value={sourceValue(entry, "Repository Owner")} onChange={(value) => updateField("Repository Owner", value)} /></FormField><FormField label="Repository" size="wide"><TransferTextInput value={sourceValue(entry, "Repository Name")} onChange={(value) => updateField("Repository Name", value)} /></FormField><FormField label="Release channel" size="wide"><select className="setting-input" value={sourceValue(entry, "Release Channel") || "Latest stable"} onChange={(event) => updateField("Release Channel", event.target.value)}><option>Latest stable</option><option>Latest prerelease</option><option>Specific tag</option><option>Custom tag pattern</option></select></FormField><FormField label="Fixed tag" size="wide"><TransferTextInput value={sourceValue(entry, "Fixed Tag")} placeholder="v1.4.2" onChange={(value) => updateField("Fixed Tag", value)} /></FormField><FormField label="Asset selection" size="wide"><select className="setting-input" value={sourceValue(entry, "Asset Selection") || "First matching release archive"} onChange={(event) => updateField("Asset Selection", event.target.value)}><option>First matching release archive</option><option>Filename contains dependency name</option><option>Custom filename pattern</option><option>Ask when multiple assets match</option></select></FormField><FormField label="Accepted extensions" size="wide"><TransferTextInput value={sourceValue(entry, "Accepted Extensions")} placeholder=".zip|.7z|.rar|.dll" onChange={(value) => updateField("Accepted Extensions", value)} /></FormField><FormField label="Include asset patterns" size="wide"><TransferTextInput value={sourceValue(entry, "Include Asset Patterns")} placeholder="*.zip|*.7z|*.dll" onChange={(value) => updateField("Include Asset Patterns", value)} /></FormField><FormField label="Exclude asset patterns" help="Source-code archives are ignored by default." size="wide"><TransferTextInput value={sourceValue(entry, "Exclude Asset Patterns")} onChange={(value) => updateField("Exclude Asset Patterns", value)} /></FormField></FormGrid><div className="creator-guided-summary"><span>Connection</span><strong>GitHub Public API</strong><span>Login</span><strong>No login required for public repositories</strong><span>Default safety</span><strong>Source-code archives ignored</strong></div><div className="creator-action-row"><button className="creator-button primary" type="button" disabled={testing} onClick={() => void testDraft()}>{testing ? "Testing..." : "Test Configuration"}</button></div></section>;
    return <section className="creator-builder-section"><header><div><h3>{sourceTypeLabel(sourceType)} Mapping</h3><p>Configure the public game mapping for this source.</p></div></header><SourceTypeFields entry={entry} mode="guided" onChange={(next) => onChange(normalizeSourceItem(next))} /></section>;
  }
  function renderGuidedAuthentication() {
    const connection = sourceConnectionSummary(entry);
    return <section className="creator-builder-section"><header><div><h3>Connection</h3><p>Profiles store source mapping only. Personal credentials live in Settings.</p></div></header><div className="creator-guided-summary"><span>Source</span><strong>{connection.title}</strong><span>Connection</span><strong>{connection.status}</strong><span>Where to change it</span><strong>Settings / Accounts & Connections</strong></div><p className="creator-safety-note">{connection.detail}</p><button className="creator-button secondary" type="button" onClick={() => setNormalizationMessage("Open Settings / Accounts & Connections to edit source accounts.")}>Open Account Settings</button></section>;
  }
  function renderGuidedBody() {
    if (step === 0) return <div className="creator-form-stack"><OptionCards value={sourceType} options={sourceTypeOptions} onChange={setType} /><section className="creator-builder-section"><header><div><h3>Source Name</h3></div></header><FormField label="Display name" size="wide"><input className="setting-input" value={sourceValue(entry, "Display Name")} onChange={(event) => updateDisplayName(event.target.value)} /></FormField></section></div>;
    if (step === 1) return renderGuidedMapping();
    if (step === 2) return <SourceCapabilityToggles entry={entry} onChange={onChange} />;
    if (step === 3) return renderGuidedAuthentication();
    return <div className="creator-form-stack"><ValidationCard issues={errors.map((text) => ({ level: "error" as IssueLevel, text }))} empty="Source configuration is ready to test." /><div className="creator-guided-summary"><span>Source</span><strong>{entry.title}</strong><span>Game</span><strong>{sourceMappingSummary(entry)}</strong><span>Status</span><strong>{sourceStatus(entry)}</strong>{lastTestMessage && <><span>Last test</span><strong>{lastTestMessage}</strong></>}</div>{lastTestDetails && <details className="creator-rule-preview"><summary>View Details</summary><pre>{lastTestDetails}</pre></details>}{normalizationMessage && <p className="creator-safety-note success-text">{normalizationMessage}</p>}</div>;
  }
  function renderAdvancedBody() {
    return <div className="creator-form-stack creator-advanced-technical"><section className="creator-builder-section"><header><div><h3>Raw Source Mapping</h3><p>Technical identifiers and stored source fields.</p></div></header><div className="creator-rule-preview"><span>Source instance ID</span><strong>{sourceInstanceId(entry)}</strong><span>Source type</span><strong>{sourceType}</strong><span>Status</span><strong>{sourceStatus(entry)}</strong></div><FieldEditor entry={entry} fields={editorFieldNames(entry)} update={(next) => onChange(normalizeSourceItem(next))} /></section><section className="creator-builder-section"><header><div><h3>Source JSON</h3><p>Generated configuration preview.</p></div></header><textarea className="setting-input creator-code-box" readOnly value={JSON.stringify(entry, null, 2)} /></section>{errors.length > 0 && <ValidationCard issues={errors.map((text) => ({ level: "error" as IssueLevel, text }))} empty="Source is valid." />}</div>;
  }
  return <div className="creator-drawer-backdrop" role="presentation"><aside className={mode === "advanced" ? "creator-editor-sheet source-editor-sheet technical-editor-sheet" : "creator-editor-sheet source-editor-sheet"} role="dialog" aria-modal="true" aria-label={title}><header className="creator-editor-header"><div><h2>{title}</h2><p>{mode === "advanced" ? `Advanced source mapping for ${sourceInstanceId(entry)}` : editor.mode === "add" ? "Guided source setup. Nothing is added until Save Source." : "Guided source setup."}</p></div><button className="creator-button ghost" type="button" onClick={onCancel}>Close</button></header><div className="creator-editor-content">{mode === "guided" && <div className="creator-step-tabs" role="tablist">{sourceSteps.map((label, index) => <button className={index === step ? "active" : ""} type="button" key={label} onClick={() => setSourceStep(index)}>{index + 1}. {label}</button>)}</div>}{mode === "guided" ? renderGuidedBody() : renderAdvancedBody()}{editor.message && <p className="creator-safety-note error-text">{editor.message}</p>}{duplicate && <article className="creator-empty-state source-duplicate-warning"><strong>A similar source is already configured.</strong><p>{duplicate.title}: {sourceMappingSummary(duplicate)}</p><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => onEditExisting(duplicate)}>Edit Existing</button><button className="creator-button secondary" type="button" onClick={() => onSave(true)}>Add Anyway</button><button className="creator-button ghost" type="button" onClick={onCancel}>Cancel</button></div></article>}</div><footer className="creator-editor-footer"><div className="creator-editor-footer-left"><button className="creator-button primary" type="button" disabled={testing} onClick={() => void testDraft()}>{testing ? "Testing..." : "Test Configuration"}</button></div><div className="creator-editor-footer-right"><button className="creator-button ghost" type="button" onClick={onCancel}>Cancel</button><button className="creator-button primary" type="button" disabled={errors.length > 0 || Boolean(duplicate)} onClick={() => onSave(false)}>Save Source</button></div></footer></aside></div>;
}
function itemEditorTitle(editor: ItemEditorState) {
  const label = sectionInfo.find((entry) => entry.id === editor.section)?.label ?? nice(editor.section);
  return `${editor.mode === "add" ? "Add" : "Edit"} ${label}`;
}

function editorFieldNames(entry: Item, extras: string[] = []) {
  return Array.from(new Set([...entry.fields.map((field) => field.label), ...extras]));
}

function recipeLabel(recipeId: DisableRecipeId) {
  return disableRecipeOptions.find((option) => option.value === recipeId)?.label ?? "Custom Behavior";
}

function inferDisableRecipeId(value: string): DisableRecipeId {
  const lower = value.trim().toLowerCase();
  const exact = disableRecipeOptions.find((option) => option.value === value || option.label.toLowerCase() === lower)?.value as DisableRecipeId | undefined;
  if (exact) return exact;
  if (lower.includes("move") && lower.includes("suffix")) return "move_and_suffix";
  if (lower.includes("whole") || lower.includes("folder")) return "move_folder";
  if (lower.includes("suffix") || lower.includes("disabled")) return "suffix_files";
  if (lower.includes("rename")) return "rename_main_file";
  if (lower.includes("config") || lower.includes("ini") || lower.includes("json") || lower.includes("manifest")) return "config_value";
  if (lower.includes("loader")) return "loader_controlled";
  if (lower.includes("unsupported")) return "unsupported";
  if (lower.includes("custom")) return "custom";
  return "move_files";
}

function generatedEnableBehavior(recipeId: DisableRecipeId) {
  const mapping = "uses the stored receipt mapping for originalPath, disabledPath, originalFilename, disabledFilename, and receiptId";
  if (recipeId === "move_folder") return `Move the tracked folder back to its original path; ${mapping}.`;
  if (recipeId === "move_files") return `Move every tracked file back to its original path; ${mapping}.`;
  if (recipeId === "suffix_files") return `Remove the disabled suffix from every tracked file; ${mapping}.`;
  if (recipeId === "move_and_suffix") return `Move files back to their original paths and remove the disabled suffix; ${mapping}.`;
  if (recipeId === "rename_main_file") return `Restore the original main filename from the receipt; ${mapping}.`;
  if (recipeId === "config_value") return "Restore the previous config value recorded in the receipt.";
  if (recipeId === "loader_controlled") return "Ask the loader to enable the mod and record the resulting state.";
  if (recipeId === "unsupported") return "No enable action is generated because disabling is not supported.";
  return "Use the custom reversible enable behavior defined by the maintainer.";
}

function disableRecipeStrategyText(recipeId: DisableRecipeId) {
  if (recipeId === "move_and_suffix") return "Move files into disabled folder and add .disabled; enable is generated from receipt mappings.";
  return `${recipeLabel(recipeId)}; enable is generated from receipt mappings.`;
}

function defaultRecipeField(label: string) {
  const defaults: Record<string, string> = {
    "Disable Recipe": "move_files",
    "Disabled Folder Location": "profile_disabled_storage",
    "Disabled Folder Name": "disabled",
    "Rename Behavior": "after_filename",
    "Disable Custom Suffix": ".disabled",
    "Move Mode": "tracked_files",
    "Folder Suffix Target": "files",
    "Disable Conflict": "replace_same_receipt",
    "Create Disabled Folder": "Yes",
    "Preserve Disabled Structure": "Yes",
    "Track Disabled Mapping": "Yes",
    "Move Empty Parent Folders": "No",
    "Restore Exact Paths": "Yes",
    "Remove Disabled Folder When Empty": "Yes",
    "Receipt Mapping": "originalPath|disabledPath|originalFilename|disabledFilename|receiptId",
  };
  return defaults[label] ?? "";
}

function recipeEntryValue(entry: Item, label: string) {
  return fieldValue(entry, label) || defaultRecipeField(label);
}

function recipeEntryChecked(entry: Item, label: string) {
  return recipeEntryValue(entry, label) !== "No";
}

function replaceRecipeDefaults(entry: Item, recipeId: DisableRecipeId) {
  let next = replaceField(entry, "Disable Recipe", recipeId);
  next = replaceField(next, "Disable Method", recipeLabel(recipeId));
  next = replaceField(next, "Enable Method", generatedEnableBehavior(recipeId));
  next = replaceField(next, "Receipt Mapping", defaultRecipeField("Receipt Mapping"));
  for (const label of ["Disabled Folder Location", "Disabled Folder Name", "Rename Behavior", "Disable Custom Suffix", "Move Mode", "Folder Suffix Target", "Disable Conflict", "Create Disabled Folder", "Preserve Disabled Structure", "Track Disabled Mapping", "Move Empty Parent Folders", "Restore Exact Paths", "Remove Disabled Folder When Empty"]) {
    if (!fieldValue(next, label)) next = replaceField(next, label, defaultRecipeField(label));
  }
  return { ...next, title: next.title === "New Toggle Strategy" ? recipeLabel(recipeId) : next.title, summary: disableRecipeStrategyText(recipeId) };
}

function recipeFileTypePatch(recipeId: DisableRecipeId): Partial<CustomFileType> {
  return {
    disableRecipeId: recipeId,
    enableDisableStrategy: `${recipeLabel(recipeId)}. ${generatedEnableBehavior(recipeId)}`,
    disabledFolderLocation: "profile_disabled_storage",
    disabledFolderName: "disabled",
    renameBehavior: "after_filename",
    customDisableSuffix: ".disabled",
    toggleMoveMode: recipeId === "move_folder" ? "whole_folder" : "tracked_files",
    folderSuffixTarget: recipeId === "move_folder" ? "folder" : "files",
    disableConflictBehavior: "replace_same_receipt",
    createDisabledFolder: true,
    preserveDisabledStructure: true,
    trackDisabledMapping: true,
    moveEmptyParents: false,
    restoreExactPaths: true,
    removeDisabledFolderWhenEmpty: true,
  };
}

function disabledFolderLabel(location: DisabledFolderLocation, folderName: string, inheritedDestination: string, explicitPath: string) {
  const folder = folderName || "disabled";
  if (location === "inside_install_folder") return `${friendlyPath(inheritedDestination || "Install folder")}/${folder}`;
  if (location === "selected_mods_folder") return `${friendlyPath(inheritedDestination || "Selected Mods folder")}/${folder}`;
  if (location === "game_folder") return `Game folder/${folder}`;
  if (location === "profile_disabled_storage") return `Profile-managed disabled storage/${folder}`;
  if (location === "choose_another_folder" || location === "custom_path") return explicitPath ? friendlyPath(explicitPath) : "Choose a disabled folder";
  return folder;
}

function renamedDisabledFilename(fileName: string, behavior: RenameBehavior, suffix: string, customRule: string) {
  const cleanSuffix = suffix || ".disabled";
  const dot = fileName.lastIndexOf(".");
  if (behavior === "before_extension" && dot > 0) return `${fileName.slice(0, dot)}${cleanSuffix}${fileName.slice(dot)}`;
  if (behavior === "replace_extension" && dot > 0) return `${fileName.slice(0, dot)}${cleanSuffix}`;
  if (behavior === "custom_suffix") return `${fileName}${cleanSuffix}`;
  if (behavior === "custom_rule") return customRule || `${fileName}${cleanSuffix}`;
  return `${fileName}${cleanSuffix}`;
}

function togglePreviewRows(recipeId: DisableRecipeId, inheritedDestination: string, folderLocation: DisabledFolderLocation, folderName: string, renameBehavior: RenameBehavior, suffix: string, customRule: string, explicitPath: string, moveMode: ToggleMoveMode) {
  const installBase = friendlyPath(inheritedDestination || "Selected mod type destination");
  const original = `${installBase}/ExampleMod/main.lua`;
  const disabledFolder = disabledFolderLabel(folderLocation, folderName, inheritedDestination, explicitPath);
  const renamed = renamedDisabledFilename("main.lua", renameBehavior, suffix, customRule);
  const disabled = recipeId === "suffix_files"
    ? `${installBase}/ExampleMod/${renamed}`
    : recipeId === "move_folder" || moveMode === "whole_folder"
      ? `${disabledFolder}/ExampleMod/${recipeId === "move_and_suffix" ? renamed : "main.lua"}`
      : `${disabledFolder}/ExampleMod/main.lua${recipeId === "move_and_suffix" ? ".disabled" : ""}`;
  return { original, disabled, enable: generatedEnableBehavior(recipeId) };
}
function DependencyRelationshipChecklist({ entry, draft, label, title, description, onChange }: { entry: Item; draft: Draft; label: "Used By" | "Requires Dependencies"; title: string; description: string; onChange: (entry: Item) => void }) {
  const [query, setQuery] = useState("");
  const selected = new Set(listField(entry, label));
  const modTypeOptions = [
    ...draft.sections.modTypes.map((modType) => ({ id: `modtype:${modType.id}`, label: modType.title, group: "Mod Type" })),
    ...draft.customFileTypes.map((modType) => ({ id: `custom:${modType.id}`, label: modType.name || "Custom Mod Type", group: "Mod Type" })),
  ];
  const dependencyOptions = draft.sections.dependencies.filter((dependency) => dependency.id !== entry.id && dependency.title !== entry.title).map((dependency) => ({ id: `dependency:${dependency.id}`, label: dependency.title, group: "Dependency" }));
  const options = (label === "Used By" ? [...modTypeOptions, ...dependencyOptions] : dependencyOptions).filter((option) => !query.trim() || `${option.label} ${option.group}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="creator-builder-section"><header><div><h3>{title}</h3><p>{description}</p></div></header><FormField label="Search" size="wide"><TransferTextInput value={query} placeholder="Search mod types or dependencies" onChange={setQuery} /></FormField>{options.length ? <div className="creator-checkbox-stack creator-used-by-grid">{options.map((option) => <label key={option.id}><input type="checkbox" checked={selected.has(option.label)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(option.label); else next.delete(option.label); onChange(replaceListField(entry, label, Array.from(next))); }} /><span><strong>{option.label}</strong><small>{option.group}</small></span></label>)}</div> : <article className="creator-empty-state compact"><strong>No matches.</strong><p>Add mod types or dependencies first, or save this dependency and link it later.</p></article>}</section>;
}

function DependencyMarkerEditor({ entry, mode, draft, update, dryRun }: { entry: Item; mode: Mode; draft: Draft; update: (entry: Item) => void; dryRun: (label: string) => void }) {
  const [filename, setFilename] = useState("");
  const [folderName, setFolderName] = useState("");
  const files = listField(entry, "Marker Filenames");
  const folders = listField(entry, "Marker Folders");
  function setFiles(values: string[]) {
    let next = replaceListField(entry, "Marker Filenames", values);
    next = replaceField(next, "Marker File", values[0] ?? "");
    update(next);
  }
  function setFolders(values: string[]) {
    let next = replaceListField(entry, "Marker Folders", values);
    next = replaceField(next, "Marker Folder", values[0] ?? "");
    update(next);
  }
  return <section className="creator-builder-section"><header><div><h3>How can Tsuki tell it is installed?</h3><p>Use files or folders that prove this framework, loader, library, tool, or supporting mod is present.</p></div></header><OptionCards value={fieldValue(entry, "Detection Method") || "Known dependency preset"} options={dependencyDetectionOptions.map((value) => ({ value, label: value }))} onChange={(value) => update(replaceField(entry, "Detection Method", value))} /><div className="creator-catalog-selected"><SelectionChipList title="Marker files" values={files} onRemove={(value) => setFiles(files.filter((item) => item !== value))} /><SelectionChipList title="Marker folders" values={folders} onRemove={(value) => setFolders(folders.filter((item) => item !== value))} /></div><FormGrid columns="two"><FormField label="Add filename" size="wide"><div className="creator-extension-entry"><TransferTextInput value={filename} placeholder="RED4ext.dll" onChange={setFilename} /><button className="creator-button secondary" type="button" onClick={() => { const clean = fileNameFromPath(filename.trim()); if (clean && !files.includes(clean)) setFiles([...files, clean]); setFilename(""); }}>Add Filename</button></div></FormField><FormField label="Add folder name" size="wide"><div className="creator-extension-entry"><TransferTextInput value={folderName} placeholder="red4ext/plugins" onChange={setFolderName} /><button className="creator-button secondary" type="button" onClick={() => { const clean = folderName.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); if (clean && !folders.includes(clean)) setFolders([...folders, clean]); setFolderName(""); }}>Add Folder Name</button></div></FormField></FormGrid><div className="creator-card-grid two"><FileSelector label="Choose Marker File" value={fieldValue(entry, "Marker File")} mode="markerFile" showOverride={mode === "advanced"} onChange={(value) => { const clean = fileNameFromPath(value); if (clean && !files.includes(clean)) setFiles([...files, clean]); }} dryRun={dryRun} /><PathSelector label="Choose Marker Folder" value={fieldValue(entry, "Marker Folder")} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => { const clean = value.trim(); if (clean && !folders.includes(clean)) setFolders([...folders, clean]); }} dryRun={dryRun} allowNamed={false} /></div></section>;
}

function DependencySourceFields({ entry, update, dryRun }: { entry: Item; update: (entry: Item) => void; dryRun: (label: string) => void }) {
  const sourceType = (fieldValue(entry, "Download Source Type") || "manual") as DependencyDownloadSourceType;
  const pageUrl = fieldValue(entry, "Dependency Page URL");
  function updateField(label: string, value: string) { update(normalizeDependencyItem(replaceField(entry, label, value))); }
  function applyUrl(value: string) {
    const parsed = parseDependencySourceUrl(value);
    update(parsed ? applyDependencySource(entry, parsed) : normalizeDependencyItem(replaceField(entry, "Dependency Page URL", value)));
  }
  async function pasteUrl(expected: DependencyDownloadSourceType) {
    const selected = await readClipboardReference(false);
    if (!selected) return;
    const parsed = parseDependencySourceUrl(selected);
    if (parsed && parsed.sourceType === expected) update(applyDependencySource(entry, parsed));
    else update(normalizeDependencyItem(replaceField(replaceField(entry, "Download Source Type", expected), "Dependency Page URL", selected)));
  }
  function clearSource() {
    let next = entry;
    for (const label of ["Dependency Page URL", "Nexus Game Domain", "Nexus Mod ID", "ModWorkshop Game ID", "ModWorkshop Game Slug", "ModWorkshop Mod ID", "GitHub Owner", "GitHub Repository", "Direct Download URL", "Version Endpoint", "Checksum"]) next = replaceField(next, label, "");
    update(normalizeDependencyItem(next));
  }
  return <section className="creator-builder-section"><header><div><h3>Where can Tsuki download it?</h3><p>Profiles store public source identifiers only. Personal API keys and tokens stay in global Settings.</p></div></header><OptionCards value={sourceType} options={dependencySourceOptions} onChange={(value) => update(normalizeDependencyItem(replaceField(entry, "Download Source Type", value)))} />{sourceType === "nexus" && <div className="creator-form-stack"><FormField label="Nexus dependency page" help="Accepted: https://www.nexusmods.com/<game-domain>/mods/<mod-id>" size="wide"><TransferTextInput value={pageUrl} placeholder="https://www.nexusmods.com/cyberpunk2077/mods/2380" onChange={applyUrl} /></FormField><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => void pasteUrl("nexus")}>Paste Nexus URL</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Search Nexus Mods")}>Search Nexus Mods</button><button className="creator-button ghost" type="button" onClick={clearSource}>Clear</button></div><div className="creator-guided-summary"><span>Game domain</span><strong>{fieldValue(entry, "Nexus Game Domain") || "Not parsed"}</strong><span>Mod ID</span><strong>{fieldValue(entry, "Nexus Mod ID") || "Not parsed"}</strong><span>Account</span><strong>Uses global Nexus connection from Settings; no API key is stored in this profile.</strong></div><p className="creator-safety-note">If Nexus Mods is not connected, Tsuki should show "Nexus Mods is not connected" with an Open Account Settings action before release resolution.</p></div>}{sourceType === "modworkshop" && <div className="creator-form-stack"><FormField label="ModWorkshop dependency page" size="wide"><TransferTextInput value={pageUrl} placeholder="https://modworkshop.net/mod/12345" onChange={applyUrl} /></FormField><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => void pasteUrl("modworkshop")}>Paste ModWorkshop URL</button><button className="creator-button secondary" type="button" onClick={() => dryRun("Search ModWorkshop")}>Search ModWorkshop</button><button className="creator-button ghost" type="button" onClick={clearSource}>Clear</button></div><div className="creator-guided-summary"><span>Game</span><strong>{fieldValue(entry, "ModWorkshop Game ID") || fieldValue(entry, "ModWorkshop Game Slug") || "Not parsed"}</strong><span>Mod ID</span><strong>{fieldValue(entry, "ModWorkshop Mod ID") || "Not parsed"}</strong><span>Connection</span><strong>Public API - no login required</strong></div></div>}{sourceType === "github" && <div className="creator-form-stack"><FormField label="GitHub URL" help="Repository, releases page, or specific release URL." size="wide"><TransferTextInput value={pageUrl} placeholder="https://github.com/owner/repository/releases" onChange={applyUrl} /></FormField><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => void pasteUrl("github")}>Paste GitHub URL</button><button className="creator-button ghost" type="button" onClick={clearSource}>Clear</button></div><FormGrid columns="two"><FormField label="Owner" size="wide"><TransferTextInput value={fieldValue(entry, "GitHub Owner")} onChange={(value) => updateField("GitHub Owner", value)} /></FormField><FormField label="Repository" size="wide"><TransferTextInput value={fieldValue(entry, "GitHub Repository")} onChange={(value) => updateField("GitHub Repository", value)} /></FormField><FormField label="Release channel" size="wide"><select className="setting-input" value={fieldValue(entry, "GitHub Release Channel") || "Latest stable"} onChange={(event) => updateField("GitHub Release Channel", event.target.value)}>{dependencyReleaseChannels.map((channel) => <option key={channel}>{channel}</option>)}</select></FormField><FormField label="Download asset" size="wide"><select className="setting-input" value={fieldValue(entry, "File Selection Mode") || "First matching archive"} onChange={(event) => updateField("File Selection Mode", event.target.value)}>{dependencyFileSelectionModes.map((mode) => <option key={mode}>{mode}</option>)}</select></FormField><FormField label="Allowed asset patterns" size="wide"><TransferTextInput value={fieldValue(entry, "Include Asset Patterns")} placeholder="*.zip|*.7z|*.dll" onChange={(value) => updateField("Include Asset Patterns", value)} /></FormField><FormField label="Ignored asset patterns" help="Source-code archives are ignored by default." size="wide"><TransferTextInput value={fieldValue(entry, "Exclude Asset Patterns")} onChange={(value) => updateField("Exclude Asset Patterns", value)} /></FormField></FormGrid></div>}{sourceType === "direct" && <FormGrid columns="two"><FormField label="Direct download URL" size="wide"><TransferTextInput value={fieldValue(entry, "Direct Download URL")} onChange={(value) => updateField("Direct Download URL", value)} /></FormField><FormField label="Version endpoint" size="wide"><TransferTextInput value={fieldValue(entry, "Version Endpoint")} onChange={(value) => updateField("Version Endpoint", value)} /></FormField><FormField label="Checksum" size="wide"><TransferTextInput value={fieldValue(entry, "Checksum")} onChange={(value) => updateField("Checksum", value)} /></FormField></FormGrid>}{sourceType === "manual" && <FormField label="Manual install instructions" size="wide"><textarea className="setting-input" rows={3} value={fieldValue(entry, "Manual Install Instructions")} onChange={(event) => updateField("Manual Install Instructions", event.target.value)} /></FormField>}{(sourceType === "included" || sourceType === "custom") && <FieldEditor entry={entry} fields={["Dependency Page URL", "Dependency Resolver", "File Selection Mode", "Include Asset Patterns", "Exclude Asset Patterns"]} update={(next) => update(normalizeDependencyItem(next))} />}</section>;
}
function ItemEditorSheet({ editor, mode, draft, onChange, onSave, onCancel, dryRun }: { editor: ItemEditorState; mode: Mode; draft: Draft; onChange: (entry: Item) => void; onSave: () => void; onCancel: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  const [itemStep, setItemStep] = useState(0);
  const entry = editor.draft;
  const title = itemEditorTitle(editor);
  const sectionLabel = sectionInfo.find((section) => section.id === editor.section)?.label ?? nice(editor.section);
  const update = (next: Item) => onChange(next);
  const updateField = (label: string, value: string) => update(replaceField(entry, label, value));
  const updateTitle = (value: string) => update({ ...entry, title: value });
  const updateSummary = (value: string) => update({ ...entry, summary: value });
  const sectionDryRun = (label: string) => dryRun(label, editor.section);
  const detectionSteps = ["Basics", "Location", "Markers", "Logic", "Test"];
  const markerValues = listField(entry, "Required markers");
  function updateMarkers(values: string[]) { update(replaceListField(entry, "Required markers", values)); }
  function renderIdentity() {
    return <section className="creator-builder-section"><header><div><h3>Identity</h3><p>Name this object in plain language.</p></div></header><FormGrid columns="two"><FormField label="Name" size="wide"><input className="setting-input" value={entry.title} onChange={(event) => updateTitle(event.target.value)} /></FormField><FormField label="Enabled" size="small"><select className="setting-input" value={entry.enabled === false ? "Disabled" : "Enabled"} onChange={(event) => update({ ...entry, enabled: event.target.value === "Enabled" })}><option>Enabled</option><option>Disabled</option></select></FormField></FormGrid><FormField label="Summary" size="wide"><textarea className="setting-input" rows={3} value={entry.summary} onChange={(event) => updateSummary(event.target.value)} /></FormField></section>;
  }
  function renderGuidedDetection() {
    const step = Math.min(itemStep, detectionSteps.length - 1);
    if (step === 0) return <div className="creator-form-stack">{renderIdentity()}<FormField label="Storefront" size="wide"><select className="setting-input" value={fieldValue(entry, "Storefront") || fieldValue(entry, "Detection Type") || detectionPresets[0]} onChange={(event) => { const value = event.target.value; let next = replaceField(entry, "Storefront", value); next = replaceField(next, "Detection Type", value); update(next); }}>{detectionPresets.map((preset) => <option key={preset}>{preset}</option>)}</select></FormField></div>;
    if (step === 1) return <div className="creator-form-stack"><PathSelector label="Game Folder" value={fieldValue(entry, "Root Folder") || fieldValue(entry, "Folder")} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => updateField("Root Folder", value)} dryRun={sectionDryRun} allowNamed={false} /><FileSelector label="Executable" value={fieldValue(entry, "Expected executable")} mode="executable" showOverride={mode === "advanced"} onChange={(value) => updateField("Expected executable", value)} dryRun={sectionDryRun} /></div>;
    if (step === 2) return <section className="creator-builder-section"><header><div><h3>Required Markers</h3><p>Add folders or files Tsuki should check before accepting this game folder.</p></div></header>{markerValues.length ? <div className="creator-chip-row editable-marker-list">{markerValues.map((marker, index) => <span key={`${marker}-${index}`}>{friendlyPath(marker)}<button className="creator-chip-remove" type="button" onClick={() => updateMarkers(markerValues.filter((_, markerIndex) => markerIndex !== index))}>Remove</button></span>)}</div> : <article className="creator-empty-state compact"><strong>No markers yet.</strong><p>Add at least one marker when this game has reliable folder signatures.</p></article>}<PathSelector label="Add Marker Folder" value="" mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => value && updateMarkers([...markerValues, value])} dryRun={sectionDryRun} allowNamed={false} /></section>;
    if (step === 3) return <section className="creator-builder-section"><header><div><h3>Detection Logic</h3><p>Choose a simple rule. Custom raw logic is available in Advanced mode.</p></div></header><OptionCards value={fieldValue(entry, "Condition mode") || "Executable and marker folders exist"} options={["Executable exists", "Executable and marker folders exist", "Any selected marker exists", "All selected markers exist", "Custom"].map((value) => ({ value, label: value }))} onChange={(value) => updateField("Condition mode", value)} /></section>;
    return <div className="creator-form-stack"><ValidationCard issues={[]} empty="Detection method is ready to test." /><div className="creator-guided-summary"><span>Game folder</span><strong>{friendlyPath(fieldValue(entry, "Root Folder") || fieldValue(entry, "Folder") || "Not selected")}</strong><span>Executable</span><strong>{fieldValue(entry, "Expected executable") ? fileNameFromPath(fieldValue(entry, "Expected executable")) : "Not selected"}</strong><span>Match rule</span><strong>{fieldValue(entry, "Condition mode") || "Executable and marker folders exist"}</strong></div></div>;
  }
  function renderInstallEditor() {
    const preset = fieldValue(entry, "Rule Preset") || installRulePresets[0];
    const presetOptions = installRulePresets.map((value) => ({ value, label: value, description: value === "Custom Install Rule" ? "Use Advanced mode to build exact conditions and actions." : "Apply this behavior to the files matched by a mod type." }));
    function applyPreset(value: string) {
      let next = replaceField(entry, "Rule Preset", value);
      next = replaceField(next, "Actions", value);
      next = replaceField(next, "Track receipt ownership", "Yes");
      if (!fieldValue(next, "Destination") && value !== "Ignore Matching Files") next = replaceField(next, "Destination", "${GAME_ROOT}");
      update({ ...next, title: entry.title === "New Install Rule" ? value : entry.title, summary: value === "Custom Install Rule" ? "Advanced install rule." : `Install preset: ${value}.` });
    }
    return <><section className="creator-builder-section"><header><div><h3>Install Preset</h3><p>Choose the common behavior first. Exact WHEN/THEN rules stay in Advanced mode.</p></div></header><OptionCards value={preset} options={presetOptions} onChange={applyPreset} /></section>{renderIdentity()}<PathSelector label="Install to" value={fieldValue(entry, "Destination")} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => updateField("Destination", value)} dryRun={sectionDryRun} /><ToggleCards options={[{ label: "Track receipt ownership", description: "Remember every written file so uninstall and repair stay safe.", checked: fieldValue(entry, "Track receipt ownership") !== "No", onChange: (checked) => updateField("Track receipt ownership", checked ? "Yes" : "No") }, { label: "Preserve folder structure", description: "Keep archive folders below the destination.", checked: fieldValue(entry, "Preserve structure") === "Yes", onChange: (checked) => updateField("Preserve structure", checked ? "Yes" : "No") }, { label: "Back up replacements", description: "Create rollback backups before replacing existing files.", checked: fieldValue(entry, "Overwrite with backup") === "Yes", onChange: (checked) => updateField("Overwrite with backup", checked ? "Yes" : "No") }]} />{mode === "advanced" && <RuleBuilder conditions={fieldValue(entry, "Conditions")} actions={fieldValue(entry, "Actions")} destination={fieldValue(entry, "Destination")} onConditions={(value) => updateField("Conditions", value)} onActions={(value) => updateField("Actions", value)} onDestination={(value) => updateField("Destination", value)} draft={draft} mode={mode} />}</>;
  }
  function renderToggleEditor() {
    const selectedName = fieldValue(entry, "Mod Type");
    const selectedBuiltIn = draft.sections.modTypes.find((modType) => modType.title === selectedName);
    const selectedCustom = draft.customFileTypes.find((modType) => (modType.name || "Custom Mod Type") === selectedName);
    const inheritedDestination = selectedCustom?.destination || (selectedBuiltIn ? fieldValue(selectedBuiltIn, "Destination") : "") || "Choose a mod type to inherit its destination.";
    const destinationOverride = fieldValue(entry, "Destination");
    const recipeId = inferDisableRecipeId(recipeEntryValue(entry, "Disable Recipe") || fieldValue(entry, "Disable Method"));
    const folderLocation = recipeEntryValue(entry, "Disabled Folder Location") as DisabledFolderLocation;
    const folderName = recipeEntryValue(entry, "Disabled Folder Name") || "disabled";
    const renameBehavior = recipeEntryValue(entry, "Rename Behavior") as RenameBehavior;
    const suffix = recipeEntryValue(entry, "Disable Custom Suffix") || ".disabled";
    const customRule = fieldValue(entry, "Custom Rename Rule");
    const moveMode = recipeEntryValue(entry, "Move Mode") as ToggleMoveMode;
    const explicitDisabledPath = fieldValue(entry, "Disabled Folder Path");
    const preview = togglePreviewRows(recipeId, destinationOverride || inheritedDestination, folderLocation, folderName, renameBehavior, suffix, customRule, explicitDisabledPath, moveMode);
    const needsFolderSettings = recipeId === "move_folder" || recipeId === "move_files" || recipeId === "move_and_suffix";
    const needsRenameSettings = recipeId === "suffix_files" || recipeId === "move_and_suffix" || recipeId === "rename_main_file";
    const needsDisabledPath = folderLocation === "choose_another_folder" || folderLocation === "custom_path";
    const folderLocationOptions = disabledFolderLocationOptions.map((option) => ({ value: option.value, label: option.label, description: option.description }));
    function applyRecipe(value: string) {
      update(replaceRecipeDefaults(entry, value as DisableRecipeId));
    }
    function updateRecipeField(label: string, value: string) {
      updateField(label, value);
    }
    return <>{renderIdentity()}<FormField label="Mod Type" size="wide"><select className="setting-input" value={selectedName} onChange={(event) => updateField("Mod Type", event.target.value)}><option value="">Choose mod type...</option>{draft.sections.modTypes.map((modType) => <option key={modType.id}>{modType.title}</option>)}{draft.customFileTypes.map((modType) => <option key={modType.id}>{modType.name || "Custom Mod Type"}</option>)}</select></FormField><section className="creator-builder-section"><header><div><h3>Disable Recipe</h3><p>Choose how Tsuki disables this mod type. Enable behavior is generated automatically from receipt mappings.</p></div></header><OptionCards value={recipeId} options={disableRecipeOptions} onChange={applyRecipe} /><div className="creator-guided-summary"><span>Install location</span><strong>{friendlyPath(destinationOverride || inheritedDestination)}</strong><span>Disable</span><strong>{recipeLabel(recipeId)}</strong><span>Generated enable</span><strong>{generatedEnableBehavior(recipeId)}</strong></div>{destinationOverride ? <><PathSelector label="Override install destination" value={destinationOverride} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => updateRecipeField("Destination", value)} dryRun={sectionDryRun} /><button className="creator-button secondary" type="button" onClick={() => updateRecipeField("Destination", "")}>Use Mod Type Destination</button></> : <button className="creator-button secondary" type="button" onClick={() => updateRecipeField("Destination", selectedCustom?.destination || fieldValue(selectedBuiltIn ?? item("none", "", ""), "Destination") || "${GAME_ROOT}")}>Override Destination</button>}</section>{needsFolderSettings && <section className="creator-builder-section"><header><div><h3>Disabled Folder</h3><p>Tsuki moves only tracked receipt files and stores reversible mappings for each file.</p></div></header><OptionCards value={folderLocation} options={folderLocationOptions} onChange={(value) => updateRecipeField("Disabled Folder Location", value)} /><FormGrid columns="two"><FormField label="Disabled folder name" size="wide"><TransferTextInput value={folderName} placeholder="disabled" onChange={(value) => updateRecipeField("Disabled Folder Name", value)} /></FormField><FormField label="Move mode" size="wide"><select className="setting-input" value={moveMode} onChange={(event) => updateRecipeField("Move Mode", event.target.value)}>{toggleMoveModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField>{moveMode === "whole_folder" && <FormField label="Whole-folder suffix target" size="wide"><select className="setting-input" value={recipeEntryValue(entry, "Folder Suffix Target") as FolderSuffixTarget} onChange={(event) => updateRecipeField("Folder Suffix Target", event.target.value)}>{folderSuffixTargetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField>}<FormField label="Conflict behavior" size="wide"><select className="setting-input" value={recipeEntryValue(entry, "Disable Conflict") as DisableConflictBehavior} onChange={(event) => updateRecipeField("Disable Conflict", event.target.value)}>{disableConflictOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField></FormGrid>{needsDisabledPath && <PathSelector label="Disabled folder path" value={explicitDisabledPath} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => updateRecipeField("Disabled Folder Path", value)} dryRun={sectionDryRun} />}<ToggleCards options={[{ label: "Create disabled folder", description: "Create the disabled folder only when it is needed.", checked: recipeEntryChecked(entry, "Create Disabled Folder"), onChange: (checked) => updateRecipeField("Create Disabled Folder", checked ? "Yes" : "No") }, { label: "Preserve structure", description: "Keep original relative paths inside disabled storage.", checked: recipeEntryChecked(entry, "Preserve Disabled Structure"), onChange: (checked) => updateRecipeField("Preserve Disabled Structure", checked ? "Yes" : "No") }, { label: "Track original and disabled paths", description: "Store originalPath, disabledPath, originalFilename, disabledFilename, and receiptId.", checked: recipeEntryChecked(entry, "Track Disabled Mapping"), onChange: (checked) => updateRecipeField("Track Disabled Mapping", checked ? "Yes" : "No") }, { label: "Move empty parent folders", description: "Move now-empty parent folders only when they are receipt-owned.", checked: recipeEntryChecked(entry, "Move Empty Parent Folders"), onChange: (checked) => updateRecipeField("Move Empty Parent Folders", checked ? "Yes" : "No") }, { label: "Restore exact paths", description: "Enable restores every tracked file to its recorded original path.", checked: recipeEntryChecked(entry, "Restore Exact Paths"), onChange: (checked) => updateRecipeField("Restore Exact Paths", checked ? "Yes" : "No") }, { label: "Remove disabled folder when empty", description: "Clean up the disabled folder only after tracked files are restored.", checked: recipeEntryChecked(entry, "Remove Disabled Folder When Empty"), onChange: (checked) => updateRecipeField("Remove Disabled Folder When Empty", checked ? "Yes" : "No") }]} /></section>}{needsRenameSettings && <section className="creator-builder-section"><header><div><h3>Rename Behavior</h3><p>Default is after the complete filename, for example main.lua.disabled.</p></div></header><FormGrid columns="two"><FormField label="Rename behavior" size="wide"><select className="setting-input" value={renameBehavior} onChange={(event) => updateRecipeField("Rename Behavior", event.target.value)}>{renameBehaviorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField><FormField label="Suffix" size="wide"><TransferTextInput value={suffix} placeholder=".disabled" onChange={(value) => updateRecipeField("Disable Custom Suffix", value)} /></FormField>{renameBehavior === "custom_rule" && <FormField label="Custom rename rule" size="wide"><TransferTextInput value={customRule} placeholder="main.lua -> main.lua.disabled" onChange={(value) => updateRecipeField("Custom Rename Rule", value)} /></FormField>}</FormGrid></section>}{recipeId === "config_value" && <section className="creator-builder-section"><header><div><h3>Config Toggle</h3><p>Tsuki records the previous config value in the receipt and restores it during enable.</p></div></header><FieldEditor entry={entry} fields={["Config File", "Config Key", "Disabled Value", "Enabled Value"]} update={update} /></section>}{recipeId === "rename_main_file" && <section className="creator-builder-section"><header><div><h3>Main File</h3><p>Use only when a loader treats one file as the enable switch.</p></div></header><FieldEditor entry={entry} fields={["Main File"]} update={update} /></section>}{recipeId === "loader_controlled" && <article className="creator-empty-state compact"><strong>Loader controlled</strong><p>Tsuki will record the requested state and let the loader perform the actual toggle.</p></article>}{recipeId === "unsupported" && <article className="creator-empty-state compact"><strong>Disable action unavailable</strong><p>Users can install or uninstall this mod type, but Tsuki will not offer a disable button.</p></article>}{recipeId === "custom" && <article className="creator-empty-state compact"><strong>Custom behavior</strong><p>Use Advanced mode to define a reversible custom strategy. Guided mode keeps raw rules hidden.</p></article>}<section className="creator-builder-section"><header><div><h3>Live Preview</h3><p>Preview uses readable paths and does not write files or rescan the install folder.</p></div></header><div className="creator-guided-summary"><span>Original tracked file</span><strong>{preview.original}</strong><span>Disabled tracked file</span><strong>{preview.disabled}</strong><span>Enable behavior</span><strong>{preview.enable}</strong><span>Safety</span><strong>Touch tracked receipt files only; unmanaged files are ignored.</strong></div></section>{mode === "advanced" && <details className="creator-advanced-panel" open><summary>Customize Enable Behavior</summary><FormField label="Generated enable behavior" size="wide"><textarea className="setting-input" rows={3} value={fieldValue(entry, "Enable Method") || generatedEnableBehavior(recipeId)} onChange={(event) => updateRecipeField("Enable Method", event.target.value)} /></FormField><FieldEditor entry={entry} fields={["Receipt Mapping", "Custom Behavior", "Pre-disable Action", "Post-enable Action"]} update={update} /></details>}</>;
  }
  function renderDependencyEditor() {
    const normalized = normalizeDependencyItem(entry);
    const preset = fieldValue(normalized, "Dependency Type") || "Custom Dependency";
    const sourceType = fieldValue(normalized, "Download Source Type") || "manual";
    const graph = dependencyGraphPlan([...draft.sections.dependencies.filter((dependency) => dependency.id !== entry.id), normalized]);
    function updateDependency(next: Item) { update(normalizeDependencyItem(next)); }
    function setDependencyField(label: string, value: string) { updateDependency(replaceField(normalized, label, value)); }
    function applyPreset(value: string) { updateDependency(applyDependencyPreset(normalized, value)); }
    return <div className="creator-form-stack dependency-guided-editor"><section className="creator-builder-section"><header><div><h3>What does this mod need?</h3><p>Pick the loader, framework, library, tool, or supporting mod. Presets are starting points and stay editable.</p></div></header><OptionCards value={preset} options={dependencyPresets.map((value) => ({ value, label: value, description: dependencyPresetDetails[value]?.description }))} onChange={applyPreset} /></section><section className="creator-builder-section"><header><div><h3>Dependency</h3><p>Name the dependency and decide whether it is required, optional, or another dependency's parent.</p></div></header><FormGrid columns="two"><FormField label="Name" size="wide"><input className="setting-input" value={normalized.title} onChange={(event) => updateDependency({ ...normalized, title: event.target.value })} /></FormField><FormField label="Required or optional" size="wide"><select className="setting-input" value={fieldValue(normalized, "Required") || "Optional / Recommended"} onChange={(event) => setDependencyField("Required", event.target.value)}>{dependencyRequiredOptions.map((option) => <option key={option}>{option}</option>)}</select></FormField><FormField label="Kind" size="wide"><select className="setting-input" value={fieldValue(normalized, "Dependency Kind") || "Custom"} onChange={(event) => setDependencyField("Dependency Kind", event.target.value)}>{["Framework", "Loader", "Library", "Tool", "Supporting Mod", "Custom"].map((kind) => <option key={kind}>{kind}</option>)}</select></FormField><FormField label="Setup group" size="wide"><select className="setting-input" value={fieldValue(normalized, "Setup Group") || "Recommended dependency"} onChange={(event) => setDependencyField("Setup Group", event.target.value)}>{["Core dependency", "Mod-type dependency", "Recommended dependency", "Parent dependency"].map((group) => <option key={group}>{group}</option>)}</select></FormField></FormGrid><FormField label="Description" size="wide"><textarea className="setting-input" rows={3} value={normalized.summary} onChange={(event) => updateDependency({ ...normalized, summary: event.target.value })} /></FormField></section><DependencyRelationshipChecklist entry={normalized} draft={draft} label="Used By" title="Which mods use it?" description="Select the mod types or other dependencies that require this dependency." onChange={updateDependency} /><DependencyRelationshipChecklist entry={normalized} draft={draft} label="Requires Dependencies" title="What does this dependency require?" description="Select parent dependencies. Tsuki installs parents first and blocks cycles." onChange={updateDependency} /><DependencyMarkerEditor entry={normalized} mode={mode} draft={draft} update={updateDependency} dryRun={sectionDryRun} /><section className="creator-builder-section"><header><div><h3>Latest compatible version</h3><p>Choose the version rule. Compatibility restrictions are used before selecting a newest release.</p></div></header><FormGrid columns="two"><FormField label="Required version" size="wide"><select className="setting-input" value={fieldValue(normalized, "Version Requirement") || "Any compatible version"} onChange={(event) => setDependencyField("Version Requirement", event.target.value)}>{versionRulePresets.map((rule) => <option key={rule}>{rule}</option>)}</select></FormField><FormField label="Minimum version" size="wide"><TransferTextInput value={fieldValue(normalized, "Minimum Version")} onChange={(value) => setDependencyField("Minimum Version", value)} /></FormField><FormField label="Maximum version" size="wide"><TransferTextInput value={fieldValue(normalized, "Maximum Version")} onChange={(value) => setDependencyField("Maximum Version", value)} /></FormField><FormField label="Exact version" size="wide"><TransferTextInput value={fieldValue(normalized, "Exact Version")} onChange={(value) => setDependencyField("Exact Version", value)} /></FormField><FormField label="Version range" size="wide"><TransferTextInput value={fieldValue(normalized, "Version Range")} onChange={(value) => setDependencyField("Version Range", value)} /></FormField><FormField label="Blocked versions" size="wide"><TransferTextInput value={fieldValue(normalized, "Blocked Versions")} onChange={(value) => setDependencyField("Blocked Versions", value)} /></FormField></FormGrid></section><DependencySourceFields entry={normalized} update={updateDependency} dryRun={sectionDryRun} /><section className="creator-builder-section"><header><div><h3>How should Tsuki install it?</h3><p>Common dependencies use their preset. Override only when the profile knows a safer destination or file rule.</p></div></header><OptionCards value={fieldValue(normalized, "Install Method") || "Use dependency preset"} options={dependencyInstallOptions.map((value) => ({ value, label: value }))} onChange={(value) => setDependencyField("Install Method", value)} /><PathSelector label="Install destination" value={fieldValue(normalized, "Destination")} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(value) => setDependencyField("Destination", value)} dryRun={sectionDryRun} /><ToggleCards options={[{ label: "Preserve configuration", description: "Updates and repairs should keep user config unless explicitly replaced.", checked: fieldValue(normalized, "Preserve Config") !== "No", onChange: (checked) => setDependencyField("Preserve Config", checked ? "Yes" : "No") }, { label: "Create dependency receipt", description: "Install, update, repair, and removal operate only on dependency-owned receipt files.", checked: fieldValue(normalized, "Create Dependency Receipt") !== "No", onChange: (checked) => setDependencyField("Create Dependency Receipt", checked ? "Yes" : "No") }]} /></section><section className="creator-builder-section"><header><div><h3>Update, repair, and removal safety</h3><p>These policies tell Tsuki how to avoid reinstalling compatible versions or deleting shared/user files.</p></div></header><FormGrid columns="two"><FormField label="Update policy" size="wide"><textarea className="setting-input" rows={2} value={fieldValue(normalized, "Update Policy")} onChange={(event) => setDependencyField("Update Policy", event.target.value)} /></FormField><FormField label="Repair action" size="wide"><textarea className="setting-input" rows={2} value={fieldValue(normalized, "Repair Action")} onChange={(event) => setDependencyField("Repair Action", event.target.value)} /></FormField><FormField label="Removal safety" size="wide"><textarea className="setting-input" rows={2} value={fieldValue(normalized, "Removal Safety") || fieldValue(normalized, "Uninstall Policy")} onChange={(event) => setDependencyField("Removal Safety", event.target.value)} /></FormField><FormField label="Permission summary" size="wide"><textarea className="setting-input" rows={2} value={fieldValue(normalized, "Permission Summary")} onChange={(event) => setDependencyField("Permission Summary", event.target.value)} /></FormField></FormGrid></section><section className="creator-builder-section"><header><div><h3>Dependency install plan preview</h3><p>Preview metadata only; Tsuki must still ask before downloading or installing dependencies.</p></div></header><div className="creator-guided-summary"><span>Source</span><strong>{dependencyDownloadSummary(normalized)}</strong><span>Resolver</span><strong>{sourceType === "github" ? "Latest stable release; source-code archives ignored unless explicitly required" : sourceType === "nexus" ? "Latest compatible main file from global Nexus account" : sourceType === "modworkshop" ? "Latest supported public ModWorkshop file" : sourceType === "direct" ? "Fixed public file with optional version endpoint" : "Detect/manual instructions only"}</strong><span>Graph order</span><strong>{graph.order.join(" -> ") || normalized.title}</strong><span>Cycles</span><strong>{graph.cycles.length ? graph.cycles.join(" | ") : "None"}</strong><span>Receipts</span><strong>{fieldValue(normalized, "Create Dependency Receipt") !== "No" ? "Create individual dependency receipt" : "Receipt disabled"}</strong></div><div className="creator-action-row"><button className="creator-button primary" type="button" onClick={() => sectionDryRun(`Test ${normalized.title || "Dependency"}`)}>Test Dependency</button><button className="creator-button secondary" type="button" onClick={() => sectionDryRun("Resolve Latest Compatible Dependency Release")}>Resolve Latest Compatible Version</button><button className="creator-button secondary" type="button" onClick={() => sectionDryRun("Preview Dependency Graph")}>Preview Dependency Graph</button></div></section>{mode === "advanced" && <section className="creator-builder-section"><header><div><h3>Advanced Setup</h3><p>Raw resolver, install, update, repair, and removal fields remain available for maintainers.</p></div></header><FieldEditor entry={normalized} fields={editorFieldNames(normalized, ["Dependency Source JSON", "Dependency Resolver", "Archive Extraction Rules", "Component Selection", "Hash Verification", "Game Version Compatibility", "Dependency Compatibility", "Pinned Version", "Ignore Version"])} update={updateDependency} /><textarea className="setting-input creator-code-box" readOnly value={JSON.stringify(normalized, null, 2)} /></section>}</div>;
  }
  function renderConflictEditor() {
    return <><OptionCards value={fieldValue(entry, "Resolution") || conflictRulePresets[0]} options={conflictRulePresets.map((preset) => ({ value: preset, label: preset }))} onChange={(value) => { let next = replaceField(entry, "Conflict Type", value); next = replaceField(next, "Resolution", value); update({ ...next, title: entry.title === "Custom Conflict Rule" || !entry.title ? value : entry.title }); }} />{renderIdentity()}<FormField label="Condition" size="wide"><textarea className="setting-input" rows={3} value={fieldValue(entry, "Condition")} onChange={(event) => updateField("Condition", event.target.value)} /></FormField><FormField label="Resolution" size="wide"><select className="setting-input" value={fieldValue(entry, "Resolution") || conflictRulePresets[0]} onChange={(event) => updateField("Resolution", event.target.value)}>{conflictRulePresets.map((preset) => <option key={preset}>{preset}</option>)}</select></FormField></>;
  }
  function renderGuidedBody() {
    if (editor.section === "detectionStores") return renderGuidedDetection();
    if (editor.section === "installBehavior") return renderInstallEditor();
    if (editor.section === "enableDisable") return renderToggleEditor();
    if (editor.section === "dependencies") return renderDependencyEditor();
    if (editor.section === "conflicts") return renderConflictEditor();
    return <>{renderIdentity()}<FieldEditor entry={entry} fields={editorFieldNames(entry).filter((field) => !/id|key|receipt|validation|schema|raw/i.test(field))} update={update} /></>;
  }
  function renderAdvancedBody() {
    const advancedFields = editorFieldNames(entry, ["Internal ID", "Notes", "Receipt Behavior", "Validation Notes"]);
    return <div className="creator-form-stack creator-advanced-technical"><section className="creator-builder-section"><header><div><h3>Raw {sectionLabel}</h3><p>Technical fields stored in the draft profile.</p></div></header><div className="creator-rule-preview"><span>Internal ID</span><strong>{entry.id}</strong><span>Enabled</span><strong>{entry.enabled === false ? "false" : "true"}</strong><span>Save target</span><strong>{editor.mode === "add" ? "New item" : `${editor.section}[${editor.index ?? 0}]`}</strong></div><FieldEditor entry={entry} fields={advancedFields} update={update} /></section><section className="creator-builder-section"><header><div><h3>Raw JSON</h3><p>Generated object preview.</p></div></header><textarea className="setting-input creator-code-box" readOnly value={JSON.stringify(entry, null, 2)} /></section></div>;
  }
  return <div className="creator-drawer-backdrop" role="presentation"><aside className={mode === "advanced" ? "creator-editor-sheet technical-editor-sheet" : "creator-editor-sheet"} role="dialog" aria-modal="true" aria-label={title}><header className="creator-editor-header"><div><h2>{title}</h2><p>{mode === "advanced" ? `Advanced technical configuration for ${entry.id}` : editor.section === "detectionStores" ? "Guided detection setup." : editor.mode === "add" ? `Unsaved ${sectionLabel}. Nothing is added until ${editor.saveLabel}.` : `Guided ${sectionLabel} setup.`}</p></div><button className="creator-button ghost" type="button" onClick={onCancel}>Close</button></header><div className="creator-editor-content">{mode === "guided" && editor.section === "detectionStores" && <div className="creator-step-tabs" role="tablist">{detectionSteps.map((label, index) => <button className={index === Math.min(itemStep, detectionSteps.length - 1) ? "active" : ""} type="button" key={label} onClick={() => setItemStep(index)}>{index + 1}. {label}</button>)}</div>}{mode === "guided" ? renderGuidedBody() : renderAdvancedBody()}</div><footer className="creator-editor-footer"><div className="creator-editor-footer-left"><button className="creator-button primary" type="button" onClick={() => sectionDryRun(`Test ${entry.title || sectionLabel}`)}>Test</button></div><div className="creator-editor-footer-right"><button className="creator-button ghost" type="button" onClick={onCancel}>Cancel</button><button className="creator-button primary" type="button" onClick={onSave}>{editor.saveLabel}</button></div></footer></aside></div>;
}
function CustomPathEditorSheet({ editor, mode, sampleRoot, onChange, onSave, onCancel }: { editor: CustomPathEditorState; mode: Mode; sampleRoot: string; onChange: (path: CustomPath) => void; onSave: () => void; onCancel: () => void }) {
  const [pathStep, setPathStep] = useState(0);
  const path = editor.draft;
  const issues = customPathIssues(path);
  const update = (patch: Partial<CustomPath>) => onChange({ ...path, ...patch });
  const steps = ["Identity", "Base Location", "Folder", "Options", "Test"];
  const step = Math.min(pathStep, steps.length - 1);
  const rootOptions = approvedRoots.map((root) => ({ value: root, label: nice(root), description: rootDescriptions[root] ?? "Approved folder root." }));
  async function chooseFolder() {
    const selected = await openPath("folder");
    if (selected) update({ baseRoot: "user_selected_folder", userPrompt: formatFriendlyPath(selected), relativePath: "" });
  }
  function renderGuidedStep() {
    if (step === 0) return <section className="creator-builder-section"><header><div><h3>Identity</h3><p>Name this destination in user-facing language.</p></div></header><FormGrid columns="two"><FormField label="Name" size="wide"><input className="setting-input" value={path.name} placeholder="Disabled Mods" onChange={(event) => update({ name: event.target.value, id: path.id || pathVariableId(event.target.value) })} /></FormField><FormField label="Description" size="wide"><input className="setting-input" value={path.description} onChange={(event) => update({ description: event.target.value })} /></FormField></FormGrid></section>;
    if (step === 1) return <section className="creator-builder-section"><header><div><h3>Base Location</h3><p>Choose one approved base folder. Long raw path previews stay in Advanced.</p></div></header><OptionCards value={path.baseRoot} options={rootOptions} onChange={(baseRoot) => update({ baseRoot })} /><div className="creator-guided-summary"><span>Selected</span><strong>{nice(path.baseRoot)}</strong><span>Preview</span><strong>{formatFriendlyPath(rootPreview(path.baseRoot, sampleRoot))}</strong></div><button className="creator-button primary" type="button" onClick={() => void chooseFolder()}>Choose Folder</button></section>;
    if (step === 2) return <section className="creator-builder-section"><header><div><h3>Folder Inside Base</h3><p>Type only the folder inside the selected base location.</p></div></header><FormField label="Folder Inside Base" size="wide"><TransferTextInput value={path.relativePath} placeholder="Tsuki_Disabled_Mods" onChange={(relativePath) => update({ relativePath })} /></FormField><div className="creator-guided-summary"><span>Resolved Preview</span><strong>{formatFriendlyPath(resolvePathPreview(path, sampleRoot))}</strong></div></section>;
    if (step === 3) return <section className="creator-builder-section"><header><div><h3>Options</h3><p>Set how Tsuki treats this folder during setup and installs.</p></div></header><ToggleCards options={[{ label: "Required", description: "Warn during setup if this path cannot be resolved.", checked: path.required, onChange: (checked) => update({ required: checked }) }, { label: "Create if missing", description: "Tsuki may create this folder during setup or install preview.", checked: path.createIfMissing, onChange: (checked) => update({ createIfMissing: checked }) }, { label: "Writable", description: "Install rules may write tracked receipt files here.", checked: path.writable, onChange: (checked) => update({ writable: checked }) }]} /></section>;
    return <div className="creator-form-stack"><ValidationCard issues={issues} empty="Named path is ready to save." /><div className="creator-guided-summary"><span>Name</span><strong>{path.name || "Named Path"}</strong><span>Resolved Preview</span><strong>{formatFriendlyPath(resolvePathPreview(path, sampleRoot))}</strong></div></div>;
  }
  function renderAdvanced() {
    return <div className="creator-form-stack creator-advanced-technical"><section className="creator-builder-section"><header><div><h3>Raw Path</h3><p>Canonical key, base root, variable, and resolved value.</p></div></header><FormGrid columns="two"><FormField label="Canonical key" size="wide"><input className="setting-input" value={path.id} onChange={(event) => update({ id: pathVariableId(event.target.value) })} /></FormField><FormField label="Base root" size="wide"><select className="setting-input" value={path.baseRoot} onChange={(event) => update({ baseRoot: event.target.value })}>{approvedRoots.map((root) => <option key={root} value={root}>{root}</option>)}</select></FormField><FormField label="Relative path" size="wide"><TransferTextInput value={path.relativePath} onChange={(relativePath) => update({ relativePath })} /></FormField><FormField label="User prompt / selected folder" size="wide"><TransferTextInput value={path.userPrompt ?? ""} onChange={(userPrompt) => update({ userPrompt })} /></FormField><FormField label="Validation markers" size="wide"><TransferTextInput value={path.validationMarkers ?? ""} onChange={(validationMarkers) => update({ validationMarkers })} /></FormField></FormGrid><div className="creator-rule-preview"><span>Variable</span><strong>{pathVariable(path)}</strong><span>Resolved value</span><strong>{formatFriendlyPath(resolvePathPreview(path, sampleRoot))}</strong></div></section><ValidationCard issues={issues} empty="Path is scoped to an approved root and ready for install rules." /></div>;
  }
  return <div className="creator-drawer-backdrop" role="presentation"><aside className={mode === "advanced" ? "creator-editor-sheet technical-editor-sheet" : "creator-editor-sheet"} role="dialog" aria-modal="true" aria-label="Named path editor"><header className="creator-editor-header"><div><h2>{editor.mode === "add" ? "Add Named Path" : "Edit Named Path"}</h2><p>{mode === "advanced" ? `Advanced path configuration for ${path.id}` : "Guided named path setup. Nothing is added until Save Named Path."}</p></div><button className="creator-button ghost" type="button" onClick={onCancel}>Close</button></header><div className="creator-editor-content">{mode === "guided" && <div className="creator-step-tabs" role="tablist">{steps.map((label, index) => <button className={index === step ? "active" : ""} type="button" key={label} onClick={() => setPathStep(index)}>{index + 1}. {label}</button>)}</div>}{mode === "guided" ? renderGuidedStep() : renderAdvanced()}</div><footer className="creator-editor-footer"><div className="creator-editor-footer-left"><button className="creator-button primary" type="button" onClick={() => copyText(formatFriendlyPath(resolvePathPreview(path, sampleRoot)))}>Test Path</button></div><div className="creator-editor-footer-right"><button className="creator-button ghost" type="button" onClick={onCancel}>Cancel</button><button className="creator-button primary" type="button" disabled={issues.some((issue) => issue.level === "error")} onClick={onSave}>Save Named Path</button></div></footer></aside></div>;
}
function CustomTypeEditorSheet({ editor, mode, draft, onChange, onSave, onCancel, dryRun }: { editor: CustomTypeEditorState; mode: Mode; draft: Draft; onChange: (fileType: CustomFileType) => void; onSave: () => void; onCancel: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  const steps = ["Type", "Files", "Destination", "Loader/Dependency", "Enable/Disable", "Load Order", "Conflicts", "Test and Save"];
  const [step, setStep] = useState(0);
  const fileType = editor.draft;
  const presetId = selectedModTypePresetId(fileType);
  const preset = modTypePresetById(presetId);
  const issues = customFileTypeIssues(fileType, draft.customPaths);
  const patterns = fileTypePatterns(fileType);
  const matched = matchFileType(fileType, draft.customTest.sampleFilename);
  const canGoBack = step > 0;
  const canGoNext = step < steps.length - 1;
  const update = (patch: Partial<CustomFileType>) => onChange({ ...fileType, ...patch });
  function choosePreset(value: string) {
    const nextPreset = value as ModTypePresetId;
    const hasCustomWork = Boolean(fileType.name || fileType.destination || fileType.extension || fileType.filenamePattern || fileType.folderMarker || fileType.requiredDependency);
    if (nextPreset !== presetId && hasCustomWork && !window.confirm("Apply this preset and replace the current mod type defaults?")) return;
    onChange(applyModTypePreset(fileType, nextPreset));
  }
  function renderTypeStep() {
    return <div className="creator-form-stack"><section className="creator-builder-section"><header><div><h3>What kind of mod is this?</h3><p>Choose one preset for this mod type. Presets apply only to this item.</p></div></header><OptionCards value={presetId} options={modTypePresetOptions} onChange={choosePreset} /></section><FormGrid columns="two"><FormField label="Display name" size="wide"><input className="setting-input" value={fileType.name} placeholder={preset.name || "Custom Mod Type"} onChange={(event) => update({ name: event.target.value })} /></FormField><FormField label="Notes" size="wide"><input className="setting-input" value={fileType.description ?? ""} placeholder={preset.description} onChange={(event) => update({ description: event.target.value })} /></FormField></FormGrid><button className="creator-button secondary" type="button" onClick={() => onChange(applyModTypePreset(fileType, presetId))}>Reset This Preset</button></div>;
  }
  function renderFilesStep() {
    return <FileCatalogSelector fileType={fileType} update={update} mode={mode} dryRun={dryRun} />;
  }
  function renderDestinationStep() {
    return <div className="creator-form-stack"><PathSelector label="Install destination" value={fileType.destination} mode={mode} paths={draft.customPaths} sampleRoot={draft.customTest.sampleGameRoot} onChange={(destination) => update({ destination })} dryRun={(label) => dryRun(label, "modTypes")} /><ToggleCards options={[{ label: "Preserve folder structure", description: "Keep archive subfolders below the destination.", checked: fileType.preserveStructure, onChange: (checked) => update({ preserveStructure: checked }) }, { label: "Flatten wrapper folder", description: "Remove one top-level wrapper folder when safe.", checked: fileType.flattenWrapper, onChange: (checked) => update({ flattenWrapper: checked }) }]} /></div>;
  }
  function renderDependencyStep() {
    const existingNames = draft.sections.dependencies.map((dependency) => dependency.title);
    return <section className="creator-builder-section"><header><div><h3>Loader or Dependency</h3><p>Choose the framework this mod type needs, or leave it blank.</p></div></header><DependencyPicker value={fileType.requiredDependency || "None"} update={(requiredDependency) => update({ requiredDependency: requiredDependency === "None" ? "" : requiredDependency })} />{fileType.requiredDependency && !existingNames.includes(fileType.requiredDependency) && <article className="creator-empty-state compact"><strong>{fileType.requiredDependency} is not in Dependencies yet.</strong><p>Add it from the Dependencies section when this profile should validate or install that loader.</p></article>}<FormField label="Existing dependency" size="wide"><select className="setting-input" value={fileType.requiredDependency} onChange={(event) => update({ requiredDependency: event.target.value })}><option value="">No dependency</option>{draft.sections.dependencies.map((dependency) => <option key={dependency.id}>{dependency.title}</option>)}</select></FormField></section>;
  }
  function renderToggleStep() {
    const recipeId = fileType.disableRecipeId ?? inferDisableRecipeId(fileType.enableDisableStrategy);
    const folderLocation = fileType.disabledFolderLocation ?? "profile_disabled_storage";
    const folderName = fileType.disabledFolderName ?? "disabled";
    const renameBehavior = fileType.renameBehavior ?? "after_filename";
    const suffix = fileType.customDisableSuffix ?? ".disabled";
    const moveMode = fileType.toggleMoveMode ?? (recipeId === "move_folder" ? "whole_folder" : "tracked_files");
    const preview = togglePreviewRows(recipeId, fileType.destination || "Install destination", folderLocation, folderName, renameBehavior, suffix, fileType.customRenameRule ?? "", fileType.disabledFolderPath ?? "", moveMode);
    function applyRecipe(value: string) {
      update(recipeFileTypePatch(value as DisableRecipeId));
    }
    return <div className="creator-form-stack"><section className="creator-builder-section"><header><div><h3>Enable and Disable</h3><p>Choose the disable recipe. Tsuki generates the inverse enable behavior from receipt mappings.</p></div></header><OptionCards value={recipeId} options={disableRecipeOptions} onChange={applyRecipe} /><div className="creator-guided-summary"><span>Disable</span><strong>{recipeLabel(recipeId)}</strong><span>Generated enable</span><strong>{generatedEnableBehavior(recipeId)}</strong><span>Uses destination</span><strong>{friendlyPath(fileType.destination || "No destination")}</strong></div></section>{(recipeId === "move_folder" || recipeId === "move_files" || recipeId === "move_and_suffix") && <section className="creator-builder-section"><header><div><h3>Disabled Folder</h3></div></header><FormGrid columns="two"><FormField label="Disabled folder location" size="wide"><select className="setting-input" value={folderLocation} onChange={(event) => update({ disabledFolderLocation: event.target.value as DisabledFolderLocation })}>{disabledFolderLocationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField><FormField label="Disabled folder name" size="wide"><TransferTextInput value={folderName} placeholder="disabled" onChange={(disabledFolderName) => update({ disabledFolderName })} /></FormField><FormField label="Move mode" size="wide"><select className="setting-input" value={moveMode} onChange={(event) => update({ toggleMoveMode: event.target.value as ToggleMoveMode })}>{toggleMoveModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField><FormField label="Conflict behavior" size="wide"><select className="setting-input" value={fileType.disableConflictBehavior ?? "replace_same_receipt"} onChange={(event) => update({ disableConflictBehavior: event.target.value as DisableConflictBehavior })}>{disableConflictOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField></FormGrid><ToggleCards options={[{ label: "Create disabled folder", description: "Create storage only when disabling tracked files.", checked: fileType.createDisabledFolder !== false, onChange: (createDisabledFolder) => update({ createDisabledFolder }) }, { label: "Preserve structure", description: "Keep original relative paths under disabled storage.", checked: fileType.preserveDisabledStructure !== false, onChange: (preserveDisabledStructure) => update({ preserveDisabledStructure }) }, { label: "Track original and disabled paths", description: "Store reversible receipt mappings for every file.", checked: fileType.trackDisabledMapping !== false, onChange: (trackDisabledMapping) => update({ trackDisabledMapping }) }, { label: "Restore exact paths", description: "Enable restores recorded original paths without rescanning.", checked: fileType.restoreExactPaths !== false, onChange: (restoreExactPaths) => update({ restoreExactPaths }) }]} /></section>}{(recipeId === "suffix_files" || recipeId === "move_and_suffix" || recipeId === "rename_main_file") && <section className="creator-builder-section"><header><div><h3>Rename Behavior</h3></div></header><FormGrid columns="two"><FormField label="Rename behavior" size="wide"><select className="setting-input" value={renameBehavior} onChange={(event) => update({ renameBehavior: event.target.value as RenameBehavior })}>{renameBehaviorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField><FormField label="Suffix" size="wide"><TransferTextInput value={suffix} placeholder=".disabled" onChange={(customDisableSuffix) => update({ customDisableSuffix })} /></FormField></FormGrid></section>}<section className="creator-builder-section"><header><div><h3>Live Preview</h3><p>No files are changed from this editor; this is the generated receipt-safe behavior.</p></div></header><div className="creator-guided-summary"><span>Original</span><strong>{preview.original}</strong><span>Disabled</span><strong>{preview.disabled}</strong><span>Enable</span><strong>{preview.enable}</strong></div></section>{mode === "advanced" && <FormField label="Custom behavior" size="wide"><textarea className="setting-input" rows={3} value={fileType.enableDisableStrategy} onChange={(event) => update({ enableDisableStrategy: event.target.value })} /></FormField>}</div>;
  }
  function renderLoadOrderStep() {
    return <div className="creator-form-stack"><PriorityPicker value={fileType.priority} update={(priority) => update({ priority })} /><section className="creator-builder-section"><header><div><h3>Order Method</h3><p>Choose how this loader usually decides order.</p></div></header><PickerCards value={optionValueOrCustom(fileType.loadOrderStrategy, loadOrderOptions)} options={loadOrderOptions} onChange={(loadOrderStrategy) => update({ loadOrderStrategy })} compact />{mode === "advanced" && <FormField label="Raw priority" size="wide"><input className="setting-input" type="number" value={fileType.priority} onChange={(event) => update({ priority: Number(event.target.value) })} /></FormField>}</section></div>;
  }
  function renderConflictStep() {
    return <section className="creator-builder-section"><header><div><h3>Conflicts</h3><p>Pick what Tsuki should do if files overlap.</p></div></header><PickerCards value={optionValueOrCustom(fileType.conflictPolicy, conflictOptions)} options={conflictOptions} onChange={(conflictPolicy) => update({ conflictPolicy })} compact /><FormField label="Conflict behavior" size="wide"><select className="setting-input" value={fileType.conflictPolicy || conflictRulePresets[0]} onChange={(event) => update({ conflictPolicy: event.target.value })}>{conflictRulePresets.map((policy) => <option key={policy}>{policy}</option>)}</select></FormField></section>;
  }
  function renderTestStep() {
    const recipeId = fileType.disableRecipeId ?? inferDisableRecipeId(fileType.enableDisableStrategy);
    return <div className="creator-form-stack"><ValidationCard issues={issues} empty="This mod type has enough information to save." /><div className="creator-rule-preview"><span>Preset</span><strong>{preset.label}</strong><span>Files matching</span><strong>{patterns.join(", ") || "No matcher configured"}</strong><span>Match rule</span><strong>{fileMatchModeOptions.find((option) => option.value === (fileType.fileMatchMode ?? "any"))?.label ?? "Any Selected Type"}</strong><span>Destination</span><strong>{fileType.destination ? friendlyPath(fileType.destination) : "No destination"}</strong><span>Dependency</span><strong>{fileType.requiredDependency || "No dependency"}</strong><span>Disables by</span><strong>{recipeLabel(recipeId)}</strong><span>Enables by</span><strong>{generatedEnableBehavior(recipeId)}</strong><span>Sample test</span><strong>{draft.customTest.sampleFilename || "No sample file"}: {matched ? "matched" : "not matched"}</strong></div><div className="creator-action-row"><button className="creator-button secondary" type="button" onClick={() => setStep(1)}>Edit Files</button><button className="creator-button secondary" type="button" onClick={() => setStep(2)}>Edit Destination</button><button className="creator-button secondary" type="button" onClick={() => setStep(4)}>Edit Enable/Disable</button><button className="creator-button secondary" type="button" onClick={() => setStep(6)}>Edit Conflicts</button></div><div className="creator-test-grid">{["Test With File", "Test With Folder", "Test With Archive", "Dry-Run Install", "Dry-Run Enable", "Dry-Run Disable"].map((label) => <button className="creator-button secondary" type="button" key={label} onClick={() => dryRun(label, "modTypes")}>{label}</button>)}</div></div>;
  }
  function renderStep() {
    if (step === 0) return renderTypeStep();
    if (step === 1) return renderFilesStep();
    if (step === 2) return renderDestinationStep();
    if (step === 3) return renderDependencyStep();
    if (step === 4) return renderToggleStep();
    if (step === 5) return renderLoadOrderStep();
    if (step === 6) return renderConflictStep();
    return renderTestStep();
  }
  return <div className="creator-drawer-backdrop" role="presentation"><aside className={mode === "advanced" ? "creator-editor-sheet technical-editor-sheet" : "creator-editor-sheet"} role="dialog" aria-modal="true" aria-label="Mod type editor"><header className="creator-editor-header"><div><h2>{editor.mode === "add" ? "Add Mod Type" : "Edit Mod Type"}</h2><p>{mode === "advanced" ? `Advanced values remain available. Step ${step + 1} of ${steps.length}: ${steps[step]}` : `Step ${step + 1} of ${steps.length}: ${steps[step]}`}</p></div><button className="creator-button secondary" type="button" onClick={onCancel}>Close</button></header><div className="creator-editor-content"><div className="creator-step-tabs" role="tablist">{steps.map((label, index) => <button className={index === step ? "active" : ""} type="button" key={label} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</div>{renderStep()}{mode === "advanced" && <details className="creator-advanced-panel" open><summary>Advanced Mod Type Data</summary><FormGrid columns="two"><FormField label={`Confidence ${fileType.confidence}%`} size="wide"><input type="range" min="0" max="100" value={fileType.confidence} onChange={(event) => update({ confidence: Number(event.target.value) })} /></FormField><FormField label="Case sensitive" size="wide"><select className="setting-input" value={fileType.caseSensitive ? "Yes" : "No"} onChange={(event) => update({ caseSensitive: event.target.value === "Yes" })}><option>No</option><option>Yes</option></select></FormField></FormGrid><textarea className="setting-input creator-code-box" readOnly value={JSON.stringify(fileType, null, 2)} /></details>}</div><footer className="creator-editor-footer"><div className="creator-editor-footer-left"><button className="creator-button secondary" type="button" disabled={!canGoBack} onClick={() => setStep(Math.max(0, step - 1))}>Back</button></div><div className="creator-editor-footer-right"><button className="creator-button secondary" type="button" onClick={onCancel}>Cancel</button><button className="creator-button primary" type="button" disabled={issues.some((issue) => issue.level === "error")} onClick={onSave}>Save Mod Type</button><button className="creator-button secondary" type="button" onClick={() => canGoNext ? setStep(Math.min(steps.length - 1, step + 1)) : onSave()}>{canGoNext ? "Next" : "Done"}</button></div></footer></aside></div>;
}
function GenericItemSheet({ entry, index, section, mode, setDraft, close, dryRun }: { entry: Item; index: number; section: SectionId; mode: Mode; setDraft: Dispatch<SetStateAction<Draft>>; close: () => void; dryRun: (label: string, section?: SectionId) => void }) {
  function update(next: Item) { setDraft((current) => { const rows = [...current.sections[section]]; rows[index] = next; return { ...current, sections: { ...current.sections, [section]: rows } }; }); }
  return <SheetFrame title={entry.title} subtitle={sectionInfo.find((sectionInfoItem) => sectionInfoItem.id === section)?.label ?? "Editor"} close={close}><div className="creator-form-stack"><label>Name<input className="setting-input" value={entry.title} onChange={(event) => update({ ...entry, title: event.target.value })} /></label><label>Summary<textarea className="setting-input" value={entry.summary} onChange={(event) => update({ ...entry, summary: event.target.value })} /></label>{entry.fields.map((field) => { const readOnly = mode === "guided" && /id|key|priority|url/i.test(field.label); return <label key={field.label}>{field.label}<TransferTextInput value={readOnly ? friendlyFieldValue(field, mode) : field.value} readOnly={readOnly} imageOnly={isImageFieldLabel(field.label)} onChange={(value) => update(replaceField(entry, field.label, value))} /></label>; })}<button className="creator-button secondary" type="button" onClick={() => dryRun(`Test ${entry.title}`, section)}>Dry-Run</button></div></SheetFrame>;
}
const legacyProfileCreatorPanels = [CustomPathEditor, CustomFileTypeEditor, TestPanel, Advanced, Review];
void legacyProfileCreatorPanels;

function nice(value: string) {
  return value.replace(/_/g, " ").replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()).replace(/([a-z])([0-9])/gi, "$1 $2");
}
