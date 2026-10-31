//! The Windows half of local shells: PowerShell, pwsh, Command Prompt and WSL
//! distros, hosted over a Windows pseudo-console (ConPTY).

use portable_pty::CommandBuilder;

use super::LocalShell;

/// Detects the local shells: PowerShell (always present on Windows), pwsh if
/// installed, Command Prompt, and each installed WSL distro. Blocking, spawns
/// wsl.exe; only run via `list_local_shells_cached`.
pub(super) fn detect() -> Vec<LocalShell> {
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
/// [`super::build_command`] is careful never to do.
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

/// The process for one of the shells [`detect`] offers, or `None` for an id
/// that is not one of them. The three shells we launch ourselves are put into
/// UTF-8 on the way up; see [`CHCP_UTF8_CMD`] for why that is necessary and
/// why WSL is left alone.
pub(super) fn builtin_command(shell_id: &str) -> Option<CommandBuilder> {
    if let Some(distro) = shell_id.strip_prefix("wsl:") {
        let mut c = CommandBuilder::new("wsl.exe");
        c.arg("-d");
        c.arg(distro);
        return Some(c);
    }
    match shell_id {
        "powershell" => Some(utf8_powershell("powershell.exe")),
        "pwsh" => Some(utf8_powershell("pwsh.exe")),
        "cmd" => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/k");
            c.arg(CHCP_UTF8_CMD);
            Some(c)
        }
        _ => None,
    }
}

/// Where a shell starts when no profile says otherwise. For a WSL shell this
/// sets wsl.exe's Windows working directory, which the distro then starts in
/// (translated to its /mnt path).
pub(super) fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}
