//! Local shell sessions (PowerShell / pwsh / Command Prompt / WSL distros) hosted
//! over a Windows pseudo-console (ConPTY) via `portable-pty`, surfaced as terminal
//! tabs alongside SSH sessions. This reuses the SAME session plumbing as the SSH
//! path (`crate::ssh::pty`): the `PtyState` registry, the `SessionCmd`
//! write/resize/close channel, and the `pty:data` / `pty:closed` events. Only the
//! data SOURCE differs (a local child process instead of an SSH channel), so the
//! frontend's `pty_write`/`pty_resize`/`pty_close` and xterm rendering are
//! identical. None of the SSH-only machinery (host-key trust, sudo auto-fill,
//! guard rules, MultiTerminal blocks) applies to local shells.

use std::io::{Read, Write};

use portable_pty::{CommandBuilder, PtySize};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::ssh::pty::{PtyClosed, PtyData, PtyEvents, PtyState, SessionCmd};

/// A launchable local shell discovered on this machine.
#[derive(Debug, Clone, Serialize)]
pub struct LocalShell {
    /// Stable id used to launch it: `powershell`, `pwsh`, `cmd`, or
    /// `wsl:<distro>` (e.g. `wsl:Ubuntu-24.04`).
    pub id: String,
    /// Human label for the launcher menu.
    pub label: String,
    /// Coarse kind for the UI icon: `powershell` | `pwsh` | `cmd` | `wsl`.
    pub kind: String,
}

/// Shell detection result, computed once per launch (below). Detection spawns
/// `wsl.exe`, which can take seconds when the WSL service is cold, so it must
/// only ever run on a blocking thread, never on the main/IPC thread (a sync
/// command doing this froze every in-flight IPC call AND the event loop, which
/// was the multi-second Settings-spinner / launch-hitch bug).
static SHELLS: tokio::sync::OnceCell<Vec<LocalShell>> = tokio::sync::OnceCell::const_new();

/// Lists the local shells available on this machine, cached for the app's
/// lifetime (the set effectively never changes mid-run; re-detecting per call
/// paid the wsl.exe cost every time). Concurrent first callers share one
/// detection run. Call `prewarm_shells` at startup so this is already resolved
/// by the time any page asks.
pub async fn list_local_shells_cached() -> Vec<LocalShell> {
    SHELLS
        .get_or_init(|| async {
            tauri::async_runtime::spawn_blocking(detect_local_shells)
                .await
                .unwrap_or_default()
        })
        .await
        .clone()
}

/// Kicks off shell detection in the background at startup, so the first real
/// caller (Terminals launcher, Settings Appearance) gets a cache hit.
pub fn prewarm_shells() {
    tauri::async_runtime::spawn(async {
        let _ = list_local_shells_cached().await;
    });
}

/// Detects the local shells: PowerShell (always present on Windows), pwsh if
/// installed, Command Prompt, and each installed WSL distro. Blocking, spawns
/// wsl.exe; only run via `list_local_shells_cached`.
fn detect_local_shells() -> Vec<LocalShell> {
    let mut shells = vec![LocalShell {
        id: "powershell".into(),
        label: "PowerShell".into(),
        kind: "powershell".into(),
    }];
    if on_path("pwsh.exe") {
        shells.push(LocalShell {
            id: "pwsh".into(),
            label: "PowerShell 7 (pwsh)".into(),
            kind: "pwsh".into(),
        });
    }
    shells.push(LocalShell {
        id: "cmd".into(),
        label: "Command Prompt".into(),
        kind: "cmd".into(),
    });
    for distro in list_wsl_distros() {
        shells.push(LocalShell {
            id: format!("wsl:{distro}"),
            label: format!("WSL: {distro}"),
            kind: "wsl".into(),
        });
    }
    shells
}

/// Whether `exe` resolves on PATH, searched in-process (no `where.exe` spawn;
/// process spawns from a GUI app pay conhost startup and AV scanning).
fn on_path(exe: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| !dir.as_os_str().is_empty() && dir.join(exe).is_file())
}

/// Installed WSL distro names, from `wsl.exe -l -q` (which emits UTF-16LE).
fn list_wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    // Don't create a console for the child: avoids conhost startup cost and a
    // possible window flash (this app is a windows-subsystem GUI process).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = match std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    decode_utf16le(&output)
        .lines()
        .map(|l| l.trim().trim_matches('\0').trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Decode WSL's UTF-16LE output (with an optional BOM) to a String.
fn decode_utf16le(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// A user-defined terminal application resolved from the database, ready to
/// launch. The command layer looks a `custom:<id>` shell id up and hands the
/// row's stored program and arguments over; nothing here ever sees a path that
/// came from the frontend.
pub struct CustomLaunch {
    pub exe_path: String,
    pub args: Vec<String>,
}

/// Put the console into UTF-8 before anything is typed into it, quietly.
///
/// A ConPTY does **not** come up in UTF-8. Measured, on this machine and every
/// other Windows box: `CreatePseudoConsole` starts at the system OEM code page,
/// 437 on a US install, and it does not inherit ours, so there is nothing we
/// can set on our side of the pipe to change it. Everything a program writes is
/// then decoded as 437 and re-encoded as UTF-8 on the way out, which turns the
/// four characters a rounded box is drawn with, `╭─╮`, into `Γò¡ΓöÇΓò«`. That
/// is the "mangled logo": `claude` is a node program writing raw UTF-8, and so
/// is most of what an operator runs.
///
/// The code page has to be in force *before* the writing program starts, not
/// merely before it prints: a console program caches its encoding when it
/// launches. Running this at shell startup is exactly right for that, because
/// every command typed afterwards is a fresh child of a console that is already
/// UTF-8. Running it any later would fix nothing already on screen and nothing
/// already running.
///
/// Only the three shells we launch ourselves get this. `wsl.exe` puts the
/// console into UTF-8 on its own account, and a custom terminal is the
/// operator's own program: wrapping it would mean building a command *string*
/// out of a path and arguments they supplied, which is the one thing
/// [`build_command`] is careful never to do.
const CHCP_UTF8_CMD: &str = "chcp 65001 >nul";

/// The same thing in PowerShell's language. `>nul` is cmd's null device and
/// PowerShell would take it for a file of that name, so the redirect differs
/// even though the command does not.
const CHCP_UTF8_PS: &str = "chcp 65001 > $null";

/// PowerShell, with the console *and* PowerShell's own encoder in UTF-8.
///
/// The `chcp` alone is not enough here, because PowerShell caches
/// `[Console]::OutputEncoding` at startup exactly as cmd does, so its own
/// output would go on being encoded at 437 while its children were fine. Both
/// lines are needed and neither prints anything.
///
/// `-Command` runs after the profile, so an operator's own `$PROFILE` still
/// loads first; `-NoExit` is what keeps the shell interactive afterwards, which
/// is the whole point of a terminal tab.
fn utf8_powershell(exe: &str) -> CommandBuilder {
    let mut c = CommandBuilder::new(exe);
    c.arg("-NoExit");
    c.arg("-Command");
    c.arg(format!(
        "{CHCP_UTF8_PS}; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"
    ));
    c
}

/// Map a shell id to the process to launch. `cwd` is the directory to start the
/// shell in (a saved profile's working directory); when absent the shell opens
/// in the user's home directory rather than the app's working dir.
///
/// `custom` must be supplied for a `custom:<id>` shell id and is ignored
/// otherwise. Its arguments are passed as argv, one `.arg()` each, so nothing
/// is handed to a shell to re-parse and there is no quoting to get wrong.
///
/// The three shells we launch ourselves are also put into UTF-8 on the way up;
/// see [`CHCP_UTF8_CMD`] for why that is necessary and why WSL and custom
/// terminals are left alone.
fn build_command(
    shell_id: &str,
    cwd: Option<&str>,
    custom: Option<&CustomLaunch>,
) -> AppResult<CommandBuilder> {
    let mut cmd = if let Some(distro) = shell_id.strip_prefix("wsl:") {
        let mut c = CommandBuilder::new("wsl.exe");
        c.arg("-d");
        c.arg(distro);
        c
    } else if shell_id.starts_with("custom:") {
        let Some(custom) = custom else {
            // Only reachable if a caller forgot to resolve the row, which would
            // be a bug here rather than bad input. Refusing to launch is the
            // only safe answer.
            return Err(AppError::InvalidInput(format!(
                "custom terminal not resolved: {shell_id}"
            )));
        };
        let mut c = CommandBuilder::new(&custom.exe_path);
        for a in &custom.args {
            c.arg(a);
        }
        c
    } else {
        match shell_id {
            "powershell" => utf8_powershell("powershell.exe"),
            "pwsh" => utf8_powershell("pwsh.exe"),
            "cmd" => {
                let mut c = CommandBuilder::new("cmd.exe");
                c.arg("/k");
                c.arg(CHCP_UTF8_CMD);
                c
            }
            other => {
                return Err(AppError::InvalidInput(format!(
                    "unknown local shell: {other}"
                )))
            }
        }
    };
    // A profile's working directory wins; a blank/whitespace one counts as unset.
    // For a WSL shell this sets wsl.exe's Windows working directory, which the
    // distro then starts in (translated to its /mnt path). We don't verify the
    // path exists here, the shell surfaces its own error, and the UI validates
    // before saving. Falls back to USERPROFILE so a shell never inherits the
    // app's own working directory.
    let cwd = cwd.map(str::trim).filter(|s| !s.is_empty());
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    } else if let Ok(home) = std::env::var("USERPROFILE") {
        cmd.cwd(home);
    }
    Ok(cmd)
}

fn pty_size(cols: u32, rows: u32) -> PtySize {
    PtySize {
        rows: rows as u16,
        cols: cols as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Spawns a local shell over ConPTY and wires it into the shared session
/// registry, emitting `pty:data` as output streams and `pty:closed` when the
/// shell exits. The blocking ConPTY reader/waiter run on dedicated threads and
/// feed an async task that also services the write/resize/close channel.
pub fn open_local<E: PtyEvents>(
    events: E,
    state: &PtyState,
    session_id: String,
    shell_id: &str,
    cwd: Option<&str>,
    custom: Option<&CustomLaunch>,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    let cmd = build_command(shell_id, cwd, custom)?;
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows))
        .map_err(|e| AppError::State(format!("open pty: {e}")))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::State(format!("spawn local shell: {e}")))?;
    // Drop the slave in this process so the child holds the only slave handle:
    // its exit then closes the pty and the reader sees EOF.
    drop(pair.slave);

    let mut killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::State(format!("pty reader: {e}")))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::State(format!("pty writer: {e}")))?;
    let master = pair.master; // kept for resize

    let (epoch, mut rx) = state.register(session_id.clone());
    let state = state.clone();

    // Blocking reader thread → forwards output bytes to the async task. Dropping
    // `data_tx` (on EOF) signals the async task that output has ended.
    let (data_tx, mut data_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if data_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Blocking waiter thread → reports the child's exit code once.
    let (exit_tx, mut exit_rx) = tokio::sync::mpsc::channel::<Option<u32>>(1);
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        let _ = exit_tx.blocking_send(code);
    });

    tauri::async_runtime::spawn(async move {
        let mut exit_code: Option<u32> = None;
        let mut message: Option<String> = None;
        let mut reader_done = false;

        let emit = |session_id: &str, bytes: &[u8], events: &E| {
            events.data(PtyData {
                session_id: session_id.to_string(),
                data: bytes.to_vec(),
            });
        };

        loop {
            tokio::select! {
                // `if !reader_done` stops us busy-looping once the reader EOFs.
                data = data_rx.recv(), if !reader_done => match data {
                    Some(bytes) => emit(&session_id, &bytes, &events),
                    None => reader_done = true,
                },
                code = exit_rx.recv() => {
                    exit_code = code.flatten();
                    break;
                }
                cmd = rx.recv() => match cmd {
                    Some(SessionCmd::Write(d)) => {
                        if let Err(e) = writer.write_all(&d).and_then(|_| writer.flush()) {
                            message = Some(format!("write failed: {e}"));
                            break;
                        }
                    }
                    Some(SessionCmd::Resize { cols, rows }) => {
                        let _ = master.resize(pty_size(cols, rows));
                    }
                    Some(SessionCmd::Close) | None => break,
                },
            }
        }

        // The child has exited (or we were told to close). Kill to be safe, then
        // DROP the pty handles so the blocking reader thread sees EOF. Without
        // this, a ConPTY whose output pipe stays open while `master` is alive
        // keeps the reader parked in read(), `data_tx` is never dropped, and the
        // drain below would await forever -- so we'd never reach the pty:closed
        // emit and the local-shell tab would never show its closed banner (the
        // SSH path is separate, which is why only local shells were affected).
        let _ = killer.kill();
        drop(writer);
        drop(master);

        // Flush any output still in flight, but never wait indefinitely: stop on
        // EOF (reader gone) or after a short idle gap, then always report close.
        loop {
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                data_rx.recv(),
            )
            .await
            {
                Ok(Some(bytes)) => emit(&session_id, &bytes, &events),
                Ok(None) => break,
                Err(_) => break,
            }
        }

        // Only report if the entry is still ours (a re-open with the same id, or a
        // deliberate close, must not emit a stray pty:closed).
        if state.remove_if_current(&session_id, epoch) {
            events.closed(PtyClosed {
                session_id: session_id.clone(),
                exit_code,
                message,
            });
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arguments a `CommandBuilder` was given, as plain strings. `get_argv`
    /// includes the program itself at index 0.
    fn args_of(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv()
            .iter()
            .skip(1)
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn cmd_starts_in_utf8() {
        let cmd = build_command("cmd", None, None).unwrap();
        assert_eq!(args_of(&cmd), vec!["/k", "chcp 65001 >nul"]);
    }

    #[test]
    fn powershell_starts_in_utf8_and_stays_interactive() {
        for id in ["powershell", "pwsh"] {
            let cmd = build_command(id, None, None).unwrap();
            let args = args_of(&cmd);
            assert_eq!(args[0], "-NoExit", "{id} must stay interactive");
            assert_eq!(args[1], "-Command");
            // PowerShell's null device, not cmd's: `>nul` would be taken for a
            // file of that name and leave one in the operator's home directory.
            assert!(
                args[2].starts_with("chcp 65001 > $null;"),
                "{id}: {}",
                args[2]
            );
            // The console alone is not enough. PowerShell caches its own
            // encoder at startup exactly as cmd does, so without this its
            // output would go on being written at 437 while its children were
            // already fine.
            assert!(
                args[2].contains("[Console]::OutputEncoding"),
                "{id}: {}",
                args[2]
            );
        }
    }

    /// WSL and custom terminals are deliberately left alone. WSL puts the
    /// console into UTF-8 itself, and a custom terminal is the operator's own
    /// program: the only way to prepend a command to it would be to build a
    /// shell *string* out of the path and arguments they gave us, which is the
    /// one thing `build_command` is careful never to do.
    #[test]
    fn wsl_and_custom_are_launched_untouched() {
        let cmd = build_command("wsl:Ubuntu", None, None).unwrap();
        assert_eq!(args_of(&cmd), vec!["-d", "Ubuntu"]);

        let custom = CustomLaunch {
            exe_path: r"C:\Program Files\Git\bin\bash.exe".into(),
            args: vec!["--login".into(), "-i".into()],
        };
        let cmd = build_command("custom:7", None, Some(&custom)).unwrap();
        assert_eq!(args_of(&cmd), vec!["--login", "-i"]);
    }
}
