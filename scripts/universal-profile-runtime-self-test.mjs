import assert from "node:assert/strict";
import fs from "node:fs";

const backend = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
const runtime = fs.readFileSync("src-tauri/src/profile_installs.rs", "utf8");
const dragDrop = fs.readFileSync("src/components/DragDropInstallWizard.tsx", "utf8");

for (const command of ["analyze_drag_drop_install", "install_drag_drop_item"]) {
  assert(backend.includes(`profile_installs::${command}`), `${command} is not registered with Tauri`);
  assert(runtime.includes(`fn ${command}`), `${command} backend implementation is missing`);
}

assert(runtime.includes('join("receipts")'), "Profile-scoped receipt storage is missing");
assert(runtime.includes('join("disabled-state")'), "Profile-scoped disabled storage is missing");
assert(runtime.includes("apply_profile_receipt_selection"), "Universal preset application is missing");
assert(runtime.includes("Install rolled back after an error"), "Install rollback guard is missing");
assert(runtime.includes("Rollback errors"), "Toggle rollback guard is missing");
assert(runtime.includes("evaluate_profile_dependencies"), "Profile dependency detection is missing");
assert(runtime.includes("missing_dependencies_for_install"), "Dependency install gating is missing");
assert(runtime.includes("receipt_owner_map"), "Receipt-aware destination ownership checks are missing");
assert(runtime.includes('join("install-overwrites")'), "Overwrite backup storage is missing");
assert(runtime.includes("rollback_profile_install"), "Overwrite rollback restoration is missing");
assert(backend.includes("profile_installs::apply_profile_receipt_selection"), "Non-PAYDAY preset application is not wired");
assert(backend.includes("profile_installs::get_profile_dependency_report"), "Custom dependency reports are not wired");
assert(!backend.includes("This game profile has no PAYDAY 3 file mutations"), "Old non-PAYDAY preset no-op remains");
assert(dragDrop.includes("getCurrentWebview().onDragDropEvent"), "Native Tauri file-drop listener is missing");
assert(dragDrop.includes("allowOverwrite"), "Overwrite confirmation is not sent to the backend");
assert(dragDrop.includes("requiresOverwriteConfirmation"), "Overwrite confirmation UI is missing");

console.log("Universal profile runtime self-test passed.");
