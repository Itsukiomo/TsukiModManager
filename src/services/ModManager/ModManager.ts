export class ModManager {
  async initialize() {
    // Future single entry point for app startup.
  }

  async scanInstalledMods() {
    // Future: call ScannerService, update database, refresh app state.
  }

  async copyDebugReport() {
    // Future: call Logger and backend debug command.
  }
}

export const modManager = new ModManager();
