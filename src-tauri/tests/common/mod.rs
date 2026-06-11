//! Shared docker fixture for the SSH integration suites (D-035).

use std::process::Command;
use std::time::{Duration, Instant};

pub const IMAGE: &str = "lscr.io/linuxserver/openssh-server:latest";
pub const USER: &str = "testuser";
pub const PASSWORD: &str = "testpass-123";

pub struct Fixture {
    pub container_id: String,
    pub port: u16,
}

impl Fixture {
    pub fn start() -> Fixture {
        let out = Command::new("docker")
            .args([
                "run",
                "-d",
                "--rm",
                "-p",
                "127.0.0.1:0:2222",
                "-e",
                &format!("USER_NAME={USER}"),
                "-e",
                &format!("USER_PASSWORD={PASSWORD}"),
                "-e",
                "PASSWORD_ACCESS=true",
                IMAGE,
            ])
            .output()
            .expect("docker run failed to spawn");
        assert!(
            out.status.success(),
            "docker run failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let container_id = String::from_utf8_lossy(&out.stdout).trim().to_string();

        let port_out = Command::new("docker")
            .args(["port", &container_id, "2222/tcp"])
            .output()
            .expect("docker port failed");
        let mapping = String::from_utf8_lossy(&port_out.stdout);
        let port: u16 = mapping
            .lines()
            .next()
            .and_then(|l| l.rsplit(':').next())
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or_else(|| panic!("unparseable docker port output: {mapping}"));

        let fixture = Fixture { container_id, port };
        fixture.wait_ready();
        fixture
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

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["stop", "-t", "1", &self.container_id])
            .output();
    }
}
