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
///
/// The environment is the Mac's half of what `chcp 65001` is on Windows. A GUI
/// app has no `TERM`, so curses programs would not know what they are drawing
/// on, and usually no `LANG`, so a shell would treat every byte above 127 as
/// unprintable and `╭─╮` would come out as escapes.
pub(super) fn builtin_command(shell_id: &str) -> Option<CommandBuilder> {
    let name = shell_id.strip_prefix("unix:")?;
    let shell = shells().iter().find(|s| s.name == name)?;
    let mut c = CommandBuilder::new(&shell.path);
    c.arg("-l");
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
    Some(c)
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
