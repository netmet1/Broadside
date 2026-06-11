//! Shell-aware tokenizer for the destructive-command guard (D-014) and sudo
//! detection (D-026). This is intentionally NOT a full shell parser — it
//! handles the quoting and connector shapes operators actually broadcast,
//! and the guard's job is best-effort warning, not sandboxing.

/// A token with its byte span in the original input, so callers can do
/// surgical edits (sudo flag insertion) without re-serializing and losing
/// the user's quoting.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub text: String,
    /// Byte range [start, end) in the original input.
    pub span: (usize, usize),
    pub kind: TokenKind,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TokenKind {
    Word,
    /// `>`, `>>`, `2>`, `&>`, `<` … the operator text is in `text`.
    Redirect,
}

/// One simple command: `rm -rf /tmp/x`.
#[derive(Debug, Clone, Default)]
pub struct Segment {
    pub tokens: Vec<Token>,
}

/// Segments connected by `|`. `&&`, `||`, `;`, `&` and newlines start a new
/// pipeline. Command substitution bodies become additional pipelines.
#[derive(Debug, Clone, Default)]
pub struct Pipeline {
    pub segments: Vec<Segment>,
}

impl Segment {
    pub fn words(&self) -> impl Iterator<Item = &Token> {
        self.tokens.iter().filter(|t| t.kind == TokenKind::Word)
    }
}

pub fn tokenize(input: &str) -> Vec<Pipeline> {
    let mut out = Vec::new();
    tokenize_into(input, 0, &mut out);
    out.retain(|p| p.segments.iter().any(|s| !s.tokens.is_empty()));
    for p in &mut out {
        p.segments.retain(|s| !s.tokens.is_empty());
    }
    out
}

/// `base` is the byte offset of `input` within the original top-level string
/// so spans stay valid through command-substitution recursion.
fn tokenize_into(input: &str, base: usize, out: &mut Vec<Pipeline>) {
    let bytes = input.as_bytes();
    let mut i = 0;

    let mut pipeline = Pipeline::default();
    let mut segment = Segment::default();
    let mut tok = String::new();
    let mut tok_start: Option<usize> = None;

    // Sub-command bodies are collected and recursed at the end so their
    // pipelines don't interleave with the current one mid-parse.
    let mut subs: Vec<(String, usize)> = Vec::new();

    macro_rules! flush_tok {
        ($end:expr) => {
            if let Some(start) = tok_start.take() {
                segment.tokens.push(Token {
                    text: std::mem::take(&mut tok),
                    span: (base + start, base + $end),
                    kind: TokenKind::Word,
                });
            }
        };
    }
    macro_rules! end_segment {
        ($end:expr) => {
            flush_tok!($end);
            if !segment.tokens.is_empty() {
                pipeline.segments.push(std::mem::take(&mut segment));
            }
        };
    }
    macro_rules! end_pipeline {
        ($end:expr) => {
            end_segment!($end);
            if !pipeline.segments.is_empty() {
                out.push(std::mem::take(&mut pipeline));
            }
        };
    }

    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'\'' => {
                // Single quotes: literal until the closing quote.
                if tok_start.is_none() {
                    tok_start = Some(i);
                }
                let close = find_byte(bytes, i + 1, b'\'');
                tok.push_str(&input[i + 1..close.min(bytes.len())]);
                i = close.saturating_add(1).min(bytes.len() + 1);
                continue;
            }
            b'"' => {
                // Double quotes: literal except $( … ) which still substitutes.
                if tok_start.is_none() {
                    tok_start = Some(i);
                }
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        tok.push(bytes[i + 1] as char);
                        i += 2;
                        continue;
                    }
                    if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
                        let close = find_matching_paren(bytes, i + 2);
                        subs.push((input[i + 2..close].to_string(), base + i + 2));
                        i = close.saturating_add(1);
                        continue;
                    }
                    if bytes[i] == b'`' {
                        let close = find_byte(bytes, i + 1, b'`');
                        subs.push((input[i + 1..close.min(bytes.len())].to_string(), base + i + 1));
                        i = close.saturating_add(1);
                        continue;
                    }
                    tok.push(bytes[i] as char);
                    i += 1;
                }
                i += 1; // closing quote
                continue;
            }
            b'\\' => {
                if tok_start.is_none() {
                    tok_start = Some(i);
                }
                if i + 1 < bytes.len() {
                    tok.push(bytes[i + 1] as char);
                }
                i += 2;
                continue;
            }
            b'$' if i + 1 < bytes.len() && bytes[i + 1] == b'(' => {
                let close = find_matching_paren(bytes, i + 2);
                subs.push((input[i + 2..close].to_string(), base + i + 2));
                // The substitution result acts as a word in this segment.
                if tok_start.is_none() {
                    tok_start = Some(i);
                }
                tok.push_str("$(...)");
                i = close.saturating_add(1);
                continue;
            }
            b'`' => {
                let close = find_byte(bytes, i + 1, b'`');
                subs.push((input[i + 1..close.min(bytes.len())].to_string(), base + i + 1));
                if tok_start.is_none() {
                    tok_start = Some(i);
                }
                tok.push_str("`...`");
                i = close.saturating_add(1);
                continue;
            }
            b' ' | b'\t' => {
                flush_tok!(i);
                i += 1;
            }
            b'\n' | b';' => {
                end_pipeline!(i);
                i += 1;
            }
            b'&' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'>' {
                    // &> redirect
                    flush_tok!(i);
                    let (op_end, op) = read_redirect(bytes, i);
                    segment.tokens.push(Token {
                        text: op,
                        span: (base + i, base + op_end),
                        kind: TokenKind::Redirect,
                    });
                    i = op_end;
                } else {
                    // && or background & — both end the pipeline.
                    end_pipeline!(i);
                    i += if i + 1 < bytes.len() && bytes[i + 1] == b'&' { 2 } else { 1 };
                }
            }
            b'|' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'|' {
                    end_pipeline!(i);
                    i += 2;
                } else {
                    end_segment!(i);
                    i += 1;
                }
            }
            b'>' | b'<' => {
                // A pure-digit token glued to the left is the fd: `2>`.
                let fd_prefix = !tok.is_empty() && tok.bytes().all(|b| b.is_ascii_digit());
                let op_start = if fd_prefix { tok_start.unwrap() } else { i };
                let fd = if fd_prefix {
                    let fd = std::mem::take(&mut tok);
                    tok_start = None;
                    fd
                } else {
                    flush_tok!(i);
                    String::new()
                };
                let (op_end, op) = read_redirect(bytes, i);
                segment.tokens.push(Token {
                    text: format!("{fd}{op}"),
                    span: (base + op_start, base + op_end),
                    kind: TokenKind::Redirect,
                });
                i = op_end;
            }
            b'(' | b')' | b'{' | b'}' => {
                // Grouping — treat as a word boundary, content parses normally.
                flush_tok!(i);
                i += 1;
            }
            _ => {
                if tok_start.is_none() {
                    tok_start = Some(i);
                }
                tok.push(c as char);
                i += 1;
            }
        }
    }
    end_pipeline!(bytes.len());

    for (body, offset) in subs {
        tokenize_into(&body, offset, out);
    }
}

fn read_redirect(bytes: &[u8], i: usize) -> (usize, String) {
    let mut j = i;
    let mut op = String::new();
    if bytes[j] == b'&' {
        op.push('&');
        j += 1;
    }
    if j < bytes.len() && (bytes[j] == b'>' || bytes[j] == b'<') {
        op.push(bytes[j] as char);
        let c = bytes[j];
        j += 1;
        if j < bytes.len() && bytes[j] == c {
            op.push(c as char);
            j += 1;
        }
    }
    (j, op)
}

fn find_byte(bytes: &[u8], from: usize, needle: u8) -> usize {
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == needle {
            return i;
        }
        i += 1;
    }
    bytes.len()
}

fn find_matching_paren(bytes: &[u8], from: usize) -> usize {
    let mut depth = 1usize;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

/// Commands that wrap the real command. `env` may be followed by VAR=val
/// assignments which are also stripped.
const PREFIX_COMMANDS: &[&str] = &[
    "sudo", "doas", "time", "env", "nice", "nohup", "command", "builtin",
];

/// Returns word tokens with leading wrappers (sudo, env VAR=x, …), wrapper
/// flags, and standalone VAR=val assignments stripped — the first returned
/// token is the effective command.
pub fn effective_command<'a>(segment: &'a Segment) -> Vec<&'a Token> {
    let words: Vec<&Token> = segment.words().collect();
    let mut idx = 0;
    while idx < words.len() {
        let t = words[idx].text.as_str();
        if is_assignment(t) {
            idx += 1;
        } else if PREFIX_COMMANDS.contains(&t) {
            idx += 1;
            // Skip the wrapper's own option flags (`sudo -u root`, `nice -n 5`).
            while idx < words.len() && words[idx].text.starts_with('-') {
                let flag = words[idx].text.clone();
                idx += 1;
                // Flags that consume a value argument.
                if matches!(flag.as_str(), "-u" | "-g" | "-n" | "--user" | "--group")
                    && idx < words.len()
                    && !words[idx].text.starts_with('-')
                    && !is_assignment(&words[idx].text)
                {
                    idx += 1;
                }
            }
        } else {
            break;
        }
    }
    words[idx.min(words.len())..].to_vec()
}

fn is_assignment(token: &str) -> bool {
    match token.find('=') {
        Some(pos) if pos > 0 => token[..pos]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_'),
        _ => false,
    }
}

/// Byte offsets (end of token) of every segment-initial `sudo`, plus whether
/// any `doas` appears, across all pipelines.
pub struct SudoScan {
    /// Insertion points: byte offset just past each leading `sudo` token.
    pub sudo_insert_at: Vec<usize>,
    pub has_doas: bool,
}

pub fn scan_sudo(input: &str) -> SudoScan {
    let mut scan = SudoScan {
        sudo_insert_at: Vec::new(),
        has_doas: false,
    };
    for pipeline in tokenize(input) {
        for segment in &pipeline.segments {
            // sudo can sit behind other wrappers (`nohup sudo cmd`), so walk
            // the wrapper chain rather than only checking token 0.
            let words: Vec<&Token> = segment.words().collect();
            for w in &words {
                let t = w.text.as_str();
                if is_assignment(t) {
                    continue;
                }
                if t == "sudo" {
                    scan.sudo_insert_at.push(w.span.1);
                    break;
                }
                if t == "doas" {
                    scan.has_doas = true;
                    break;
                }
                if PREFIX_COMMANDS.contains(&t) {
                    continue;
                }
                break;
            }
        }
    }
    scan.sudo_insert_at.sort_unstable();
    scan.sudo_insert_at.dedup();
    scan
}
