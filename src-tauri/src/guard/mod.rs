//! Destructive-command guard (D-014). Broadcast-only: detection runs before
//! dispatch and again inside the broadcast command (defense in depth — the
//! frontend modal alone is bypassable over IPC).
//!
//! Rules are structured data, not regex (D-014). The 12 core rules are
//! non-removable in v0.1a; user-added rules arrive with the Settings page.

pub mod tokenizer;

use serde::{Deserialize, Serialize};
use tokenizer::{effective_command, tokenize, Pipeline, Segment, TokenKind};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GuardHit {
    pub rule_id: String,
    pub description: String,
}

/// A user-added rule (D-014 structured form — no raw regex). Matches with
/// the same Spec semantics as core rules: command name(s) + optional flag
/// groups (`short|--long` alternatives, all groups required) + optional
/// path-prefix patterns + optional exact-arg requirements.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserRule {
    pub id: String,
    pub description: String,
    pub commands: Vec<String>,
    #[serde(default)]
    pub required_flags: Vec<String>,
    #[serde(default)]
    pub path_patterns: Vec<String>,
    #[serde(default)]
    pub arg_all_of: Vec<String>,
    pub enabled: bool,
}

pub fn validate_user_rule(rule: &UserRule) -> AppResult<()> {
    if rule.id.trim().is_empty() {
        return Err(AppError::InvalidInput("rule id is required".into()));
    }
    if rule.description.trim().is_empty() {
        return Err(AppError::InvalidInput("rule description is required".into()));
    }
    if rule.commands.is_empty() || rule.commands.iter().any(|c| c.trim().is_empty()) {
        return Err(AppError::InvalidInput(
            "at least one command name is required".into(),
        ));
    }
    if rule.commands.iter().any(|c| c.contains(char::is_whitespace)) {
        return Err(AppError::InvalidInput(
            "command names cannot contain spaces (use flags/args fields)".into(),
        ));
    }
    Ok(())
}

/// Read-only descriptor of a core rule for the Settings UI.
#[derive(Debug, Clone, Serialize)]
pub struct CoreRuleInfo {
    pub id: String,
    pub description: String,
}

pub fn core_rule_infos() -> Vec<CoreRuleInfo> {
    core_rules()
        .iter()
        .map(|r| CoreRuleInfo {
            id: r.id.to_string(),
            description: r.description.to_string(),
        })
        .collect()
}

/// One core rule. `kinds` is any-of: the rule fires if any matcher fires.
struct Rule {
    id: &'static str,
    description: &'static str,
    kinds: Vec<Matcher>,
}

enum Matcher {
    /// Effective command matches (exact, or prefix when the entry ends with
    /// `*`), every flag group entry is satisfied (entries are
    /// `short|--long|…` alternatives), and — when `path_patterns` is
    /// non-empty — at least one non-flag arg path-matches a pattern.
    /// `arg_all_of` entries must each appear as an exact arg token.
    Spec {
        commands: &'static [&'static str],
        required_flags: &'static [&'static str],
        path_patterns: &'static [&'static str],
        arg_all_of: &'static [&'static str],
    },
    /// `>` (truncating) redirect whose target is one of these paths.
    RedirectTruncate { targets: &'static [&'static str] },
    /// A pipeline where one of `sources` is later piped into one of `shells`.
    PipeToShell {
        sources: &'static [&'static str],
        shells: &'static [&'static str],
    },
    /// Raw substring match (whitespace-normalized) — for the fork bomb.
    RawContains { needles: &'static [&'static str] },
}

fn core_rules() -> Vec<Rule> {
    vec![
        Rule {
            id: "rm-rf",
            description: "Recursive forced delete (rm -rf)",
            kinds: vec![Matcher::Spec {
                commands: &["rm"],
                required_flags: &["r|R|--recursive", "f|--force"],
                path_patterns: &[],
                arg_all_of: &[],
            }],
        },
        Rule {
            id: "dd-device",
            description: "Raw write to a block device (dd of=/dev/…)",
            kinds: vec![Matcher::Spec {
                commands: &["dd"],
                required_flags: &[],
                path_patterns: &["of=/dev/"],
                arg_all_of: &[],
            }],
        },
        Rule {
            id: "mkfs",
            description: "Filesystem creation destroys existing data (mkfs)",
            kinds: vec![Matcher::Spec {
                commands: &["mkfs*"],
                required_flags: &[],
                path_patterns: &[],
                arg_all_of: &[],
            }],
        },
        Rule {
            id: "partition-tools",
            description: "Partition table modification (fdisk/parted/sfdisk/wipefs on a device)",
            kinds: vec![Matcher::Spec {
                commands: &["fdisk", "parted", "sfdisk", "wipefs"],
                required_flags: &[],
                path_patterns: &["/dev/"],
                arg_all_of: &[],
            }],
        },
        Rule {
            id: "shutdown",
            description: "Host shutdown or reboot",
            kinds: vec![
                Matcher::Spec {
                    commands: &["shutdown", "poweroff", "reboot", "halt"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &[],
                },
                Matcher::Spec {
                    commands: &["systemctl"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &["poweroff"],
                },
                Matcher::Spec {
                    commands: &["systemctl"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &["reboot"],
                },
                Matcher::Spec {
                    commands: &["systemctl"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &["halt"],
                },
                Matcher::Spec {
                    commands: &["init"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &["0"],
                },
                Matcher::Spec {
                    commands: &["init"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &["6"],
                },
            ],
        },
        Rule {
            id: "truncate-auth-files",
            description: "Truncation of /etc/passwd, /etc/shadow or /etc/sudoers",
            kinds: vec![Matcher::RedirectTruncate {
                targets: &["/etc/passwd", "/etc/shadow", "/etc/sudoers"],
            }],
        },
        Rule {
            id: "recursive-chmod-chown-system",
            description: "Recursive chmod/chown of a system path",
            kinds: vec![Matcher::Spec {
                commands: &["chmod", "chown"],
                required_flags: &["R|--recursive"],
                path_patterns: &[
                    "/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var", "/boot",
                    "/dev", "/proc", "/sys", "/opt",
                ],
                arg_all_of: &[],
            }],
        },
        Rule {
            id: "fork-bomb",
            description: "Fork bomb",
            kinds: vec![Matcher::RawContains {
                needles: &[":(){ :|:& };:", ":(){:|:&};:"],
            }],
        },
        Rule {
            id: "pipe-to-shell",
            description: "Downloaded content piped straight into a shell",
            kinds: vec![Matcher::PipeToShell {
                sources: &["curl", "wget", "fetch"],
                shells: &["sh", "bash", "zsh", "dash", "ksh"],
            }],
        },
        Rule {
            id: "crontab-remove",
            description: "Removes the user's entire crontab (crontab -r)",
            kinds: vec![Matcher::Spec {
                commands: &["crontab"],
                required_flags: &["r"],
                path_patterns: &[],
                arg_all_of: &[],
            }],
        },
        Rule {
            id: "firewall-flush",
            description: "Flushes all firewall rules (iptables -F / nft flush ruleset)",
            kinds: vec![
                Matcher::Spec {
                    commands: &["iptables", "ip6tables"],
                    required_flags: &["F|--flush"],
                    path_patterns: &[],
                    arg_all_of: &[],
                },
                Matcher::Spec {
                    commands: &["nft"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &["flush", "ruleset"],
                },
            ],
        },
        Rule {
            id: "account-removal",
            description: "User or group account removal (userdel/groupdel/passwd -d)",
            kinds: vec![
                Matcher::Spec {
                    commands: &["userdel", "groupdel"],
                    required_flags: &[],
                    path_patterns: &[],
                    arg_all_of: &[],
                },
                Matcher::Spec {
                    commands: &["passwd"],
                    required_flags: &["d|--delete"],
                    path_patterns: &[],
                    arg_all_of: &[],
                },
            ],
        },
    ]
}

/// Checks a broadcast command against every core rule. Returns all distinct
/// hits (a compound command can trip several rules).
pub fn check(command: &str) -> Vec<GuardHit> {
    check_with_user(command, &[])
}

/// Core rules plus enabled user rules (D-041).
pub fn check_with_user(command: &str, user_rules: &[UserRule]) -> Vec<GuardHit> {
    let pipelines = tokenize(command);
    let mut hits = Vec::new();
    for rule in core_rules() {
        if rule_matches(&rule, command, &pipelines) {
            hits.push(GuardHit {
                rule_id: rule.id.to_string(),
                description: rule.description.to_string(),
            });
        }
    }
    for rule in user_rules.iter().filter(|r| r.enabled) {
        let commands: Vec<&str> = rule.commands.iter().map(String::as_str).collect();
        let flags: Vec<&str> = rule.required_flags.iter().map(String::as_str).collect();
        let paths: Vec<&str> = rule.path_patterns.iter().map(String::as_str).collect();
        let args: Vec<&str> = rule.arg_all_of.iter().map(String::as_str).collect();
        let matched = pipelines
            .iter()
            .flat_map(|p| &p.segments)
            .any(|seg| spec_matches(seg, &commands, &flags, &paths, &args));
        if matched {
            hits.push(GuardHit {
                rule_id: rule.id.clone(),
                description: rule.description.clone(),
            });
        }
    }
    hits
}

fn rule_matches(rule: &Rule, raw: &str, pipelines: &[Pipeline]) -> bool {
    rule.kinds.iter().any(|kind| match kind {
        Matcher::Spec {
            commands,
            required_flags,
            path_patterns,
            arg_all_of,
        } => pipelines.iter().flat_map(|p| &p.segments).any(|seg| {
            spec_matches(seg, commands, required_flags, path_patterns, arg_all_of)
        }),
        Matcher::RedirectTruncate { targets } => pipelines
            .iter()
            .flat_map(|p| &p.segments)
            .any(|seg| redirect_truncate_matches(seg, targets)),
        Matcher::PipeToShell { sources, shells } => {
            pipelines.iter().any(|p| pipe_to_shell_matches(p, sources, shells))
        }
        Matcher::RawContains { needles } => {
            let normalized: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
            needles.iter().any(|n| normalized.contains(n) || raw.contains(n))
        }
    })
}

fn spec_matches(
    segment: &Segment,
    commands: &[&str],
    required_flags: &[&str],
    path_patterns: &[&str],
    arg_all_of: &[&str],
) -> bool {
    let words = effective_command(segment);
    let Some(cmd) = words.first() else {
        return false;
    };
    let cmd_name = basename(&cmd.text);
    let cmd_ok = commands.iter().any(|c| {
        if let Some(prefix) = c.strip_suffix('*') {
            cmd_name.starts_with(prefix)
        } else {
            cmd_name == *c
        }
    });
    if !cmd_ok {
        return false;
    }
    let args: Vec<&str> = words[1..].iter().map(|t| t.text.as_str()).collect();

    let flags_ok = required_flags.iter().all(|group| {
        group.split('|').any(|alt| {
            if let Some(long) = alt.strip_prefix("--") {
                args.iter().any(|a| *a == format!("--{long}"))
            } else {
                // Single-letter flag inside any short-flag cluster.
                let letter = alt.chars().next().unwrap();
                args.iter().any(|a| {
                    a.len() >= 2
                        && a.starts_with('-')
                        && !a.starts_with("--")
                        && a[1..].contains(letter)
                })
            }
        })
    });
    if !flags_ok {
        return false;
    }

    if !arg_all_of.is_empty() && !arg_all_of.iter().all(|needed| args.contains(needed)) {
        return false;
    }

    if !path_patterns.is_empty() {
        let non_flag_args = args.iter().filter(|a| !a.starts_with('-'));
        let mut any = false;
        for arg in non_flag_args {
            if path_patterns.iter().any(|p| path_arg_matches(arg, p)) {
                any = true;
                break;
            }
        }
        if !any {
            return false;
        }
    }
    true
}

/// `/etc` matches `/etc` and `/etc/anything` but not `/etcetera`;
/// patterns ending in `/` (and `of=/dev/`-style prefixes) are plain prefixes.
fn path_arg_matches(arg: &str, pattern: &str) -> bool {
    if pattern == "/" {
        return arg == "/" || arg == "/*";
    }
    if pattern.ends_with('/') || pattern.contains('=') {
        return arg.starts_with(pattern);
    }
    arg == pattern || arg.starts_with(&format!("{pattern}/"))
}

fn redirect_truncate_matches(segment: &Segment, targets: &[&str]) -> bool {
    let toks = &segment.tokens;
    for (i, t) in toks.iter().enumerate() {
        if t.kind != TokenKind::Redirect {
            continue;
        }
        // Truncating forms only: >, 1>, &> — not >> (append) and not 2> alone
        // (stderr-to-file doesn't truncate the auth file… it does, actually:
        // `cmd 2> /etc/passwd` truncates the target too. Count every
        // non-append `>` regardless of fd.)
        if t.text.ends_with(">>") || !t.text.contains('>') {
            continue;
        }
        if let Some(next) = toks.get(i + 1) {
            if next.kind == TokenKind::Word && targets.contains(&next.text.as_str()) {
                return true;
            }
        }
    }
    false
}

fn pipe_to_shell_matches(pipeline: &Pipeline, sources: &[&str], shells: &[&str]) -> bool {
    let mut source_seen_at: Option<usize> = None;
    for (idx, seg) in pipeline.segments.iter().enumerate() {
        let words = effective_command(seg);
        let Some(cmd) = words.first() else { continue };
        let name = basename(&cmd.text);
        if sources.contains(&name) && source_seen_at.is_none() {
            source_seen_at = Some(idx);
        }
        if shells.contains(&name) {
            if let Some(src) = source_seen_at {
                if idx > src {
                    return true;
                }
            }
        }
    }
    false
}

fn basename(cmd: &str) -> &str {
    cmd.rsplit('/').next().unwrap_or(cmd)
}

/// Sudo detection + rewrite for broadcast auto-elevation (D-026). Inserts
/// ` -S -p ''` after every segment-leading `sudo` so the password can be
/// piped on stdin. Quoting in the rest of the command is untouched because
/// this is a pure insertion at recorded byte offsets.
pub struct SudoRewrite {
    pub command: String,
    pub needs_password: bool,
    pub has_doas: bool,
}

pub fn rewrite_for_sudo(command: &str) -> SudoRewrite {
    let scan = tokenizer::scan_sudo(command);
    if scan.sudo_insert_at.is_empty() {
        return SudoRewrite {
            command: command.to_string(),
            needs_password: scan.has_doas,
            has_doas: scan.has_doas,
        };
    }
    let mut rewritten = command.to_string();
    for offset in scan.sudo_insert_at.iter().rev() {
        rewritten.insert_str(*offset, " -S -p ''");
    }
    SudoRewrite {
        command: rewritten,
        needs_password: true,
        has_doas: scan.has_doas,
    }
}

#[cfg(test)]
mod tests;
