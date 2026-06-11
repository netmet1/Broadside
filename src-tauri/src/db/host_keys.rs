use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
pub struct HostKey {
    pub id: i64,
    pub hostname: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
    pub fingerprint_sha256: String,
    pub first_seen: String,
    pub last_seen: String,
}

fn from_row(row: &Row) -> rusqlite::Result<HostKey> {
    Ok(HostKey {
        id: row.get(0)?,
        hostname: row.get(1)?,
        port: row.get::<_, i64>(2)? as u16,
        key_type: row.get(3)?,
        public_key: row.get(4)?,
        fingerprint_sha256: row.get(5)?,
        first_seen: row.get(6)?,
        last_seen: row.get(7)?,
    })
}

const SELECT_COLS: &str =
    "id, hostname, port, key_type, public_key, fingerprint_sha256, first_seen, last_seen";

pub fn get(
    conn: &Connection,
    hostname: &str,
    port: u16,
    key_type: &str,
) -> AppResult<Option<HostKey>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM host_keys WHERE hostname = ?1 AND port = ?2 AND key_type = ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt
        .query_row(params![hostname, port as i64, key_type], from_row)
        .optional()?)
}

pub fn list_for_endpoint(
    conn: &Connection,
    hostname: &str,
    port: u16,
) -> AppResult<Vec<HostKey>> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM host_keys WHERE hostname = ?1 AND port = ?2 ORDER BY key_type"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![hostname, port as i64], from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Stores or replaces the trusted key for (hostname, port, key_type).
/// Replacing is the explicit "trust new key" path after a mismatch warning.
pub fn trust(
    conn: &Connection,
    hostname: &str,
    port: u16,
    key_type: &str,
    public_key: &str,
    fingerprint_sha256: &str,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO host_keys (hostname, port, key_type, public_key, fingerprint_sha256, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (hostname, port, key_type)
         DO UPDATE SET public_key = ?4, fingerprint_sha256 = ?5, first_seen = ?6, last_seen = ?6",
        params![hostname, port as i64, key_type, public_key, fingerprint_sha256, now],
    )?;
    Ok(())
}

pub fn touch_last_seen(
    conn: &Connection,
    hostname: &str,
    port: u16,
    key_type: &str,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE host_keys SET last_seen = ?1 WHERE hostname = ?2 AND port = ?3 AND key_type = ?4",
        params![now, hostname, port as i64, key_type],
    )?;
    Ok(())
}

/// Removes all trusted keys for an endpoint (any key type).
pub fn remove(conn: &Connection, hostname: &str, port: u16) -> AppResult<usize> {
    let affected = conn.execute(
        "DELETE FROM host_keys WHERE hostname = ?1 AND port = ?2",
        params![hostname, port as i64],
    )?;
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn trust_and_get_round_trip() {
        let conn = open_in_memory().unwrap();
        trust(&conn, "web01", 22, "ssh-ed25519", "AAAA-pubkey", "SHA256:abc").unwrap();
        let key = get(&conn, "web01", 22, "ssh-ed25519").unwrap().unwrap();
        assert_eq!(key.fingerprint_sha256, "SHA256:abc");
        assert_eq!(key.public_key, "AAAA-pubkey");
        assert_eq!(key.port, 22);
    }

    #[test]
    fn get_unknown_endpoint_returns_none() {
        let conn = open_in_memory().unwrap();
        assert!(get(&conn, "nope", 22, "ssh-ed25519").unwrap().is_none());
    }

    #[test]
    fn trust_replaces_existing_key() {
        let conn = open_in_memory().unwrap();
        trust(&conn, "web01", 22, "ssh-ed25519", "OLD", "SHA256:old").unwrap();
        trust(&conn, "web01", 22, "ssh-ed25519", "NEW", "SHA256:new").unwrap();
        let key = get(&conn, "web01", 22, "ssh-ed25519").unwrap().unwrap();
        assert_eq!(key.fingerprint_sha256, "SHA256:new");
        let all = list_for_endpoint(&conn, "web01", 22).unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn same_host_different_port_is_distinct() {
        let conn = open_in_memory().unwrap();
        trust(&conn, "web01", 22, "ssh-ed25519", "A", "SHA256:a").unwrap();
        trust(&conn, "web01", 2222, "ssh-ed25519", "B", "SHA256:b").unwrap();
        let k22 = get(&conn, "web01", 22, "ssh-ed25519").unwrap().unwrap();
        let k2222 = get(&conn, "web01", 2222, "ssh-ed25519").unwrap().unwrap();
        assert_ne!(k22.fingerprint_sha256, k2222.fingerprint_sha256);
    }

    #[test]
    fn remove_clears_all_key_types_for_endpoint() {
        let conn = open_in_memory().unwrap();
        trust(&conn, "web01", 22, "ssh-ed25519", "A", "SHA256:a").unwrap();
        trust(&conn, "web01", 22, "rsa-sha2-512", "B", "SHA256:b").unwrap();
        trust(&conn, "other", 22, "ssh-ed25519", "C", "SHA256:c").unwrap();
        let removed = remove(&conn, "web01", 22).unwrap();
        assert_eq!(removed, 2);
        assert!(list_for_endpoint(&conn, "web01", 22).unwrap().is_empty());
        assert_eq!(list_for_endpoint(&conn, "other", 22).unwrap().len(), 1);
    }

    #[test]
    fn touch_updates_last_seen_only() {
        let conn = open_in_memory().unwrap();
        trust(&conn, "web01", 22, "ssh-ed25519", "A", "SHA256:a").unwrap();
        let before = get(&conn, "web01", 22, "ssh-ed25519").unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        touch_last_seen(&conn, "web01", 22, "ssh-ed25519").unwrap();
        let after = get(&conn, "web01", 22, "ssh-ed25519").unwrap().unwrap();
        assert_eq!(after.first_seen, before.first_seen);
        assert!(after.last_seen > before.last_seen);
    }
}
