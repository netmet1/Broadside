//! Skill configuration: the serde mirror of `src/lib/tauri/skills.ts`, plus
//! parameter substitution and save/run-time validation.
//!
//! Field names are camelCase to match the TS types verbatim: this shape is
//! what lands in `skills.config_json`.

use std::collections::HashMap;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// The branch target meaning "this host is finished". A step may not use it as
/// an id (enforced in [`validate_sequence`]).
pub const STOP: &str = "stop";

/// Default per-step match timeout when the step doesn't set one.
pub const DEFAULT_STEP_TIMEOUT_SECS: u64 = 60;
/// Ceiling on a per-step timeout: an `apt upgrade` can legitimately run for
/// tens of minutes, but nothing should wait longer than an hour.
pub const MAX_STEP_TIMEOUT_SECS: u64 = 3600;
/// Total step executions per host, so a cyclic branch graph terminates.
pub const MAX_STEP_EXECUTIONS: usize = 100;

/// A runtime input the user fills in just before the run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillParam {
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<String>,
}

/// What to do when a step's pattern doesn't arrive in time.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TimeoutAction {
    /// Take the failure branch.
    Fail,
    /// Hand the host to the operator (the default, because expect automation is
    /// brittle, and silently failing a half-done run is worse than waiting).
    #[default]
    Pause,
}

/// An optional output test on a `run` step, taking precedence over the exit
/// code when set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchBranch {
    pub pattern: String,
    pub if_match: String,
    pub if_no_match: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SeqStep {
    /// Run a command and branch on how it went.
    ///
    /// Non-interactive commands are sentinel-wrapped so the engine recovers
    /// both completion and the exit code. `interactive` skips the wrapper for
    /// a command that never returns to the prompt on its own (`sudo -i` starts
    /// a nested shell; `cpilot` waits on a question). Those advance once the
    /// output goes quiet and are then driven with `expect`/`send`.
    Run {
        id: String,
        command: String,
        #[serde(default)]
        interactive: bool,
        #[serde(default)]
        timeout_secs: Option<u64>,
        #[serde(default)]
        on_timeout: TimeoutAction,
        on_success: String,
        on_failure: String,
        #[serde(default)]
        r#match: Option<MatchBranch>,
    },
    /// Wait for output, optionally answer it. The interactive-prompt primitive.
    Expect {
        id: String,
        pattern: String,
        #[serde(default)]
        send_on_match: Option<String>,
        #[serde(default)]
        timeout_secs: Option<u64>,
        #[serde(default)]
        on_timeout: TimeoutAction,
        on_match: String,
    },
    /// Write literal keys, unconditionally.
    Send {
        id: String,
        input: String,
        next: String,
    },
    /// Wait a fixed number of seconds, doing nothing, while the live pane keeps
    /// rendering whatever the previous step left running. This is the primitive
    /// for letting a redrawing status screen sit for a while before the skill
    /// moves on (or finishes), which nothing else could do: `sleep` in a `run`
    /// step goes to a full-screen program that has the terminal, not the shell.
    Wait {
        id: String,
        seconds: u64,
        next: String,
    },
}

impl SeqStep {
    pub fn id(&self) -> &str {
        match self {
            SeqStep::Run { id, .. }
            | SeqStep::Expect { id, .. }
            | SeqStep::Send { id, .. }
            | SeqStep::Wait { id, .. } => id,
        }
    }

    /// The step's kind as the frontend names it, so the run panel can offer the
    /// right control (e.g. "end the wait early" only on a `wait`).
    pub fn kind_str(&self) -> &'static str {
        match self {
            SeqStep::Run { .. } => "run",
            SeqStep::Expect { .. } => "expect",
            SeqStep::Send { .. } => "send",
            SeqStep::Wait { .. } => "wait",
        }
    }

    /// A short human label for progress events.
    pub fn summary(&self) -> String {
        match self {
            SeqStep::Run { command, .. } => format!("run: {}", truncate(command, 80)),
            SeqStep::Expect { pattern, .. } => format!("wait for: {}", truncate(pattern, 80)),
            SeqStep::Send { input, .. } => format!("send: {}", truncate(&escape(input), 40)),
            SeqStep::Wait { seconds, .. } => format!("wait {}s", wait_secs(*seconds)),
        }
    }

    pub fn timeout_secs(&self) -> u64 {
        let raw = match self {
            SeqStep::Run { timeout_secs, .. } | SeqStep::Expect { timeout_secs, .. } => {
                timeout_secs.unwrap_or(DEFAULT_STEP_TIMEOUT_SECS)
            }
            // Not a match timeout: Send fires at once, Wait has its own duration.
            SeqStep::Send { .. } | SeqStep::Wait { .. } => DEFAULT_STEP_TIMEOUT_SECS,
        };
        raw.clamp(1, MAX_STEP_TIMEOUT_SECS)
    }

    /// The delay a `wait` step holds for, clamped to a sane range (a 0 would be
    /// a no-op, an unbounded one a foot-gun).
    pub fn wait_duration(&self) -> Option<std::time::Duration> {
        match self {
            SeqStep::Wait { seconds, .. } => {
                Some(std::time::Duration::from_secs(wait_secs(*seconds)))
            }
            _ => None,
        }
    }

    pub fn on_timeout(&self) -> TimeoutAction {
        match self {
            SeqStep::Run { on_timeout, .. } | SeqStep::Expect { on_timeout, .. } => *on_timeout,
            SeqStep::Send { .. } | SeqStep::Wait { .. } => TimeoutAction::Fail,
        }
    }
}

/// Clamp for a `wait` step's duration: at least a second (a 0 is pointless),
/// at most an hour (the same ceiling as a step timeout).
fn wait_secs(seconds: u64) -> u64 {
    seconds.clamp(1, MAX_STEP_TIMEOUT_SECS)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SequenceConfig {
    #[serde(default)]
    pub params: Vec<SkillParam>,
    pub start_step_id: String,
    pub steps: Vec<SeqStep>,
}

impl SequenceConfig {
    pub fn step(&self, id: &str) -> Option<&SeqStep> {
        self.steps.iter().find(|s| s.id() == id)
    }

    /// Every command/keystroke this sequence could send, for the pre-run guard
    /// sweep and the "needs a sudo password" warning. Substituted text, so what
    /// the guard sees is what the shell would get.
    pub fn dispatched_text(&self) -> Vec<String> {
        let mut out = Vec::new();
        for step in &self.steps {
            match step {
                SeqStep::Run { command, .. } => out.push(command.clone()),
                SeqStep::Send { input, .. } => out.push(input.clone()),
                SeqStep::Expect { send_on_match, .. } => {
                    if let Some(s) = send_on_match {
                        out.push(s.clone());
                    }
                }
                // A wait dispatches nothing, so there is nothing to guard.
                SeqStep::Wait { .. } => {}
            }
        }
        out
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// Renders control characters visibly, so a `send` of "y\n" reads as `y\n` in
/// the progress feed rather than as a mystery line break.
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// Compiles a skill author's pattern against the terminal view.
///
/// **Multi-line mode is on**, and that is not a detail. The view is a stream of
/// terminal lines, so an author writing `^Ready$` plainly means *a line that
/// says Ready*, but Rust's regex anchors `^`/`$` to the whole haystack by
/// default, where `^Ready$` can only match if `Ready` is the entire buffer.
/// That pattern would silently never fire, and the step would sit there until
/// it timed out and paused: a bug that reads as "the host is being slow"
/// rather than "your pattern is wrong". Line semantics are what an operator
/// watching a terminal expects, so they're the default. `\A` and `\z` still
/// anchor to the whole view for anyone who wants that.
pub fn compile_pattern(pattern: &str) -> AppResult<Regex> {
    RegexBuilder::new(pattern)
        .multi_line(true)
        .build()
        .map_err(|e| AppError::InvalidInput(format!("invalid pattern: {e}")))
}

/// Turns the escape sequences a step author types into the bytes they mean.
///
/// A `send` step's text is keystrokes, and the single most common one is Enter.
/// There is no way to type a real newline into a single-line form field, so the
/// builder asks for `\n` and this is what honours it. Without it the host
/// receives a literal backslash and an `n`, the prompt never submits, and the
/// step sits there until it times out.
///
/// Applies to keystrokes only, never to a `run` command: `printf 'a\nb'` means
/// its backslash-n for printf to interpret, not for us to.
///
/// An unknown escape is left exactly as written, so a Windows-ish path typed
/// into a prompt (`C:\data`) survives. A literal backslash before one of the
/// recognised letters is written `\\`.
pub fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            // Escape itself, for driving a program with a control sequence.
            Some('e') => out.push('\x1b'),
            Some('\\') => out.push('\\'),
            // Not an escape we know: leave it as the author wrote it.
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            // Trailing backslash.
            None => out.push('\\'),
        }
    }
    out
}

/// Wraps a value so a shell reads it as exactly one argument, whatever it
/// contains. Single quotes suspend every expansion; the only character needing
/// care is a single quote itself, closed and re-opened around an escaped one.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Replaces `{{key}}` with the user's value for every **declared** parameter.
///
/// Substitution is a single left-to-right scan, so a value that itself contains
/// `{{other}}` is never re-scanned: a parameter cannot smuggle in another
/// parameter's expansion.
///
/// A `{{...}}` whose contents aren't a declared key is left **exactly as
/// written**. That's deliberate: `docker ps --format '{{.Names}}'` and Go/jq
/// templates share this syntax, and a skill that runs one must not have it
/// mangled or rejected.
///
/// `quote` shell-quotes each substituted value. It is on for `run` commands
/// (the text lands in a shell, so a value must not be able to break out of its
/// argument and become a second command) and off for `send`/`sendOnMatch`,
/// whose text is keystrokes typed at whatever is on the far side, often not a
/// shell at all, where literal quotes would be typed as-is. Those are covered
/// by the destructive guard sweep instead.
pub fn substitute(text: &str, values: &HashMap<String, String>, quote: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut ctx = Quoting::Bare;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"{{") {
            if let Some(close) = text[i + 2..].find("}}") {
                let key = &text[i + 2..i + 2 + close];
                if let Some(value) = values.get(key) {
                    out.push_str(&if quote {
                        quote_for(value, ctx)
                    } else {
                        value.clone()
                    });
                    i += 2 + close + 2;
                    continue;
                }
            }
        }
        // Not a declared placeholder: copy this char through untouched, tracking
        // the quoting it puts the *next* placeholder in.
        let ch = text[i..].chars().next().expect("index on a char boundary");
        // A backslash outside single quotes escapes the next character, which
        // must not be read as a quote delimiter.
        if ch == '\\' && ctx != Quoting::Single {
            out.push(ch);
            i += 1;
            if let Some(next) = text[i..].chars().next() {
                out.push(next);
                i += next.len_utf8();
            }
            continue;
        }
        ctx = ctx.advance(ch);
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// The shell quoting a placeholder sits inside, which decides how its value has
/// to be escaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quoting {
    Bare,
    Single,
    Double,
}

impl Quoting {
    fn advance(self, ch: char) -> Self {
        match (self, ch) {
            (Quoting::Bare, '\'') => Quoting::Single,
            (Quoting::Single, '\'') => Quoting::Bare,
            (Quoting::Bare, '"') => Quoting::Double,
            (Quoting::Double, '"') => Quoting::Bare,
            _ => self,
        }
    }
}

/// Escapes `value` so a shell reads it as literal text *in the quoting it lands
/// in*.
///
/// Wrapping every value in fresh quotes only works when the placeholder is bare.
/// Quoting your variables is an ingrained shell habit, so an author will write
/// `echo '{{msg}}'` sooner or later, and adding another layer of quotes inside
/// theirs produces broken shell (worse, a value carrying a quote would escape
/// their quotes entirely). Matching the escaping to the context means all three
/// natural ways of writing the step do the same, safe thing.
fn quote_for(value: &str, ctx: Quoting) -> String {
    match ctx {
        Quoting::Bare => shell_quote(value),
        // Already inside single quotes: only a single quote can end them.
        Quoting::Single => value.replace('\'', r"'\''"),
        // Inside double quotes the shell still expands these, so they're what
        // has to be escaped.
        Quoting::Double => value
            .replace('\\', r"\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`"),
    }
}

/// Applies the user's parameter values to every field that can carry one.
pub fn substituted_config(
    cfg: &SequenceConfig,
    values: &HashMap<String, String>,
) -> SequenceConfig {
    let steps = cfg
        .steps
        .iter()
        .map(|step| match step.clone() {
            SeqStep::Run {
                id,
                command,
                interactive,
                timeout_secs,
                on_timeout,
                on_success,
                on_failure,
                r#match,
            } => SeqStep::Run {
                id,
                command: substitute(&command, values, true),
                interactive,
                timeout_secs,
                on_timeout,
                on_success,
                on_failure,
                r#match: r#match.map(|m| MatchBranch {
                    pattern: substitute(&m.pattern, values, false),
                    ..m
                }),
            },
            SeqStep::Expect {
                id,
                pattern,
                send_on_match,
                timeout_secs,
                on_timeout,
                on_match,
            } => SeqStep::Expect {
                id,
                // The pattern is a regex, not keystrokes: its `\n` is regex
                // syntax and must reach the regex engine as written.
                pattern: substitute(&pattern, values, false),
                // Unescape the author's text FIRST, then substitute. The other
                // order would run the user's *value* through the unescaper, so
                // a path like `C:\new` would sprout a newline.
                send_on_match: send_on_match.map(|s| substitute(&unescape(&s), values, false)),
                timeout_secs,
                on_timeout,
                on_match,
            },
            SeqStep::Send { id, input, next } => SeqStep::Send {
                id,
                input: substitute(&unescape(&input), values, false),
                next,
            },
            // A wait carries no substitutable text.
            other @ SeqStep::Wait { .. } => other,
        })
        .collect();
    SequenceConfig {
        params: cfg.params.clone(),
        start_step_id: cfg.start_step_id.clone(),
        steps,
    }
}

/// Fills declared parameters from the user's values, applying defaults and
/// rejecting a missing required one. Undeclared keys are dropped rather than
/// honoured: the caller is the frontend, and a skill's parameter list is the
/// contract.
pub fn resolve_params(
    params: &[SkillParam],
    supplied: &HashMap<String, String>,
) -> AppResult<HashMap<String, String>> {
    let mut out = HashMap::new();
    for p in params {
        let value = supplied
            .get(&p.key)
            .cloned()
            .or_else(|| p.default.clone())
            .unwrap_or_default();
        if p.required && value.trim().is_empty() {
            let label = if p.label.trim().is_empty() {
                &p.key
            } else {
                &p.label
            };
            return Err(AppError::InvalidInput(format!("{label} is required")));
        }
        out.insert(p.key.clone(), value);
    }
    Ok(out)
}

/// Structural checks that must hold before a run starts (and that the builder
/// runs at save time so the operator hears about a broken graph then, not
/// halfway through an upgrade).
pub fn validate_sequence(cfg: &SequenceConfig) -> AppResult<()> {
    if cfg.steps.is_empty() {
        return Err(AppError::InvalidInput("skill has no steps".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for step in &cfg.steps {
        let id = step.id();
        if id.trim().is_empty() {
            return Err(AppError::InvalidInput("a step has an empty id".into()));
        }
        if id == STOP {
            return Err(AppError::InvalidInput(format!(
                r#""{STOP}" is reserved as a branch target and can't be a step id"#
            )));
        }
        if !seen.insert(id) {
            return Err(AppError::InvalidInput(format!("duplicate step id: {id}")));
        }
    }
    if cfg.step(&cfg.start_step_id).is_none() {
        return Err(AppError::InvalidInput(format!(
            "start step not found: {}",
            cfg.start_step_id
        )));
    }
    for step in &cfg.steps {
        for target in branch_targets(step) {
            if target != STOP && cfg.step(target).is_none() {
                return Err(AppError::InvalidInput(format!(
                    "step {} branches to a step that doesn't exist: {target}",
                    step.id()
                )));
            }
        }
        // A pattern that doesn't compile would otherwise surface as a timeout
        // mid-run, which reads like the host misbehaving rather than a typo.
        for pattern in patterns(step) {
            compile_pattern(pattern).map_err(|e| {
                AppError::InvalidInput(format!("step {}: {e}", step.id()))
            })?;
        }
    }
    Ok(())
}

fn branch_targets(step: &SeqStep) -> Vec<&str> {
    match step {
        SeqStep::Run {
            on_success,
            on_failure,
            r#match,
            ..
        } => {
            let mut v = vec![on_success.as_str(), on_failure.as_str()];
            if let Some(m) = r#match {
                v.push(&m.if_match);
                v.push(&m.if_no_match);
            }
            v
        }
        SeqStep::Expect { on_match, .. } => vec![on_match.as_str()],
        SeqStep::Send { next, .. } => vec![next.as_str()],
        SeqStep::Wait { next, .. } => vec![next.as_str()],
    }
}

fn patterns(step: &SeqStep) -> Vec<&str> {
    match step {
        SeqStep::Run { r#match, .. } => r#match.iter().map(|m| m.pattern.as_str()).collect(),
        SeqStep::Expect { pattern, .. } => vec![pattern.as_str()],
        SeqStep::Send { .. } | SeqStep::Wait { .. } => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vals(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn run_full(
        id: &str,
        command: &str,
        on_success: &str,
        on_failure: &str,
        timeout_secs: Option<u64>,
    ) -> SeqStep {
        SeqStep::Run {
            id: id.into(),
            command: command.into(),
            interactive: false,
            timeout_secs,
            on_timeout: TimeoutAction::Pause,
            on_success: on_success.into(),
            on_failure: on_failure.into(),
            r#match: None,
        }
    }

    fn run_step(id: &str, command: &str) -> SeqStep {
        run_full(id, command, STOP, STOP, None)
    }

    fn cfg(steps: Vec<SeqStep>, start: &str) -> SequenceConfig {
        SequenceConfig {
            params: vec![],
            start_step_id: start.into(),
            steps,
        }
    }

    #[test]
    fn substitutes_declared_keys() {
        let out = substitute("git clone {{repo}}", &vals(&[("repo", "broadside")]), true);
        assert_eq!(out, "git clone 'broadside'");
    }

    #[test]
    fn shell_quoting_contains_a_value_with_spaces_and_quotes() {
        // The injection case from the plan's verification list.
        let out = substitute(
            "touch {{name}}",
            &vals(&[("name", "my file's name")]),
            true,
        );
        assert_eq!(out, r#"touch 'my file'\''s name'"#);
    }

    #[test]
    fn a_value_cannot_smuggle_a_second_command() {
        let out = substitute(
            "echo {{msg}}",
            &vals(&[("msg", "hi; rm -rf /")]),
            true,
        );
        // The semicolon is inside the quotes: one argument to echo, not a
        // command separator.
        assert_eq!(out, "echo 'hi; rm -rf /'");
    }

    #[test]
    fn a_value_cannot_break_out_with_its_own_quote() {
        let out = substitute("echo {{msg}}", &vals(&[("msg", "'; rm -rf /; echo '")]), true);
        assert_eq!(out, r#"echo ''\''; rm -rf /; echo '\'''"#);
    }

    #[test]
    fn a_placeholder_the_author_already_quoted_is_not_double_quoted() {
        // Quoting your variables is an ingrained shell habit, so this is written
        // sooner or later. Adding our own quotes inside the author's would
        // produce broken shell.
        let out = substitute("echo '{{msg}}'", &vals(&[("msg", "hello world")]), true);
        assert_eq!(out, "echo 'hello world'");
    }

    #[test]
    fn a_value_cannot_escape_the_authors_single_quotes() {
        // The breakout the naive version allowed: the value's own quote would
        // close the author's, leaving the rest as shell code.
        let out = substitute(
            "echo '{{msg}}'",
            &vals(&[("msg", "'; rm -rf /; echo '")]),
            true,
        );
        assert_eq!(out, r#"echo ''\''; rm -rf /; echo '\'''"#);
    }

    #[test]
    fn a_value_cannot_escape_the_authors_double_quotes() {
        let out = substitute(
            r#"echo "{{msg}}""#,
            &vals(&[("msg", r#""; rm -rf /; echo ""#)]),
            true,
        );
        assert_eq!(out, r#"echo "\"; rm -rf /; echo \"""#);
    }

    #[test]
    fn a_value_in_double_quotes_cannot_expand() {
        // Inside double quotes the shell still runs $(…), `…` and expands $VAR,
        // so those are what must be escaped there.
        let out = substitute(
            r#"echo "{{msg}}""#,
            &vals(&[("msg", "$(whoami) `id` $HOME")]),
            true,
        );
        assert_eq!(out, r#"echo "\$(whoami) \`id\` \$HOME""#);
    }

    #[test]
    fn quoting_context_resets_after_the_authors_quotes_close() {
        // A later bare placeholder still gets fully quoted.
        let out = substitute(
            "cp '{{from}}' {{to}}",
            &vals(&[("from", "a b"), ("to", "c d")]),
            true,
        );
        assert_eq!(out, "cp 'a b' 'c d'");
    }

    #[test]
    fn an_escaped_quote_does_not_open_a_quoting_context() {
        // \" is a literal quote outside quotes, so the placeholder after it is
        // still bare and must be quoted.
        let out = substitute(r#"echo \" {{msg}}"#, &vals(&[("msg", "a b")]), true);
        assert_eq!(out, r#"echo \" 'a b'"#);
    }

    #[test]
    fn a_quote_inside_the_other_quoting_is_literal() {
        // The apostrophe inside double quotes doesn't open a single-quoted
        // region, so the placeholder is still in double-quote context.
        let out = substitute(r#"echo "it's {{msg}}""#, &vals(&[("msg", "$X")]), true);
        assert_eq!(out, r#"echo "it's \$X""#);
    }

    #[test]
    fn a_value_containing_a_placeholder_is_not_re_expanded() {
        // Single-pass scan: {{b}} inside a's value stays literal.
        let out = substitute(
            "echo {{a}}",
            &vals(&[("a", "{{b}}"), ("b", "surprise")]),
            true,
        );
        assert_eq!(out, "echo '{{b}}'");
    }

    #[test]
    fn docker_go_templates_survive_untouched() {
        // The syntax collision that would otherwise mangle a real command.
        let out = substitute(
            r#"docker ps --format '{{.Names}}' {{tail}}"#,
            &vals(&[("tail", "-a")]),
            true,
        );
        assert_eq!(out, r#"docker ps --format '{{.Names}}' '-a'"#);
    }

    #[test]
    fn undeclared_placeholder_is_left_alone() {
        let out = substitute("echo {{nope}}", &vals(&[("other", "x")]), true);
        assert_eq!(out, "echo {{nope}}");
    }

    #[test]
    fn unescape_turns_backslash_n_into_a_real_newline() {
        // The bug this exists for: the builder asks for `y\n` because a
        // single-line field can't hold a real newline, and without this the
        // host received a backslash and an `n`, so the prompt never submitted.
        assert_eq!(unescape(r"y\n"), "y\n");
        assert_eq!(unescape(r"\r\n"), "\r\n");
        assert_eq!(unescape(r"a\tb"), "a\tb");
        assert_eq!(unescape(r"\e[A"), "\x1b[A");
    }

    #[test]
    fn unescape_leaves_an_unknown_escape_alone() {
        // A path typed at a prompt must survive intact.
        assert_eq!(unescape(r"C:\data"), r"C:\data");
        assert_eq!(unescape(r"\q"), r"\q");
        assert_eq!(unescape(r"trailing\"), r"trailing\");
    }

    #[test]
    fn unescape_handles_a_literal_backslash() {
        assert_eq!(unescape(r"a\\nb"), r"a\nb");
        assert_eq!(unescape(r"\\"), r"\");
    }

    #[test]
    fn send_steps_get_their_escapes_honoured() {
        let c = cfg(
            vec![SeqStep::Send {
                id: "a".into(),
                input: r"y\n".into(),
                next: STOP.into(),
            }],
            "a",
        );
        let out = substituted_config(&c, &vals(&[]));
        match &out.steps[0] {
            SeqStep::Send { input, .. } => assert_eq!(input, "y\n"),
            _ => panic!("wrong step"),
        }
    }

    #[test]
    fn expect_answers_get_their_escapes_honoured_but_patterns_do_not() {
        // The answer is keystrokes, so `\n` is Enter. The pattern is a regex, so
        // its `\n` is regex syntax and has to reach the engine as written.
        let c = cfg(
            vec![SeqStep::Expect {
                id: "a".into(),
                pattern: r"ready\n".into(),
                send_on_match: Some(r"y\n".into()),
                timeout_secs: None,
                on_timeout: TimeoutAction::Pause,
                on_match: STOP.into(),
            }],
            "a",
        );
        let out = substituted_config(&c, &vals(&[]));
        match &out.steps[0] {
            SeqStep::Expect {
                pattern,
                send_on_match,
                ..
            } => {
                assert_eq!(send_on_match.as_deref(), Some("y\n"));
                assert_eq!(pattern, r"ready\n");
            }
            _ => panic!("wrong step"),
        }
    }

    #[test]
    fn a_run_command_keeps_its_backslashes() {
        // `printf 'a\nb'` means its backslash-n for printf, not for us.
        let c = cfg(vec![run_step("a", r"printf 'a\nb'")], "a");
        let out = substituted_config(&c, &vals(&[]));
        match &out.steps[0] {
            SeqStep::Run { command, .. } => assert_eq!(command, r"printf 'a\nb'"),
            _ => panic!("wrong step"),
        }
    }

    #[test]
    fn a_param_value_is_not_run_through_the_unescaper() {
        // Unescape the template, then substitute: the other order would turn a
        // value like `C:\new` into one with a real newline in it.
        let c = cfg(
            vec![SeqStep::Send {
                id: "a".into(),
                input: r"{{path}}\n".into(),
                next: STOP.into(),
            }],
            "a",
        );
        let out = substituted_config(&c, &vals(&[("path", r"C:\new\table")]));
        match &out.steps[0] {
            SeqStep::Send { input, .. } => {
                // The value survived literally; only the author's \n became Enter.
                assert_eq!(input, "C:\\new\\table\n");
            }
            _ => panic!("wrong step"),
        }
    }

    #[test]
    fn send_text_is_substituted_without_quoting() {
        // Keystrokes at a "(y/n)" prompt: quotes would be typed literally.
        let out = substitute("{{answer}}\n", &vals(&[("answer", "y")]), false);
        assert_eq!(out, "y\n");
    }

    #[test]
    fn unterminated_placeholder_is_literal() {
        assert_eq!(substitute("echo {{oops", &vals(&[("oops", "x")]), true), "echo {{oops");
    }

    #[test]
    fn multibyte_text_is_not_split() {
        let out = substitute("echo café {{x}} 日本", &vals(&[("x", "ok")]), true);
        assert_eq!(out, "echo café 'ok' 日本");
    }

    #[test]
    fn resolve_applies_defaults_and_drops_undeclared() {
        let params = vec![
            SkillParam {
                key: "repo".into(),
                label: "Repo".into(),
                required: false,
                default: Some("main".into()),
            },
        ];
        let got = resolve_params(&params, &vals(&[("sneaky", "value")])).unwrap();
        assert_eq!(got.get("repo").unwrap(), "main");
        assert!(!got.contains_key("sneaky"));
    }

    #[test]
    fn resolve_rejects_a_missing_required_param() {
        let params = vec![SkillParam {
            key: "repo".into(),
            label: "Repo name".into(),
            required: true,
            default: None,
        }];
        let err = resolve_params(&params, &vals(&[])).unwrap_err().to_string();
        assert!(err.contains("Repo name"), "got: {err}");
    }

    #[test]
    fn substituted_config_rewrites_every_carrier_field() {
        let c = SequenceConfig {
            params: vec![],
            start_step_id: "a".into(),
            steps: vec![
                run_step("a", "echo {{v}}"),
                SeqStep::Expect {
                    id: "b".into(),
                    pattern: "{{v}}\\?".into(),
                    send_on_match: Some("{{v}}\n".into()),
                    timeout_secs: None,
                    on_timeout: TimeoutAction::Pause,
                    on_match: STOP.into(),
                },
                SeqStep::Send {
                    id: "c".into(),
                    input: "{{v}}".into(),
                    next: STOP.into(),
                },
            ],
        };
        let out = substituted_config(&c, &vals(&[("v", "hi")]));
        match &out.steps[0] {
            SeqStep::Run { command, .. } => assert_eq!(command, "echo 'hi'"),
            _ => panic!("wrong step"),
        }
        match &out.steps[1] {
            SeqStep::Expect {
                pattern,
                send_on_match,
                ..
            } => {
                assert_eq!(pattern, "hi\\?");
                assert_eq!(send_on_match.as_deref(), Some("hi\n"));
            }
            _ => panic!("wrong step"),
        }
        match &out.steps[2] {
            SeqStep::Send { input, .. } => assert_eq!(input, "hi"),
            _ => panic!("wrong step"),
        }
    }

    #[test]
    fn validate_accepts_a_well_formed_graph() {
        let c = cfg(
            vec![
                run_full("a", "true", "b", STOP, None),
                run_step("b", "false"),
            ],
            "a",
        );
        assert!(validate_sequence(&c).is_ok());
    }

    #[test]
    fn validate_rejects_a_dangling_branch() {
        let c = cfg(vec![run_full("a", "true", "ghost", STOP, None)], "a");
        let err = validate_sequence(&c).unwrap_err().to_string();
        assert!(err.contains("ghost"), "got: {err}");
    }

    #[test]
    fn validate_rejects_a_missing_start_step() {
        let c = cfg(vec![run_step("a", "true")], "elsewhere");
        assert!(validate_sequence(&c).is_err());
    }

    #[test]
    fn validate_rejects_duplicate_ids() {
        let c = cfg(vec![run_step("a", "true"), run_step("a", "false")], "a");
        let err = validate_sequence(&c).unwrap_err().to_string();
        assert!(err.contains("duplicate"), "got: {err}");
    }

    #[test]
    fn validate_rejects_stop_as_a_step_id() {
        let c = cfg(vec![run_step(STOP, "true")], STOP);
        assert!(validate_sequence(&c).is_err());
    }

    #[test]
    fn anchors_are_line_anchors_not_buffer_anchors() {
        // What a skill author means by `^Ready$` while watching a terminal. The
        // regex crate's default would only match if `Ready` were the entire
        // buffer, so the pattern would silently never fire.
        let re = compile_pattern("^Ready$").unwrap();
        assert!(re.is_match("Attempt 9: waiting\nReady\n"));
        assert!(re.is_match("Ready")); // still matches an unterminated line
        assert!(!re.is_match("Nearly Ready now\n"));
    }

    #[test]
    fn whole_view_anchors_are_still_available() {
        let re = compile_pattern(r"\AReady\z").unwrap();
        assert!(re.is_match("Ready"));
        assert!(!re.is_match("noise\nReady"));
    }

    #[test]
    fn validate_rejects_an_uncompilable_pattern() {
        let c = cfg(
            vec![SeqStep::Expect {
                id: "a".into(),
                pattern: "((unclosed".into(),
                send_on_match: None,
                timeout_secs: None,
                on_timeout: TimeoutAction::Pause,
                on_match: STOP.into(),
            }],
            "a",
        );
        let err = validate_sequence(&c).unwrap_err().to_string();
        assert!(err.contains("invalid pattern"), "got: {err}");
    }

    #[test]
    fn validate_allows_a_cycle_the_execution_cap_will_catch() {
        // A loop is legitimate (poll until ready); MAX_STEP_EXECUTIONS is what
        // stops a runaway, not save-time validation.
        let c = cfg(vec![run_full("a", "true", "a", "a", None)], "a");
        assert!(validate_sequence(&c).is_ok());
    }

    #[test]
    fn timeout_is_clamped_to_an_hour() {
        let step = run_full("a", "true", STOP, STOP, Some(999_999));
        assert_eq!(step.timeout_secs(), MAX_STEP_TIMEOUT_SECS);
    }

    #[test]
    fn timeout_defaults_when_unset() {
        assert_eq!(run_step("a", "true").timeout_secs(), DEFAULT_STEP_TIMEOUT_SECS);
    }

    #[test]
    fn dispatched_text_collects_every_send_surface() {
        let c = cfg(
            vec![
                run_step("a", "rm -rf /tmp/x"),
                SeqStep::Expect {
                    id: "b".into(),
                    pattern: "\\?".into(),
                    send_on_match: Some("y\n".into()),
                    timeout_secs: None,
                    on_timeout: TimeoutAction::Pause,
                    on_match: "c".into(),
                },
                SeqStep::Send {
                    id: "c".into(),
                    input: "reboot\n".into(),
                    next: STOP.into(),
                },
            ],
            "a",
        );
        let text = c.dispatched_text();
        assert_eq!(text, vec!["rm -rf /tmp/x", "y\n", "reboot\n"]);
    }

    #[test]
    fn config_json_round_trips_through_the_ts_shape() {
        // The exact camelCase/tagged shape the frontend writes.
        let json = r#"{
            "params": [{"key":"repo","label":"Repo","required":true}],
            "startStepId": "s1",
            "steps": [
                {"kind":"run","id":"s1","command":"apt -y upgrade","timeoutSecs":1800,
                 "onTimeout":"pause","onSuccess":"s2","onFailure":"stop"},
                {"kind":"expect","id":"s2","pattern":"\\(y/n\\)","sendOnMatch":"y\n",
                 "onMatch":"s3"},
                {"kind":"send","id":"s3","input":"q","next":"stop"}
            ]
        }"#;
        let cfg: SequenceConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.params[0].key, "repo");
        assert!(cfg.params[0].required);
        assert_eq!(cfg.steps.len(), 3);
        assert_eq!(cfg.steps[0].timeout_secs(), 1800);
        assert!(validate_sequence(&cfg).is_ok());
        // …and back out again unchanged.
        let round: SequenceConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(round, cfg);
    }

    #[test]
    fn interactive_defaults_to_false() {
        let json = r#"{"kind":"run","id":"a","command":"ls","onSuccess":"stop","onFailure":"stop"}"#;
        match serde_json::from_str::<SeqStep>(json).unwrap() {
            SeqStep::Run { interactive, .. } => assert!(!interactive),
            _ => panic!("wrong step"),
        }
    }

    #[test]
    fn on_timeout_defaults_to_pause() {
        // The locked decision: a timeout waits for the operator by default.
        let json = r#"{"kind":"expect","id":"a","pattern":"x","onMatch":"stop"}"#;
        assert_eq!(
            serde_json::from_str::<SeqStep>(json).unwrap().on_timeout(),
            TimeoutAction::Pause
        );
    }

    #[test]
    fn send_summary_shows_control_characters() {
        let step = SeqStep::Send {
            id: "a".into(),
            input: "y\n".into(),
            next: STOP.into(),
        };
        assert_eq!(step.summary(), r"send: y\n");
    }
}
