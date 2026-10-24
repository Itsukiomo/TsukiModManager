use std::{ffi::c_void, ptr};

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
}

#[link(name = "user32")]
extern "system" {
    fn LoadImageW(instance: *mut c_void, name: *const u16, kind: u32, width: i32, height: i32, flags: u32) -> *mut c_void;
    fn SendMessageW(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}

pub(crate) fn apply(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as *mut c_void;
    // Tauri embeds the configured ICO as resource 32512. Its set_icon API only
    // sets ICON_SMALL; Windows uses the separate ICON_BIG slot for the taskbar.
    // LR_SHARED keeps the resource-owned handle alive without caller destruction.
    let icon = unsafe { LoadImageW(GetModuleHandleW(ptr::null()), 32512usize as *const u16, 1, 0, 0, 0x8040) };
    if icon.is_null() {
        return Err(format!("Taskbar icon resource could not load: {}", std::io::Error::last_os_error()));
    }
    unsafe {
        SendMessageW(hwnd, 0x0080, 1, icon as isize);
        if SendMessageW(hwnd, 0x007f, 1, 0) != icon as isize {
            return Err("Windows did not retain the taskbar icon".into());
        }
    }
    Ok(())
}
