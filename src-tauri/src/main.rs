// Prevents additional console windows on Windows for both dev and release builds.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    tsukimodmanagerapp_lib::run()
}
