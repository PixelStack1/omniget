fn enhanced_path() -> Option<String> {
    use std::sync::OnceLock;
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let bin_dir = crate::core::paths::app_data_dir()?.join("bin");
            let sep = if cfg!(windows) { ";" } else { ":" };
            let current = std::env::var("PATH").unwrap_or_default();

            #[allow(unused_mut)]
            let mut extra_dirs: Vec<String> = vec![bin_dir.display().to_string()];

            #[cfg(target_os = "macos")]
            {
                extra_dirs.push("/opt/homebrew/bin".into());
                extra_dirs.push("/usr/local/bin".into());
            }

            #[cfg(target_os = "linux")]
            {
                if let Some(home) = dirs::home_dir() {
                    extra_dirs.push(home.join(".local").join("bin").display().to_string());
                }
                extra_dirs.push("/usr/local/bin".into());
            }

            Some(format!("{}{}{}", extra_dirs.join(sep), sep, current))
        })
        .clone()
}

/// Removes `LD_LIBRARY_PATH` entries that point inside the AppImage mount
/// (`$APPDIR`). The AppImage runtime prepends its bundled libraries, which
/// breaks system binaries such as `python3` (`import ssl`) and `ffmpeg` when
/// they are spawned as child processes. Empty entries are dropped as well.
/// Returns `None` when no entry remains, meaning the variable should be unset.
/// When `appdir` is `None` or empty, the value is returned unchanged.
fn filter_ld_library_path(value: &str, appdir: Option<&str>) -> Option<String> {
    let appdir = match appdir.map(|a| a.trim_end_matches('/')) {
        Some(a) if !a.is_empty() => a,
        _ => return Some(value.to_string()),
    };
    let kept: Vec<&str> = value
        .split(':')
        .filter(|entry| !entry.is_empty())
        .filter(|entry| !std::path::Path::new(entry).starts_with(appdir))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(":"))
    }
}

/// Applies [`filter_ld_library_path`] to the current environment and returns
/// the value the child should get: `Some(v)` to set, `None` to remove, or
/// `Err(())` to leave the inherited variable untouched.
fn child_ld_library_path() -> Result<Option<String>, ()> {
    let appdir = std::env::var("APPDIR")
        .ok()
        .filter(|a| !a.is_empty())
        .ok_or(())?;
    let current = std::env::var("LD_LIBRARY_PATH").map_err(|_| ())?;
    Ok(filter_ld_library_path(&current, Some(&appdir)))
}

pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    if let Some(path) = enhanced_path() {
        cmd.env("PATH", path);
    }
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    match child_ld_library_path() {
        Ok(Some(v)) => {
            cmd.env("LD_LIBRARY_PATH", v);
        }
        Ok(None) => {
            cmd.env_remove("LD_LIBRARY_PATH");
        }
        Err(()) => {}
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONLEGACYWINDOWSSTDIO", "0");
    cmd
}

pub fn std_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Some(path) = enhanced_path() {
        cmd.env("PATH", path);
    }
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
    match child_ld_library_path() {
        Ok(Some(v)) => {
            cmd.env("LD_LIBRARY_PATH", v);
        }
        Ok(None) => {
            cmd.env_remove("LD_LIBRARY_PATH");
        }
        Err(()) => {}
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONLEGACYWINDOWSSTDIO", "0");
    cmd
}

#[cfg(test)]
mod tests {
    use super::filter_ld_library_path;

    #[test]
    fn appdir_unset_leaves_value_unchanged() {
        assert_eq!(
            filter_ld_library_path("/tmp/.mount_x/usr/lib:/usr/lib", None),
            Some("/tmp/.mount_x/usr/lib:/usr/lib".to_string())
        );
        assert_eq!(
            filter_ld_library_path("/a:/b", Some("")),
            Some("/a:/b".to_string())
        );
    }

    #[test]
    fn all_entries_in_appdir_are_removed() {
        assert_eq!(
            filter_ld_library_path(
                "/tmp/.mount_x/usr/lib:/tmp/.mount_x/lib",
                Some("/tmp/.mount_x")
            ),
            None
        );
    }

    #[test]
    fn mixed_keeps_only_external_entries() {
        assert_eq!(
            filter_ld_library_path(
                "/tmp/.mount_x/usr/lib:/opt/cuda/lib64:/tmp/.mount_x/lib:/usr/local/lib",
                Some("/tmp/.mount_x/")
            ),
            Some("/opt/cuda/lib64:/usr/local/lib".to_string())
        );
    }

    #[test]
    fn similar_prefix_outside_appdir_is_kept() {
        assert_eq!(
            filter_ld_library_path("/tmp/.mount_xy/lib", Some("/tmp/.mount_x")),
            Some("/tmp/.mount_xy/lib".to_string())
        );
    }

    #[test]
    fn empty_entries_are_dropped() {
        assert_eq!(
            filter_ld_library_path("::/usr/lib::/tmp/.mount_x/lib:", Some("/tmp/.mount_x")),
            Some("/usr/lib".to_string())
        );
        assert_eq!(filter_ld_library_path("", Some("/tmp/.mount_x")), None);
    }
}
