use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub mod broadcast_history;
pub mod custom_terminals;
pub mod history;
pub mod host_keys;
pub mod hosts;
pub mod omni_history;
pub mod pty_history;
pub mod settings;
pub mod shell_profiles;
pub mod skills;
pub mod templates;

pub struct DbState(pub Mutex<Connection>);

pub fn init(app: &AppHandle) -> AppResult<DbState> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::State(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("broadside.db");
    let conn = Connection::open(&db_path)?;
    bootstrap(&conn)?;
    Ok(DbState(Mutex::new(conn)))
}

pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    bootstrap(&conn)?;
    Ok(conn)
}

/// Sequential migrations driven by PRAGMA user_version. Each entry runs at
/// most once per database; user_version records how many have been applied.
/// Append only, never reorder or edit a shipped entry.
const MIGRATIONS: &[&str] = &[
    // 1: initial hosts table
    "CREATE TABLE IF NOT EXISTS hosts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        label         TEXT NOT NULL UNIQUE,
        hostname      TEXT NOT NULL,
        port          INTEGER NOT NULL DEFAULT 22,
        username      TEXT NOT NULL,
        color         TEXT NOT NULL,
        linux_flavor  TEXT,
        notes         TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );",
    // 2: credential metadata on hosts (PR#2). Guarded for databases that
    // predate the migration runner and already ran add_column_if_missing.
    "SELECT 1;",
    // 3: trusted server keys, keyed by network endpoint (TOFU, D-033)
    "CREATE TABLE IF NOT EXISTS host_keys (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname            TEXT NOT NULL,
        port                INTEGER NOT NULL,
        key_type            TEXT NOT NULL,
        public_key          TEXT NOT NULL,
        fingerprint_sha256  TEXT NOT NULL,
        first_seen          TEXT NOT NULL,
        last_seen           TEXT NOT NULL,
        UNIQUE (hostname, port, key_type)
    );",
    // 4: sudo password presence flag (PR#4, D-026). The secret itself lives
    // in the credential store; this flag only drives UI affordances.
    "ALTER TABLE hosts ADD COLUMN has_sudo_password INTEGER NOT NULL DEFAULT 0;",
    // 5: app settings key-value store (PR#7; first consumer: audit_enabled)
    "CREATE TABLE IF NOT EXISTS settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );",
    // 6: broadcast command history (PR#8; D-015 search surface)
    "CREATE TABLE IF NOT EXISTS command_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        command     TEXT NOT NULL,
        host_count  INTEGER NOT NULL,
        ts          TEXT NOT NULL
    );",
    // 7: persistent broadcast RESULT history (2026-06-13 work queue, D-059).
    // One row per host-result; rows of a run share run_id/ts/command. `result`
    // is the ExecResult serialized as JSON so the frontend renders it the same
    // as a live result block.
    "CREATE TABLE IF NOT EXISTS broadcast_results (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id    TEXT NOT NULL,
        ts        TEXT NOT NULL,
        command   TEXT NOT NULL,
        host_id   INTEGER NOT NULL,
        label     TEXT NOT NULL,
        color     TEXT NOT NULL,
        result    TEXT NOT NULL
    );",
    // 8: persistent PTY-broadcast DISPATCH history (D-059). Records which
    // command was typed into which sessions and whether the write dispatched;
    // the actual output lives in the terminal tabs, not here.
    "CREATE TABLE IF NOT EXISTS pty_dispatch_results (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id    TEXT NOT NULL,
        ts        TEXT NOT NULL,
        command   TEXT NOT NULL,
        label     TEXT NOT NULL,
        color     TEXT NOT NULL,
        ok        INTEGER NOT NULL,
        message   TEXT
    );",
    // 9: command_history host references + source (D-061 sub-4). hosts_json is
    // a JSON array of {id, label}; id is null for sources that don't track it
    // yet (PTY broadcast until a later PR). source is one of
    // "broadcast" | "ptybroadcast" | "multiterminal". Rows predating this stay
    // NULL on both and render by host_count only.
    "ALTER TABLE command_history ADD COLUMN hosts_json TEXT;
     ALTER TABLE command_history ADD COLUMN source TEXT;",
    // 10: PTY-broadcast dispatch host_id (D-061 sub-4) so its results tint by
    // the host's *live* colour, like broadcast_results already does. Nullable:
    // rows predating this fall back to the stored colour snapshot.
    "ALTER TABLE pty_dispatch_results ADD COLUMN host_id INTEGER;",
    // 11: persistent MultiTerminal block log (D-061 follow-up) so the aggregate
    // view survives restarts (it otherwise lived only in frontend memory). One
    // row per displayed block; host_id resolves the live colour, label is the
    // snapshot fallback, lines is a JSON array.
    "CREATE TABLE IF NOT EXISTS omni_blocks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            TEXT NOT NULL,
        host_id       INTEGER,
        label         TEXT NOT NULL,
        command       TEXT,
        lines         TEXT NOT NULL,
        exit_code     INTEGER,
        duration_ms   INTEGER,
        interactivity TEXT NOT NULL
    );",
    // 12: host grouping tag (user request), optional free-text label for
    // grouping/sorting hosts in the table; autocompleted in the form from tags
    // already in use. Surfaces before linux_flavor in the UI.
    "ALTER TABLE hosts ADD COLUMN tag TEXT;",
    // 13: skills. Reusable multi-step operations driven over a live PTY per
    // host (skills-feature-plan, Phase 1). `config_json` is the kind-specific
    // blob (steps + declared params); it can hold command text, so it shares
    // the at-rest exposure class of command_history (D-011). No secrets ever
    // live here; the credential store owns those.
    "CREATE TABLE IF NOT EXISTS skills (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        icon         TEXT,
        kind         TEXT NOT NULL,
        config_json  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
    );",
    // 14: the host's detected login shell (X4). Written by the backend after a
    // successful connect, never by the host form, so the Hosts table can warn
    // that a non-POSIX shell (fish, csh) gets no command-block tracking and
    // can't run skills. NULL means "not probed yet", not "unsupported".
    "ALTER TABLE hosts ADD COLUMN login_shell TEXT;",
    // 15: hand-picked skill order (user request). The rail used to be sorted by
    // name, which is no order at all once you have a dozen skills and run three
    // of them daily. Existing rows are backfilled with their current
    // name-sorted position, so an upgrade changes nothing until the operator
    // moves something.
    "ALTER TABLE skills ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
     UPDATE skills SET sort_order = (
        SELECT COUNT(*) FROM skills AS other
         WHERE other.name < skills.name
            OR (other.name = skills.name AND other.id < skills.id)
     );",
    // 16: user-defined terminal applications (Git Bash and the like), so the
    // launcher isn't limited to the shells we detect.
    //
    // This lives in the DB rather than a localStorage UI pref on purpose. It
    // names an executable the app will SPAWN, and keeping the definition
    // backend-side means the frontend only ever sends an id: an arbitrary
    // executable path can never cross the IPC boundary and become a launch.
    // `args_json` is a JSON array passed as argv, never a joined string, so
    // nothing is handed to a shell to re-parse.
    "CREATE TABLE IF NOT EXISTS custom_terminals (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        exe_path TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]',
        family TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );",
    // 17: heal login_shell values written by the old probe. It took the last
    // non-empty line of `echo $SHELL`, so a startup script that printed after
    // the answer got stored as the shell, and the Hosts row then wore an
    // "unsupported shell" chip naming a line of the operator's own rc file.
    // The probe is fixed, but the value it wrote lives in the database and
    // nothing re-reads a host you do not reconnect to.
    //
    // A shell name here is always a bare basename, lowercased by shell_name, so
    // anything outside [a-z0-9_-] is not one and cannot have come from a real
    // `$SHELL`. NULL means "not probed yet", which warns about nothing, and the
    // next connect writes the real answer.
    "UPDATE hosts SET login_shell = NULL
      WHERE login_shell IS NOT NULL
        AND (login_shell = '' OR login_shell GLOB '*[^a-z0-9_-]*');",
    // 18: the same heal as 17, run once more. 17 assumed only the old probe
    // could have written such a name, but the fixed probe still believed any
    // absolute path, and on a pfSense host `$SHELL` genuinely is
    // /etc/rc.initial, the console menu, so every connect or test since the
    // upgrade wrote the name straight back. set_login_shell itself now holds
    // the column to this alphabet; this clears what was stored in between.
    "UPDATE hosts SET login_shell = NULL
      WHERE login_shell IS NOT NULL
        AND (login_shell = '' OR login_shell GLOB '*[^a-z0-9_-]*');",
    // 19: what Broadside decided about the host's shell, and what the operator
    // decided about that (D-067).
    //
    // `shell_capability` exists because `login_shell` cannot answer this.
    // Migrations 17 and 18 hold that column to the shell alphabet, so pfSense's
    // rc.initial is stored as NULL, correct for a chip, useless as memory: the
    // fact that the host cannot be driven was being relearned on every connect
    // and forgotten in between. It is also the only place the two silent cases
    // are distinguishable, since 'unsupported' (a name we read and rejected)
    // and 'unreadable' (no answer at all) both leave `login_shell` NULL.
    // One of 'full' | 'parse_safe' | 'unsupported' | 'unreadable'; NULL means
    // never probed.
    //
    // `shell_integration` is the operator's standing override, one of
    // 'auto' | 'always' | 'never', NULL meaning auto. Written only by the host
    // form and, like login_shell, deliberately left out of hosts::update() so
    // saving the form cannot clobber a probed value.
    "ALTER TABLE hosts ADD COLUMN shell_capability TEXT;
     ALTER TABLE hosts ADD COLUMN shell_integration TEXT;",
    // 20: when the last attempt to reach this host failed, RFC3339, NULL for a
    // host that answered the last time anyone asked.
    //
    // The red Test button lived in page state, so a host you could not reach
    // was red until you closed the program and forgotten by the time you opened
    // it again -- which is the wrong way round for a machine that is down: the
    // fact outlives the session, and the session is what was remembering it.
    // Written by every path that finds out (test, terminal, broadcast, SFTP,
    // skill run), and cleared by the first one that connects.
    "ALTER TABLE hosts ADD COLUMN connect_failed_at TEXT;",
    // 21: how often to ask this host whether it is back, in seconds, NULL
    // meaning the default of 3 and zero meaning don't ask at all.
    //
    // Read by the reachability probe a pane runs while it sits closed, which is
    // the one thing in the app that repeats on a timer against a machine that
    // may be mid-reboot. Per host because the answer depends on the host and not
    // on the operator: a switch on the desk can be asked every second without
    // anyone noticing, and a box across a satellite link should not be asked
    // that often. Held to 1-10 by the setter for the same reason the guard
    // threshold is capped -- a probe interval nobody can see is still a probe
    // interval, and there is no useful answer outside that range. Zero is not
    // in that range and is not clamped into it: it is the one value that means
    // something other than a period, so the setter admits it by name.
    "ALTER TABLE hosts ADD COLUMN probe_interval_secs INTEGER;",
    // 22: session templates. A saved arrangement of terminal sessions, opened
    // again in one action from the Hosts tab and edited on the Templates tab.
    //
    // In the database rather than in localStorage with the launcher's other
    // preferences, because a template is listed in a table, carries a flag the
    // app reads before the first page is drawn, and has export and import. A
    // shell profile has none of those and stays where it is.
    //
    // `items_json` is a JSON array of session references (host, local shell or
    // saved profile) in the order they open, and it is the whole content of a
    // template: no layout is stored, so the grid always follows the operator's
    // own Grid settings. `startup` is 'off' | 'launch' | 'connect', and at most
    // one row is ever anything but 'off' (see templates::clear_other_startups).
    //
    // A host reference holds label, hostname, port and username so a file can
    // be matched on another machine. It is a reference, not a credential:
    // nothing here is a secret, as with skills and command history (D-011).
    "CREATE TABLE IF NOT EXISTS templates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '',
        items_json  TEXT NOT NULL DEFAULT '[]',
        startup     TEXT NOT NULL DEFAULT 'off',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );",
    // 23: saved local-shell launch profiles (build 69), moved out of
    // localStorage. The note on 22 said a profile "stays where it is"; that
    // changed when Settings > Reset everything cleared localStorage and every
    // profile with it. A profile is content, not a preference. See
    // db/shell_profiles.rs.
    //
    // `id` is text because templates already reference a profile by its uuid.
    // `label` is not UNIQUE: an import collision is renamed, not failed.
    // `startup_command` is typed into a shell on launch, which is why a restore
    // clears it (commands::backup::harden_restored_db).
    "CREATE TABLE IF NOT EXISTS shell_profiles (
        id              TEXT PRIMARY KEY,
        label           TEXT NOT NULL,
        shell_id        TEXT NOT NULL,
        cwd             TEXT NOT NULL DEFAULT '',
        startup_command TEXT NOT NULL DEFAULT '',
        color           TEXT NOT NULL DEFAULT '',
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
    );",
];

pub(crate) fn bootstrap(conn: &Connection) -> AppResult<()> {
    let version: i64 =
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (idx, sql) in MIGRATIONS.iter().enumerate() {
        let target = (idx + 1) as i64;
        if version < target {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", target)?;
        }
    }
    // Idempotent column adds predating the migration runner (PR#2 databases
    // have these columns but user_version 0, fresh databases need them).
    add_column_if_missing(conn, "hosts", "auth_method", "TEXT")?;
    add_column_if_missing(conn, "hosts", "key_path", "TEXT")?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    type_def: &str,
) -> AppResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {type_def}"),
            [],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::ShellCapability;

    /// Brings a fresh connection up to `version` the way a shipped database
    /// would have got there, so an upgrade can be exercised from that point.
    fn database_at_version(version: usize) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for sql in MIGRATIONS.iter().take(version) {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", version as i64)
            .unwrap();
        conn
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn an_existing_database_gains_skills_without_losing_data() {
        // The upgrade path every real installation takes. The unit tests all
        // start from a fresh schema, so this is the only place the *migration*
        // (rather than the final shape) is exercised.
        let conn = database_at_version(12);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        // The new table works…
        skills::create(
            &conn,
            &skills::SkillInput {
                name: "after upgrade".into(),
                description: String::new(),
                icon: None,
                kind: skills::KIND_SEQUENCE.into(),
                config_json: "{}".into(),
            },
        )
        .unwrap();
        assert_eq!(skills::list(&conn).unwrap().len(), 1);
        // …and the row that was already there is untouched.
        let label: String = conn
            .query_row("SELECT label FROM hosts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(label, "web01");
    }

    #[test]
    fn an_existing_database_gains_login_shell_without_losing_hosts() {
        // Migration 14 (X4). Same shape as the skills upgrade above: the column
        // lands on a database that already has host rows, and they survive.
        let conn = database_at_version(13);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        let host = &hosts::list_all(&conn).unwrap()[0];
        assert_eq!(host.label, "web01");
        // Not probed yet: absent, which must not read as "unsupported".
        assert_eq!(host.login_shell, None);

        hosts::set_login_shell(&conn, host.id, Some("fish"), ShellCapability::Unsupported).unwrap();
        let host = hosts::get(&conn, host.id).unwrap();
        assert_eq!(host.login_shell.as_deref(), Some("fish"));

        // And a probe that reads nothing takes it back off, rather than leaving
        // a shell nobody can confirm on the row.
        hosts::set_login_shell(&conn, host.id, None, ShellCapability::Unreadable).unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().login_shell, None);

        // The setter holds the column to the shell alphabet itself: pfSense's
        // rc.initial is a real $SHELL but not a shell, and storing it is how
        // the chip migrations 17 and 18 clear kept coming back.
        hosts::set_login_shell(&conn, host.id, Some("fish"), ShellCapability::Unsupported).unwrap();
        hosts::set_login_shell(&conn, host.id, Some("rc.initial"), ShellCapability::Unsupported)
            .unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().login_shell, None);
    }

    #[test]
    fn an_existing_database_gains_the_shell_capability_columns() {
        // Migration 19 (D-067), on a database that already has host rows.
        let conn = database_at_version(18);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        let host = &hosts::list_all(&conn).unwrap()[0];
        assert_eq!(host.label, "web01");
        // Never probed, and no override: both absent, and neither reads as a
        // verdict about the host.
        assert_eq!(host.shell_capability, None);
        assert_eq!(host.shell_integration, None);

        // The two silent cases stay distinguishable through a round trip, which
        // is the whole reason this column exists: `login_shell` is NULL for both
        // because rc.initial cannot pass the alphabet filter.
        hosts::set_login_shell(&conn, host.id, Some("rc.initial"), ShellCapability::Unsupported)
            .unwrap();
        let menu = hosts::get(&conn, host.id).unwrap();
        assert_eq!(menu.login_shell, None);
        assert_eq!(menu.shell_capability.as_deref(), Some("unsupported"));

        hosts::set_login_shell(&conn, host.id, None, ShellCapability::Unreadable).unwrap();
        let silent = hosts::get(&conn, host.id).unwrap();
        assert_eq!(silent.login_shell, None);
        assert_eq!(silent.shell_capability.as_deref(), Some("unreadable"));

        // The override is stored separately and survives a re-probe, so turning
        // it off reveals what the host actually said rather than a value the
        // override overwrote.
        hosts::set_shell_integration(&conn, host.id, Some("always")).unwrap();
        hosts::set_login_shell(&conn, host.id, Some("bash"), ShellCapability::Full).unwrap();
        let overridden = hosts::get(&conn, host.id).unwrap();
        assert_eq!(overridden.shell_integration.as_deref(), Some("always"));
        assert_eq!(overridden.shell_capability.as_deref(), Some("full"));

        // And a value that is not one of the three is stored as NULL rather
        // than sitting in the column looking meaningful.
        hosts::set_shell_integration(&conn, host.id, Some("sometimes")).unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().shell_integration, None);
    }

    #[test]
    fn a_failed_connection_is_remembered_until_the_host_answers() {
        // Migration 20, on a database that already has host rows.
        let conn = database_at_version(19);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        let host = &hosts::list_all(&conn).unwrap()[0];
        // Nobody has tried, which is not the same as a host that failed.
        assert_eq!(host.connect_failed_at, None);

        hosts::set_connect_failed(&conn, host.id, true).unwrap();
        let down = hosts::get(&conn, host.id).unwrap();
        assert!(down.connect_failed_at.is_some());
        // The record itself was not edited, so its timestamp must not move: a
        // machine being unreachable is news about the machine, not a change to
        // what is stored about it.
        assert_eq!(down.updated_at, "then");

        // Anything that connects clears it, which is the whole contract.
        hosts::set_connect_failed(&conn, host.id, false).unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().connect_failed_at, None);

        // And saving the form cannot resurrect or clear it: the column is not
        // in `update`, for the same reason `login_shell` is not.
        hosts::set_connect_failed(&conn, host.id, true).unwrap();
        hosts::update(
            &conn,
            host.id,
            hosts::HostInput {
                label: "web01".into(),
                hostname: "example.test".into(),
                port: 22,
                username: "joe".into(),
                color: "#aabbcc".into(),
                tag: None,
                linux_flavor: None,
                notes: None,
            },
        )
        .unwrap();
        assert!(hosts::get(&conn, host.id).unwrap().connect_failed_at.is_some());
    }

    #[test]
    fn a_probe_interval_survives_an_edit_and_stays_in_range() {
        // Migration 21, on a database that already has host rows: an existing
        // host upgrades to "no answer", which reads as the default rather than
        // as zero. Getting that wrong would give every upgraded host a probe
        // interval of nought seconds, i.e. a spin loop against a machine that
        // is already having a bad day.
        let conn = database_at_version(20);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        let host = &hosts::list_all(&conn).unwrap()[0];
        assert_eq!(host.probe_interval_secs, None, "unset, not zero");

        hosts::set_probe_interval(&conn, host.id, Some(7)).unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().probe_interval_secs, Some(7));

        // Out of range is clamped, not stored and not refused, in both
        // directions and on the way back out as well as in.
        hosts::set_probe_interval(&conn, host.id, Some(600)).unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().probe_interval_secs, Some(10));

        // Except zero, which is the one value outside the range that means
        // something: the check is off for this host. It has to survive both the
        // writer and the reader intact, because a zero rounded up to 1 would
        // turn "never ask" into "ask as often as possible", which is the worst
        // reading of it available.
        hosts::set_probe_interval(&conn, host.id, Some(hosts::PROBE_INTERVAL_OFF)).unwrap();
        assert_eq!(
            hosts::get(&conn, host.id).unwrap().probe_interval_secs,
            Some(hosts::PROBE_INTERVAL_OFF),
            "off is stored as off, not rounded into the range"
        );
        assert_ne!(
            hosts::get(&conn, host.id).unwrap().probe_interval_secs,
            None,
            "off is not the same as never answered"
        );

        // A value written straight into the column by hand still reads back
        // inside the range, because the reader clamps too. A negative one is
        // nonsense rather than a second way of saying off, so it rounds up to
        // the minimum instead of landing on zero.
        conn.execute(
            "UPDATE hosts SET probe_interval_secs = 9000 WHERE id = ?1",
            rusqlite::params![host.id],
        )
        .unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().probe_interval_secs, Some(10));
        conn.execute(
            "UPDATE hosts SET probe_interval_secs = -5 WHERE id = ?1",
            rusqlite::params![host.id],
        )
        .unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().probe_interval_secs, Some(1));

        // And saving the form cannot disturb it, for the same reason
        // `shell_integration` is kept out of `update`.
        hosts::set_probe_interval(&conn, host.id, Some(4)).unwrap();
        hosts::update(
            &conn,
            host.id,
            hosts::HostInput {
                label: "web01".into(),
                hostname: "example.test".into(),
                port: 22,
                username: "joe".into(),
                color: "#aabbcc".into(),
                tag: None,
                linux_flavor: None,
                notes: None,
            },
        )
        .unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().probe_interval_secs, Some(4));

        // None puts it back to "no answer stored", which the pane reads as the
        // default. Not the same as storing 3: a host left alone follows the
        // default if the default ever moves.
        hosts::set_probe_interval(&conn, host.id, None).unwrap();
        assert_eq!(hosts::get(&conn, host.id).unwrap().probe_interval_secs, None);
    }

    #[test]
    fn the_upgrade_drops_a_login_shell_that_cannot_be_one() {
        // Migration 17. The old probe stored whatever the last line of
        // `echo $SHELL` was, so an rc file that printed after the answer got
        // saved as the host's shell and the row wore a chip naming it. The
        // upgrade clears those and leaves real shell names alone.
        let conn = database_at_version(16);
        for (label, shell) in [
            ("noisy", "rc.inital"),
            ("banner", "== welcome =="),
            ("blank", ""),
            ("fishy", "fish"),
            ("plain", "bash"),
            ("dashed", "ksh93"),
        ] {
            conn.execute(
                "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at, login_shell)
                 VALUES (?1, 'example.test', 22, 'joe', '#aabbcc', 'then', 'then', ?2)",
                rusqlite::params![label, shell],
            )
            .unwrap();
        }

        bootstrap(&conn).unwrap();

        let shell_of = |label: &str| -> Option<String> {
            conn.query_row(
                "SELECT login_shell FROM hosts WHERE label = ?1",
                rusqlite::params![label],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(shell_of("noisy"), None);
        assert_eq!(shell_of("banner"), None);
        assert_eq!(shell_of("blank"), None);
        // Real answers are not touched: the fish host keeps its warning.
        assert_eq!(shell_of("fishy").as_deref(), Some("fish"));
        assert_eq!(shell_of("plain").as_deref(), Some("bash"));
        assert_eq!(shell_of("dashed").as_deref(), Some("ksh93"));
    }

    #[test]
    fn the_heal_runs_again_for_what_the_probe_wrote_after_it() {
        // Migration 18. Between 17 and the probe learning the same alphabet,
        // a connect to a pfSense host stored `rc.initial` again, its passwd
        // shell really is /etc/rc.initial, so the path check believed it.
        let conn = database_at_version(17);
        for (label, shell) in [("firewall", "rc.initial"), ("plain", "bash")] {
            conn.execute(
                "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at, login_shell)
                 VALUES (?1, 'example.test', 22, 'joe', '#aabbcc', 'then', 'then', ?2)",
                rusqlite::params![label, shell],
            )
            .unwrap();
        }

        bootstrap(&conn).unwrap();

        let shell_of = |label: &str| -> Option<String> {
            conn.query_row(
                "SELECT login_shell FROM hosts WHERE label = ?1",
                rusqlite::params![label],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(shell_of("firewall"), None);
        assert_eq!(shell_of("plain").as_deref(), Some("bash"));
    }

    #[test]
    fn existing_skills_are_backfilled_in_name_order() {
        // Migration 15. A database that predates hand-picked order must come
        // out looking exactly as it did before, which then means name order:
        // the upgrade itself must not reshuffle anybody's rail.
        let conn = database_at_version(14);
        for name in ["zebra", "Apple", "mango"] {
            conn.execute(
                "INSERT INTO skills (name, description, icon, kind, config_json,
                                     created_at, updated_at)
                 VALUES (?1, '', NULL, 'sequence', '{}', 'then', 'then')",
                [name],
            )
            .unwrap();
        }

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        let names: Vec<String> = skills::list(&conn)
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["Apple", "mango", "zebra"]);
    }

    #[test]
    fn an_existing_database_gains_templates_without_losing_hosts() {
        // Migration 22, on a database that already has host rows. Same shape as
        // the skills upgrade above, and worth repeating for this one in
        // particular: templates hold host *references*, so the thing an
        // operator would most fear losing is exactly what this must not touch.
        let mut conn = database_at_version(21);
        conn.execute(
            "INSERT INTO hosts (label, hostname, port, username, color, created_at, updated_at)
             VALUES ('web01', 'example.test', 22, 'joe', '#aabbcc', 'then', 'then')",
            [],
        )
        .unwrap();

        bootstrap(&conn).unwrap();

        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
        // The host is still there, unchanged.
        let hosts_now = hosts::list_all(&conn).unwrap();
        assert_eq!(hosts_now.len(), 1);
        assert_eq!(hosts_now[0].label, "web01");
        // And the new table works, holding a reference to that same host.
        templates::create(
            &mut conn,
            &templates::TemplateInput {
                name: "after upgrade".into(),
                color: String::new(),
                items: vec![templates::TemplateItem::Host {
                    host_id: Some(hosts_now[0].id),
                    reference: templates::HostRef {
                        label: "web01".into(),
                        hostname: "example.test".into(),
                        port: 22,
                        username: "joe".into(),
                    },
                }],
                startup: templates::STARTUP_OFF.into(),
            },
        )
        .unwrap();
        assert_eq!(templates::list(&conn).unwrap().len(), 1);
        assert_eq!(hosts::list_all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn bootstrap_is_idempotent() {
        // Every launch runs it; a second pass must not re-run a migration.
        let conn = open_in_memory().unwrap();
        let version = user_version(&conn);
        bootstrap(&conn).unwrap();
        bootstrap(&conn).unwrap();
        assert_eq!(user_version(&conn), version);
    }

    #[test]
    fn a_fresh_database_lands_on_the_latest_version() {
        let conn = open_in_memory().unwrap();
        assert_eq!(user_version(&conn), MIGRATIONS.len() as i64);
    }
}
