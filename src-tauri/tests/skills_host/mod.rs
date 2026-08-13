//! A container built for one job: being a host worth driving a skill against.
//!
//! Deliberately not the linuxserver fixture the other SSH suites share. That
//! one is Alpine, its login shell and its sudo are not what an operator's host
//! looks like, and the whole question here is whether a real bash login shell
//! behaves the way the engine assumes. The image is built from
//! `tests/fixtures/skills-host/Dockerfile` on every run (docker caches it) so
//! the test cannot silently run against a stale one, and the container is fresh
//! per test and removed on drop.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

pub const IMAGE: &str = "broadside-skills-test:latest";
pub const USER: &str = "skilltest";
pub const PASSWORD: &str = "skillpass-123";

pub struct SkillsHost {
    pub container_id: String,
    pub port: u16,
}

impl SkillsHost {
    pub fn start() -> SkillsHost {
        Self::start_with_shell("/bin/bash")
    }

    /// The same host with the test user's login shell changed, for the question
    /// of what a shell with a line editor of its own does with `stty -echo`.
    pub fn start_with_shell(shell: &str) -> SkillsHost {
        Self::build();
        let out = Command::new("docker")
            .args(["run", "-d", "--rm", "-p", "127.0.0.1:0:22", IMAGE])
            .output()
            .expect("docker run failed to spawn");
        assert!(
            out.status.success(),
            "docker run failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let container_id = String::from_utf8_lossy(&out.stdout).trim().to_string();

        let port_out = Command::new("docker")
            .args(["port", &container_id, "22/tcp"])
            .output()
            .expect("docker port failed");
        let mapping = String::from_utf8_lossy(&port_out.stdout);
        let port: u16 = mapping
            .lines()
            .next()
            .and_then(|l| l.rsplit(':').next())
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or_else(|| panic!("unparseable docker port output: {mapping}"));

        let host = SkillsHost { container_id, port };
        if shell != "/bin/bash" {
            let out = Command::new("docker")
                .args(["exec", &host.container_id, "usermod", "-s", shell, USER])
                .output()
                .expect("docker exec failed to spawn");
            assert!(
                out.status.success(),
                "could not set the login shell: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        host.wait_ready();
        host
    }

    /// Reads a file from the test user's home, empty if it is not there. Used
    /// for the shell's own history file, which is the only witness to whether
    /// Broadside left one.
    pub fn read_home_file(&self, name: &str) -> String {
        let out = Command::new("docker")
            .args([
                "exec",
                "-u",
                USER,
                &self.container_id,
                "sh",
                "-c",
                "cat \"$HOME/$1\" 2>/dev/null || true",
                "sh",
                name,
            ])
            .output()
            .expect("docker exec failed to spawn");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// Reads any file in the container as root, empty if it is not there.
    ///
    /// For `/root/.bash_history`, which the test user cannot read and which is
    /// the only witness to what the shell a `sudo -i` opened remembered. That
    /// is a different shell with a different history file, so a check against
    /// the login user's own history says nothing about it.
    pub fn read_as_root(&self, path: &str) -> String {
        let out = Command::new("docker")
            .args([
                "exec",
                &self.container_id,
                "sh",
                "-c",
                "cat \"$1\" 2>/dev/null || true",
                "sh",
                path,
            ])
            .output()
            .expect("docker exec failed to spawn");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// Appends one line to a rc file in the test user's home, so a run can be
    /// driven against the prompt an operator actually has rather than the one
    /// Debian ships.
    ///
    /// The line is passed as an *argument* (`$1`), never interpolated into the
    /// script: a `PS1` is made of exactly the characters a shell would
    /// otherwise eat, and quoting one through two layers of shell is how a
    /// fixture starts testing its own escaping instead of the thing in front of
    /// it.
    pub fn append_rc(&self, file: &str, line: &str) {
        let out = Command::new("docker")
            .args([
                "exec",
                "-u",
                USER,
                &self.container_id,
                "sh",
                "-c",
                "printf '%s\\n' \"$1\" >> \"$HOME/$2\"",
                "sh",
                line,
                file,
            ])
            .output()
            .expect("docker exec failed to spawn");
        assert!(
            out.status.success(),
            "could not write {file}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn build() {
        let context: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", "skills-host"]
            .iter()
            .collect();
        let out = Command::new("docker")
            .args(["build", "-q", "-t", IMAGE, "."])
            .current_dir(&context)
            .output()
            .expect("docker build failed to spawn");
        assert!(
            out.status.success(),
            "docker build failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Waits until sshd inside the container answers with its banner.
    fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(stream) = std::net::TcpStream::connect(("127.0.0.1", self.port)) {
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buf = [0u8; 4];
                use std::io::Read;
                let mut s = stream;
                if s.read_exact(&mut buf).is_ok() && &buf == b"SSH-" {
                    return;
                }
            }
            assert!(
                Instant::now() < deadline,
                "fixture sshd not ready after 60s (container {})",
                self.container_id
            );
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

impl Drop for SkillsHost {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["stop", "-t", "1", &self.container_id])
            .output();
    }
}
