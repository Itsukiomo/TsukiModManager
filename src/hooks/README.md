# Hooks

React hooks live here.

Do not put file system logic in hooks.
Hooks may call frontend services, but the real file operations must go through Tauri/Rust commands.
