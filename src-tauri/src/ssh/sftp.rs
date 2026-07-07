//! SFTP subsystem client (feature: single-host file browser + transfers).
//!
//! russh itself implements no file transfer, so this layers `russh-sftp` on top
//! of the *same* authenticated connection path as the rest of the app: it reuses
//! [`super::connect_and_auth`], so TOFU host-key verification and password/key
//! auth behave identically to probe (test connection) and exec (broadcast), and
//! the connect result mirrors [`super::ProbeResult`]'s non-success variants so
//! the frontend reuses the existing TOFU / key-mismatch dialogs.
//!
//! Unlike probe/exec (which open, act, disconnect), a file *browser* issues many
//! rapid listings, so a fresh SSH handshake per click would be painfully slow.
//! [`SftpState`] therefore keeps sessions alive between operations, keyed by a
//! frontend-supplied `session_id` — the same registry shape as
//! [`super::pty::PtyState`].

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};

use super::{connect_and_auth, AuthMethod, ConnectFailure, PresentedKey, TofuHandler};

/// One remote directory entry. `kind` is `"dir" | "file" | "symlink"`.
#[derive(Debug, Clone, Serialize)]
pub struct SftpEntry {
    pub name: String,
    /// Absolute remote path (parent joined with name, POSIX `/`).
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    /// Modification time, epoch seconds (None when the server omits it).
    pub mtime: Option<i64>,
    /// Unix permission bits (None when the server omits them).
    pub permissions: Option<u32>,
}

/// File count + total bytes for a directory — returned by the pre-flight scan
/// (to decide whether to warn) and by a recursive transfer (for the toast).
/// `cancelled` is true when a transfer stopped early at the user's request
/// (the counts are then whatever completed before the stop). `files`/`bytes`
/// count files actually transferred; `skipped` counts files left untouched by
/// the clash mode.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct TransferStats {
    pub files: u64,
    pub bytes: u64,
    pub skipped: u64,
    pub cancelled: bool,
}

/// What a recursive transfer does when a file already exists at the destination.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferMode {
    /// Always overwrite (truncate + rewrite). The default.
    OverwriteAll,
    /// Overwrite only when the source file is newer than the destination.
    NewerOnly,
    /// Never overwrite; only copy files missing at the destination.
    SkipExisting,
}

/// Outcome of opening an SFTP session. `Ok` carries the initial (home) path;
/// the other variants mirror [`super::ProbeResult`] so the same dialogs apply.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SftpConnectResult {
    Ok {
        session_id: String,
        cwd: String,
    },
    UnknownKey {
        key: PresentedKey,
    },
    KeyMismatch {
        stored_fingerprint: String,
        presented: PresentedKey,
    },
    AuthFailed {
        message: String,
    },
    Unreachable {
        message: String,
    },
    /// Host has no stored credentials; the session was not opened.
    NoCredentials,
}

impl From<ConnectFailure> for SftpConnectResult {
    fn from(f: ConnectFailure) -> Self {
        match f {
            ConnectFailure::UnknownKey { key } => SftpConnectResult::UnknownKey { key },
            ConnectFailure::KeyMismatch {
                stored_fingerprint,
                presented,
            } => SftpConnectResult::KeyMismatch {
                stored_fingerprint,
                presented,
            },
            ConnectFailure::AuthFailed { message } => SftpConnectResult::AuthFailed { message },
            ConnectFailure::Unreachable { message } => SftpConnectResult::Unreachable { message },
        }
    }
}

/// A live SFTP session: the SFTP wrapper plus the russh handle held only to keep
/// the underlying connection open. `SftpSession`'s methods take `&self` and
/// multiplex requests internally, so no per-session mutex is needed.
struct SftpConn {
    _handle: Handle<TofuHandler>,
    sftp: SftpSession,
}

/// Live SFTP sessions keyed by the frontend-supplied session id. Clone-cheap
/// (shared maps). Dropping the last `Arc` for a session closes its connection.
///
/// `cancels` holds a per-session cancellation flag while a recursive transfer is
/// running: a transfer task keeps its own `Arc<SftpConn>`, so removing the
/// session from `conns` does NOT stop an in-flight walk — the loop instead polls
/// this flag each file and stops cooperatively when it's set (by an explicit
/// cancel or by disconnect).
#[derive(Default, Clone)]
pub struct SftpState {
    conns: Arc<Mutex<HashMap<String, Arc<SftpConn>>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl SftpState {
    /// Clones the session's handle out from under the (sync) map lock so the
    /// lock is never held across an `.await`.
    fn get(&self, session_id: &str) -> AppResult<Arc<SftpConn>> {
        self.conns
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::Ssh(format!("no such sftp session: {session_id}")))
    }

    fn insert(&self, session_id: String, conn: SftpConn) {
        self.conns.lock().unwrap().insert(session_id, Arc::new(conn));
    }

    /// Deregisters a session; dropping its `Arc` tears the connection down. Any
    /// in-flight transfer for the session is signalled to stop first.
    pub fn remove(&self, session_id: &str) {
        self.signal_cancel(session_id);
        self.conns.lock().unwrap().remove(session_id);
    }

    /// Begins a cancellation scope for a session's transfer and returns the flag
    /// the transfer loop polls. Replaces any previous flag (fresh = not cancelled).
    pub fn begin_transfer(&self, session_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .unwrap()
            .insert(session_id.to_string(), flag.clone());
        flag
    }

    /// Ends a transfer's cancellation scope.
    pub fn end_transfer(&self, session_id: &str) {
        self.cancels.lock().unwrap().remove(session_id);
    }

    /// Signals any in-flight transfer for the session to stop at the next file.
    pub fn signal_cancel(&self, session_id: &str) {
        if let Some(flag) = self.cancels.lock().unwrap().get(session_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// dir → 0, symlink → 1, file → 2, so listings show folders first.
fn kind_rank(kind: &str) -> u8 {
    match kind {
        "dir" => 0,
        "symlink" => 1,
        _ => 2,
    }
}

/// Opens an authenticated SFTP session and registers it under `session_id`.
pub async fn open(
    state: &SftpState,
    session_id: String,
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
) -> AppResult<SftpConnectResult> {
    let handle =
        match connect_and_auth(hostname, port, username, trusted_fingerprints, auth).await? {
            Ok(h) => h,
            Err(failure) => return Ok(failure.into()),
        };

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("sftp channel open: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Ssh(format!("sftp subsystem request: {e}")))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::Ssh(format!("sftp init: {e}")))?;

    // Resolve the home directory as the initial listing path.
    let cwd = sftp
        .canonicalize(".")
        .await
        .map_err(|e| AppError::Ssh(format!("sftp canonicalize home: {e}")))?;

    state.insert(session_id.clone(), SftpConn { _handle: handle, sftp });
    Ok(SftpConnectResult::Ok { session_id, cwd })
}

/// Lists a remote directory, folders first then files, each alphabetical.
pub async fn list(state: &SftpState, session_id: &str, path: &str) -> AppResult<Vec<SftpEntry>> {
    let conn = state.get(session_id)?;
    let read_dir = conn
        .sftp
        .read_dir(path.to_string())
        .await
        .map_err(|e| AppError::Ssh(format!("sftp read_dir {path}: {e}")))?;

    let mut entries: Vec<SftpEntry> = read_dir
        .map(|entry| {
            let md = entry.metadata();
            let kind = if md.is_dir() {
                "dir"
            } else if md.is_symlink() {
                "symlink"
            } else {
                "file"
            };
            SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                kind: kind.to_string(),
                size: md.size,
                mtime: md.mtime.map(|m| m as i64),
                permissions: md.permissions,
            }
        })
        .collect();

    entries.sort_by(|a, b| {
        kind_rank(&a.kind)
            .cmp(&kind_rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Creates a remote directory.
pub async fn mkdir(state: &SftpState, session_id: &str, path: &str) -> AppResult<()> {
    let conn = state.get(session_id)?;
    conn.sftp
        .create_dir(path.to_string())
        .await
        .map_err(|e| AppError::Ssh(format!("sftp mkdir {path}: {e}")))
}

/// Removes a remote file (or empty directory when `is_dir`).
pub async fn remove(
    state: &SftpState,
    session_id: &str,
    path: &str,
    is_dir: bool,
) -> AppResult<()> {
    let conn = state.get(session_id)?;
    if is_dir {
        // Check emptiness ourselves so a non-empty folder gets a clear message
        // instead of the server's generic "failure".
        let mut listing = conn
            .sftp
            .read_dir(path.to_string())
            .await
            .map_err(|e| AppError::Ssh(format!("sftp delete {path}: {e}")))?;
        if listing.next().is_some() {
            return Err(AppError::Ssh(format!("{path}: folder not empty")));
        }
        conn.sftp
            .remove_dir(path.to_string())
            .await
            .map_err(|e| AppError::Ssh(format!("sftp delete {path}: {e}")))
    } else {
        conn.sftp
            .remove_file(path.to_string())
            .await
            .map_err(|e| AppError::Ssh(format!("sftp delete {path}: {e}")))
    }
}

/// Chunk size for streamed single-file transfers. Streaming (rather than
/// buffering the whole file in RAM) keeps memory flat under bounded-parallel
/// broadcast transfers and lets us report byte progress as we go.
const TRANSFER_CHUNK: usize = 64 * 1024;

/// Uploads a local file to `remote_path`, streaming in chunks. Returns the byte
/// count transferred. `on_progress(bytes_done)` is called periodically + at the
/// end; `cancel` is polled between chunks so the transfer stops cooperatively.
pub async fn upload(
    state: &SftpState,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
    cancel: &AtomicBool,
    on_progress: impl Fn(u64),
) -> AppResult<u64> {
    let conn = state.get(session_id)?;
    let mut src = tokio::fs::File::open(local_path).await?;
    let mut dst = conn
        .sftp
        .create(remote_path.to_string())
        .await
        .map_err(|e| AppError::Ssh(format!("sftp create {remote_path}: {e}")))?;

    let mut buf = vec![0u8; TRANSFER_CHUNK];
    let mut total: u64 = 0;
    let mut last_tick = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| AppError::Ssh(format!("sftp write {remote_path}: {e}")))?;
        total += n as u64;
        if last_tick.elapsed() >= PROGRESS_INTERVAL {
            on_progress(total);
            last_tick = Instant::now();
        }
    }
    // Flush + close the remote file so the write is durable before we return.
    dst.shutdown()
        .await
        .map_err(|e| AppError::Ssh(format!("sftp finalize {remote_path}: {e}")))?;
    on_progress(total);
    Ok(total)
}

/// Downloads `remote_path` to a local file, streaming in chunks. Returns the
/// byte count transferred. `on_progress(bytes_done)` is called periodically + at
/// the end; `cancel` is polled between chunks so the transfer stops cooperatively.
pub async fn download(
    state: &SftpState,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
    cancel: &AtomicBool,
    on_progress: impl Fn(u64),
) -> AppResult<u64> {
    let conn = state.get(session_id)?;
    let mut src = conn
        .sftp
        .open(remote_path.to_string())
        .await
        .map_err(|e| AppError::Ssh(format!("sftp open {remote_path}: {e}")))?;
    let mut dst = tokio::fs::File::create(local_path).await?;

    let mut buf = vec![0u8; TRANSFER_CHUNK];
    let mut total: u64 = 0;
    let mut last_tick = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Ssh(format!("sftp read {remote_path}: {e}")))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        total += n as u64;
        if last_tick.elapsed() >= PROGRESS_INTERVAL {
            on_progress(total);
            last_tick = Instant::now();
        }
    }
    dst.flush().await?;
    on_progress(total);
    Ok(total)
}

/// Creates `path` and any missing ancestors on the remote (like `mkdir -p`).
/// Each component is created in turn, ignoring "already exists"; the final path
/// is then verified to be a directory. Backs the "create path if doesn't exist"
/// toggle for single-file puts to a not-yet-existing remote directory.
pub async fn ensure_dir(state: &SftpState, session_id: &str, path: &str) -> AppResult<()> {
    let conn = state.get(session_id)?;
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(());
    }
    let absolute = trimmed.starts_with('/');
    let mut acc = String::new();
    for (i, comp) in trimmed.split('/').filter(|c| !c.is_empty()).enumerate() {
        if i == 0 {
            if absolute {
                acc.push('/');
            }
        } else {
            acc.push('/');
        }
        acc.push_str(comp);
        let _ = conn.sftp.create_dir(acc.clone()).await; // ignore "already exists"
    }
    match conn.sftp.metadata(trimmed.to_string()).await {
        Ok(md) if md.is_dir() => Ok(()),
        Ok(_) => Err(AppError::Ssh(format!(
            "{trimmed}: exists but is not a directory"
        ))),
        Err(e) => Err(AppError::Ssh(format!("sftp ensure_dir {trimmed}: {e}"))),
    }
}

// --- Recursive directory transfers -----------------------------------------
//
// Symlinks are skipped throughout (avoids loops and dangling links); only real
// files and directories are counted/transferred.

/// One entry from a local directory walk, in pre-order (a directory is always
/// listed before its contents so remote dirs get created before their files).
struct LocalWalkEntry {
    /// Path relative to the walk root, POSIX-separated (for the remote side).
    rel: String,
    is_dir: bool,
    abs: PathBuf,
    /// File size (0 for dirs) and mtime — used for the clash mode + progress.
    size: u64,
    mtime: Option<i64>,
}

fn walk_local(root: &Path) -> std::io::Result<Vec<LocalWalkEntry>> {
    let mut out = Vec::new();
    walk_local_inner(root, "", &mut out)?;
    Ok(out)
}

fn walk_local_inner(dir: &Path, rel: &str, out: &mut Vec<LocalWalkEntry>) -> std::io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let ft = match e.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if ft.is_dir() {
            out.push(LocalWalkEntry {
                rel: child_rel.clone(),
                is_dir: true,
                abs: e.path(),
                size: 0,
                mtime: None,
            });
            walk_local_inner(&e.path(), &child_rel, out)?;
        } else {
            let meta = e.metadata().ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            out.push(LocalWalkEntry {
                rel: child_rel,
                is_dir: false,
                abs: e.path(),
                size,
                mtime,
            });
        }
    }
    Ok(())
}

/// Throttle between progress callbacks so a folder of many tiny files doesn't
/// flood the UI with events.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

/// Recursively uploads a local directory to `remote_root` (which is created).
/// `on_progress(files_done, bytes_done)` is called periodically + at the end.
pub async fn upload_dir(
    state: &SftpState,
    session_id: &str,
    local_root: &str,
    remote_root: &str,
    mode: TransferMode,
    cancel: &AtomicBool,
    on_progress: impl Fn(u64, u64),
) -> AppResult<TransferStats> {
    let conn = state.get(session_id)?;
    // Create the destination root; ignore "already exists".
    let _ = conn.sftp.create_dir(remote_root.to_string()).await;
    let base = remote_root.trim_end_matches('/');

    let walk = walk_local(Path::new(local_root))?;
    let mut stats = TransferStats::default();
    // Progress is over every file we process (transferred + skipped) so the bar
    // still reaches 100% when some files are skipped by the clash mode.
    let mut done_files: u64 = 0;
    let mut done_bytes: u64 = 0;
    let mut last_tick = Instant::now();
    for item in walk {
        if cancel.load(Ordering::Relaxed) {
            stats.cancelled = true;
            break;
        }
        let remote_path = format!("{base}/{}", item.rel);
        if item.is_dir {
            let _ = conn.sftp.create_dir(remote_path).await; // ignore if it exists
            continue;
        }

        // Decide whether to write this file given the clash mode.
        let write = match mode {
            TransferMode::OverwriteAll => true,
            TransferMode::SkipExisting => !conn
                .sftp
                .try_exists(remote_path.clone())
                .await
                .unwrap_or(false),
            TransferMode::NewerOnly => match conn.sftp.metadata(remote_path.clone()).await {
                // Destination exists — overwrite only if the source is strictly newer.
                Ok(attrs) => match (item.mtime, attrs.mtime) {
                    (Some(src), Some(dst)) => src > dst as i64,
                    _ => true, // unknown timestamps → overwrite to be safe
                },
                Err(_) => true, // doesn't exist (or stat failed) → write
            },
        };

        done_files += 1;
        done_bytes += item.size;
        if write {
            let data = tokio::fs::read(&item.abs).await?;
            let mut file = conn
                .sftp
                .create(remote_path.clone())
                .await
                .map_err(|e| AppError::Ssh(format!("sftp create {remote_path}: {e}")))?;
            file.write_all(&data)
                .await
                .map_err(|e| AppError::Ssh(format!("sftp write {remote_path}: {e}")))?;
            file.shutdown()
                .await
                .map_err(|e| AppError::Ssh(format!("sftp finalize {remote_path}: {e}")))?;
            stats.files += 1;
            stats.bytes += data.len() as u64;
        } else {
            stats.skipped += 1;
        }
        if last_tick.elapsed() >= PROGRESS_INTERVAL {
            on_progress(done_files, done_bytes);
            last_tick = Instant::now();
        }
    }
    on_progress(done_files, done_bytes);
    Ok(stats)
}

/// Recursively downloads a remote directory to `local_root` (which is created).
/// `on_progress(files_done, bytes_done)` is called periodically + at the end.
pub async fn download_dir(
    state: &SftpState,
    session_id: &str,
    remote_root: &str,
    local_root: &str,
    mode: TransferMode,
    cancel: &AtomicBool,
    on_progress: impl Fn(u64, u64),
) -> AppResult<TransferStats> {
    let conn = state.get(session_id)?;
    let mut stats = TransferStats::default();
    // Progress covers processed (transferred + skipped) files, so the bar still
    // completes when the clash mode skips some.
    let mut done_files: u64 = 0;
    let mut done_bytes: u64 = 0;
    let mut last_tick = Instant::now();
    // (remote dir, matching local dir) worklist.
    let mut stack: Vec<(String, PathBuf)> = vec![(remote_root.to_string(), PathBuf::from(local_root))];
    'walk: while let Some((rpath, ldir)) = stack.pop() {
        tokio::fs::create_dir_all(&ldir).await?;
        let read_dir = conn
            .sftp
            .read_dir(rpath.clone())
            .await
            .map_err(|e| AppError::Ssh(format!("sftp read_dir {rpath}: {e}")))?;
        for entry in read_dir {
            if cancel.load(Ordering::Relaxed) {
                stats.cancelled = true;
                break 'walk;
            }
            let md = entry.metadata();
            if md.is_symlink() {
                continue;
            }
            let child_local = ldir.join(entry.file_name());
            if md.is_dir() {
                stack.push((entry.path(), child_local));
                continue;
            }

            // Decide whether to write this file given the clash mode.
            let write = match mode {
                TransferMode::OverwriteAll => true,
                TransferMode::SkipExisting => !child_local.exists(),
                TransferMode::NewerOnly => match fs::metadata(&child_local) {
                    Ok(m) => {
                        let dst = m
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64);
                        match (md.mtime, dst) {
                            (Some(src), Some(dst)) => (src as i64) > dst,
                            _ => true,
                        }
                    }
                    Err(_) => true, // doesn't exist → write
                },
            };

            done_files += 1;
            done_bytes += md.size.unwrap_or(0);
            if write {
                let rp = entry.path();
                let mut file = conn
                    .sftp
                    .open(rp.clone())
                    .await
                    .map_err(|e| AppError::Ssh(format!("sftp open {rp}: {e}")))?;
                let mut buf = Vec::new();
                file.read_to_end(&mut buf)
                    .await
                    .map_err(|e| AppError::Ssh(format!("sftp read {rp}: {e}")))?;
                tokio::fs::write(&child_local, &buf).await?;
                stats.files += 1;
                stats.bytes += buf.len() as u64;
            } else {
                stats.skipped += 1;
            }
            if last_tick.elapsed() >= PROGRESS_INTERVAL {
                on_progress(done_files, done_bytes);
                last_tick = Instant::now();
            }
        }
    }
    on_progress(done_files, done_bytes);
    Ok(stats)
}

/// Recursively counts files + total bytes under a remote directory (pre-flight
/// for the large-folder warning).
pub async fn scan_remote_dir(
    state: &SftpState,
    session_id: &str,
    path: &str,
) -> AppResult<TransferStats> {
    let conn = state.get(session_id)?;
    let mut stats = TransferStats::default();
    let mut stack = vec![path.to_string()];
    while let Some(p) = stack.pop() {
        let read_dir = conn
            .sftp
            .read_dir(p.clone())
            .await
            .map_err(|e| AppError::Ssh(format!("sftp read_dir {p}: {e}")))?;
        for entry in read_dir {
            let md = entry.metadata();
            if md.is_symlink() {
                continue;
            }
            if md.is_dir() {
                stack.push(entry.path());
            } else {
                stats.files += 1;
                stats.bytes += md.size.unwrap_or(0);
            }
        }
    }
    Ok(stats)
}
