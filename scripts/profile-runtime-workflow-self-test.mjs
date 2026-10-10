import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const lib = read("src-tauri/src/lib.rs");
const creator = read("src/pages/ProfileCreator/ProfileCreatorPage.tsx");
const app = read("src/App.tsx");

const checks = [
  ["backend open runtime command", lib.includes("fn open_game_profile_draft_runtime")],
  ["backend setup preview command", lib.includes("fn preview_game_profile_setup")],
  ["backend shared creator test command", lib.includes("fn run_profile_creator_test_action")],
  ["profile scoped data root", lib.includes("profile-data")],
  ["profile scoped receipts", lib.includes("\"receipts\"")],
  ["profile scoped source index", lib.includes("source-index")],
  ["profile setup state file", lib.includes("setup-state.json")],
  ["profile installed state file", lib.includes("installed-state.json")],
  ["creator open profile action", creator.includes("openProfileRuntime(false)")],
  ["creator setup preview action", creator.includes("openProfileRuntime(true)")],
  ["creator tests use backend", creator.includes("run_profile_creator_test_action")],
  ["fake frontend dry-run message removed", !creator.includes("No files were written") && !creator.includes("completed as a dry run")],
  ["app draft runtime callback", app.includes("openDraftRuntimeProfile")],
  ["app draft banner", app.includes("draft-runtime-banner") && app.includes("Return to Profile Creator")],
  ["runtime command registered", lib.includes("activate_game_profile_runtime,")],
  ["draft list command registered", lib.includes("list_game_profile_drafts,")],
  ["creator support commands registered", lib.includes("save_profile_artwork_data_url,") && lib.includes("scan_game_folder_basic,")],
  ["mod profiles require gameProfileId", app.includes('"list_mod_profiles", { gameProfileId: currentGameProfile.profileId }') && app.includes('"save_current_mod_profile", { name: name || `Profile ${new Date().toLocaleString()}`, gameProfileId: currentGameProfile.profileId }')],
  ["mod profile page excludes game drafts", !app.includes("draftGameProfiles") && !app.includes("Custom game drafts")],
  ["backend active mod profile map", lib.includes("active_mod_profile_by_game_profile_id")],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
}

if (failed.length) {
  console.error(`\n${failed.length} workflow check(s) failed.`);
  process.exit(1);
}
