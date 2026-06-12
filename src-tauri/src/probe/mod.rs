//! Resource probe (locked design): local probe suggests a max concurrent
//! session count, cached and re-runnable; network probe is on-demand.
//! Suggestions are advisory — the user override wins (never a hard limit).

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::System;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalProbe {
    pub cpu_cores: usize,
    pub total_memory_mb: u64,
    pub available_memory_mb: u64,
    pub suggested_max_sessions: usize,
    pub probed_at: String,
}

pub fn local_probe() -> LocalProbe {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());

    let cpu_cores = sys.cpus().len().max(1);
    let total_memory_mb = sys.total_memory() / (1024 * 1024);
    let available_memory_mb = sys.available_memory() / (1024 * 1024);

    // Heuristic: a russh session + buffers costs single-digit MB; cap by
    // memory headroom (~8MB budgeted each, half the headroom reserved) and
    // by a per-core factor so the crypto work stays responsive.
    let by_memory = (available_memory_mb / 16).max(8) as usize;
    let by_cpu = cpu_cores * 32;
    let suggested_max_sessions = by_memory.min(by_cpu).clamp(8, 512);

    LocalProbe {
        cpu_cores,
        total_memory_mb,
        available_memory_mb,
        suggested_max_sessions,
        probed_at: chrono::Utc::now().to_rfc3339(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HostLatency {
    pub host_id: i64,
    pub label: String,
    /// TCP connect round-trip in milliseconds, or null when unreachable.
    pub connect_ms: Option<u64>,
}

/// TCP connect timing against one endpoint (the network probe primitive).
pub async fn tcp_connect_ms(hostname: &str, port: u16, timeout: Duration) -> Option<u64> {
    let started = Instant::now();
    let attempt = tokio::net::TcpStream::connect((hostname.to_string(), port));
    match tokio::time::timeout(timeout, attempt).await {
        Ok(Ok(_stream)) => Some(started.elapsed().as_millis() as u64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_probe_produces_sane_values() {
        let p = local_probe();
        assert!(p.cpu_cores >= 1);
        assert!(p.total_memory_mb > 0);
        assert!((8..=512).contains(&p.suggested_max_sessions));
        assert!(p.probed_at.contains('T'));
    }

    #[tokio::test]
    async fn unreachable_port_times_out_as_none() {
        // Port 9 (discard) is virtually never bound locally.
        let ms = tcp_connect_ms("127.0.0.1", 9, Duration::from_millis(500)).await;
        assert!(ms.is_none());
    }
}
