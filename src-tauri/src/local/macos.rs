//! The macOS half of local shells: the shells the system lists in `/etc/shells`
//! (zsh, bash and friends, plus any Homebrew shell registered there), each run as
//! a login shell over a Unix pseudo-terminal.
//!
//! A shell is launched by name (`unix:zsh`) and the name is looked up in the
//! list found here, so the frontend never hands a program path across IPC, the
//! same rule `custom:<id>` follows.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use portable_pty::CommandBuilder;

use super::LocalShell;

/// A shell found on this Mac: the name it is launched by and the program.
struct Shell {
    name: String,
    path: PathBuf,
}

/// Found once per launch. Reading one small file is cheap, but the login shell
/// may need a `dscl` lookup, and the list has to be the same one the launcher
/// was shown when a tab is opened from it.
static SHELLS: OnceLock<Vec<Shell>> = OnceLock::new();

fn shells() -> &'static [Shell] {
    SHELLS.get_or_init(find_shells)
}

/// The operator's login shell first, then every other shell `/etc/shells`
/// lists that is really there, one per name. `/etc/shells` is the system's own
/// list of what counts as a login shell, and `chsh` and Homebrew's instructions
/// both go through it, so a fish the operator uses is in it.
fn find_shells() -> Vec<Shell> {
    let mut paths: Vec<PathBuf> = login_shell().into_iter().collect();
    if let Ok(text) = std::fs::read_to_string("/etc/shells") {
        paths.extend(
            text.lines()
                .map(str::trim)
                .filter(|l| l.starts_with('/'))
                .map(PathBuf::from),
        );
    }
    // Every Mac since Catalina has it, and a launcher with nothing in it would
    // be a stranger failure than a list of one.
    paths.push(PathBuf::from("/bin/zsh"));

    let mut found: Vec<Shell> = Vec::new();
    for path in paths {
        if !is_program(&path) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if found.iter().any(|s| s.name == name) {
            continue;
        }
        found.push(Shell { name, path });
    }
    found
}

/// The login shell. `SHELL` is what launchd gives an app it starts; the
/// directory service is the source it comes from, asked only when it is unset.
fn login_shell() -> Option<PathBuf> {
    if let Some(shell) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(shell));
    }
    let user = std::env::var("USER").ok()?;
    let out = std::process::Command::new("/usr/bin/dscl")
        .args([".", "-read", &format!("/Users/{user}"), "UserShell"])
        .output()
        .ok()?;
    // "UserShell: /bin/zsh"
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .nth(1)
        .map(PathBuf::from)
}

/// A regular file someone may execute.
fn is_program(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The local shells, login shell first. Labels are the shells' own names,
/// which is what a Mac user calls them.
pub(super) fn detect() -> Vec<LocalShell> {
    shells()
        .iter()
        .map(|s| LocalShell {
            id: format!("unix:{}", s.name),
            label: s.name.clone(),
            kind: "posix".into(),
        })
        .collect()
}

/// Variables a terminal app sets for its own sessions. Under `tauri dev` the
/// app inherits them from the terminal it was started in, and a shell that is
/// told it is running in iTerm2 or Terminal.app will act on it (shell
/// integration, title escapes). A release launched from Finder has none.
const INHERITED_TERMINAL_VARS: [&str; 8] = [
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "COLORFGBG",
];

/// The process for one of the shells [`detect`] offers, or `None` for an id
/// that is not one of them (which includes anything with a path in it).
///
/// `-l` makes it a login shell, as Terminal.app does: an app started from the
/// Dock gets launchd's bare PATH, and it is the login profile (`path_helper`
/// in `/etc/zprofile`, Homebrew's `shellenv`) that puts the operator's tools on
/// it. zsh, bash, sh, dash, ksh, csh, tcsh and fish all take `-l`.
pub(super) fn builtin_command(shell_id: &str) -> Option<CommandBuilder> {
    let name = shell_id.strip_prefix("unix:")?;
    let shell = shells().iter().find(|s| s.name == name)?;
    let mut c = CommandBuilder::new(&shell.path);
    c.arg("-l");
    set_terminal_env(&mut c);
    Some(c)
}

/// Tells a program what terminal it is running on, for the built-in shells and
/// custom terminals alike: the terminal is Broadside's, whoever's program is in
/// it. This is the Mac's half of what `chcp 65001` is on Windows.
///
/// A GUI app has no `TERM`, so curses programs would not know what they are
/// drawing on, and PowerShell's line editor would have no way to move the
/// cursor: every keystroke would print a fresh copy of the line after the old
/// one (`i> if> ifc`) instead of redrawing it. It usually has no `LANG` either,
/// so a shell would treat every byte above 127 as unprintable and `╭─╮` would
/// come out as escapes.
pub(super) fn set_terminal_env(c: &mut CommandBuilder) {
    c.env("TERM", "xterm-256color");
    c.env("COLORTERM", "truecolor");
    for var in INHERITED_TERMINAL_VARS {
        c.env_remove(var);
    }
    let has_locale = ["LANG", "LC_ALL", "LC_CTYPE"]
        .iter()
        .any(|v| std::env::var_os(v).is_some_and(|s| !s.is_empty()));
    if !has_locale {
        c.env("LANG", utf8_locale());
    }
}

/// A UTF-8 locale in the operator's own language, `en_GB.UTF-8` for a British
/// Mac. `LANG` rather than a bare `LC_CTYPE=UTF-8` (which is what Terminal.app
/// falls back to) because ssh's default config sends `LANG` and `LC_*` on to
/// the server, and a Linux server has no locale called `UTF-8`: every ssh from
/// a local tab would start with a setlocale warning.
fn utf8_locale() -> &'static str {
    static LOCALE: OnceLock<String> = OnceLock::new();
    LOCALE.get_or_init(|| {
        let apple = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleLocale"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        // "en_GB" or "en_GB@rg=gbzzzz"; the region override is not a locale.
        let base = apple.split('@').next().unwrap_or("");
        let candidate = format!("{base}.UTF-8");
        if !base.is_empty() && Path::new("/usr/share/locale").join(&candidate).is_dir() {
            candidate
        } else {
            "en_US.UTF-8".to_string()
        }
    })
}

/// Where a shell starts when no profile says otherwise.
pub(super) fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Where the PowerShell installers put `pwsh`: Homebrew on Apple silicon, then
/// on Intel, then Microsoft's own `.pkg` (which also links `/usr/local/bin`).
const PWSH_PLACES: [&str; 3] = [
    "/opt/homebrew/bin/pwsh",
    "/usr/local/bin/pwsh",
    "/usr/local/microsoft/powershell/7/pwsh",
];

/// How long the login shell gets to say where `pwsh` is. A profile that waits
/// on the network can take a while, and the answer is only ever a nicety.
const LOGIN_LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether PowerShell 7 is on this Mac, for whether the app talks about it at
/// all. `custom` is the programs of the custom terminals the operator has said
/// are PowerShell: one of those that is really there counts, wherever it is.
///
/// Cheapest first: the usual places, `/etc/shells` (the `.pkg` registers it),
/// the app's own `PATH`, and only then the login shell's `PATH`, which is the
/// one a Dock-launched app does not have and the one that knows about a `pwsh`
/// somewhere unusual. Blocking: it can start a shell, so it runs off the IPC
/// thread.
pub(crate) fn powershell_installed(custom: &[String]) -> bool {
    if custom.iter().any(|p| is_program(Path::new(p))) {
        return true;
    }
    if PWSH_PLACES.iter().any(|p| is_program(Path::new(p))) {
        return true;
    }
    if shells().iter().any(|s| s.name == "pwsh") {
        return true;
    }
    if let Some(path) = std::env::var_os("PATH") {
        if std::env::split_paths(&path).any(|d| is_program(&d.join("pwsh"))) {
            return true;
        }
    }
    login_shell_finds_pwsh()
}

/// Asks the operator's login shell, run as a login shell so its profile sets
/// `PATH`, where `pwsh` is. Only a path to a real program counts: a profile
/// may print a banner, so the last line is the one read.
fn login_shell_finds_pwsh() -> bool {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let shell = login_shell()
        .filter(|p| is_program(p))
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let Ok(mut child) = Command::new(&shell)
        .args(["-l", "-c", "command -v pwsh"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < LOGIN_LOOKUP_TIMEOUT => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    out.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .map(Path::new)
        .is_some_and(|p| p.is_absolute() && is_program(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_powershell_custom_terminal_that_is_there_counts() {
        assert!(powershell_installed(&["/bin/sh".to_string()]));
    }

    #[test]
    fn the_login_shell_lookup_answers_without_hanging() {
        let started = std::time::Instant::now();
        let _ = login_shell_finds_pwsh();
        assert!(started.elapsed() < LOGIN_LOOKUP_TIMEOUT + std::time::Duration::from_secs(1));
    }
}
