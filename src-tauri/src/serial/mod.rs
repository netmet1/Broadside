//! Serial console sessions: a COM port opened as a terminal tab, so the console
//! cable into a router, firewall or switch is a pane beside the SSH ones rather
//! than a reason to go and find PuTTY.
//!
//! Like `crate::local`, this reuses the SAME session plumbing as the SSH path
//! (`crate::ssh::pty`): the `PtyState` registry, the `SessionCmd` write/resize/
//! close channel, and the `pty:data` / `pty:closed` events. The frontend's
//! `pty_write` / `pty_resize` / `pty_close` and the xterm rendering are
//! identical, so tabs, the grid, Find and the maximize path all work here with
//! no knowledge that this session is a piece of wire.
//!
//! Three things genuinely differ from a pseudo-console, and each shapes the code
//! below:
//!
//! 1. **There is no child process.** Nothing exits, so there is no exit code and
//!    no EOF. A session ends when the operator closes it or the port faults,
//!    which is why the reader thread is stopped by an explicit flag rather than
//!    by having its handles pulled out from under it.
//! 2. **There is no geometry.** A serial line carries bytes; the device at the
//!    far end has its own idea of how wide the terminal is (and is usually told
//!    by hand, `terminal width 132` and the like). `Resize` is accepted and
//!    ignored rather than refused, so the frontend needs no special case.
//! 3. **The port is exclusive.** Windows hands a COM port to one process at a
//!    time, so a port already open in another terminal program fails to open,
//!    and that is the single most likely first-run failure. It gets its own
//!    message rather than the OS's "Access is denied".

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::ssh::pty::{PtyClosed, PtyData, PtyEvents, PtyState, SessionCmd};

/// A COM port present on this machine.
#[derive(Debug, Clone, Serialize)]
pub struct SerialPort {
    /// The port name, always `COM<n>`. This is the id the frontend sends back.
    pub name: String,
    /// What the port is, as far as the OS knows: the USB adapter's product
    /// string, or the driver's name for a built-in port. Empty when there is
    /// nothing to say. Two identical black dongles are otherwise impossible to
    /// tell apart, and picking the wrong one means typing into the wrong device.
    pub description: String,
}

/// How long a read waits before giving the loop a chance to notice it has been
/// asked to stop. A serial console is idle nearly all the time, so this is what
/// the reader thread actually spends its life doing; short enough that closing a
/// tab feels immediate, long enough not to spin.
const READ_TIMEOUT: Duration = Duration::from_millis(50);

/// Lists the COM ports on this machine. Deliberately NOT cached, unlike the
/// local-shell list: the whole point of a USB serial adapter is that it comes
/// and goes, and a list fixed at startup would mean unplugging and replugging a
/// dongle needed the app restarting to see it. The enumeration is a registry
/// read, so re-running it every time the launcher opens costs nothing.
pub fn list_ports() -> Vec<SerialPort> {
    let mut ports: Vec<SerialPort> = match serialport::available_ports() {
        Ok(ports) => ports
            .into_iter()
            .filter(|p| is_com_port(&p.port_name))
            .map(|p| SerialPort {
                description: describe(&p.port_type),
                name: p.port_name,
            })
            .collect(),
        // Nothing to report is a normal answer (a desktop with no serial
        // hardware at all), and so is a failed enumeration; neither is worth
        // failing a command over, since the UI says "no ports" either way.
        Err(_) => Vec::new(),
    };
    ports.sort_by_key(|p| port_number(&p.name));
    ports
}

/// Human description of a port, best effort. A USB adapter usually knows its
/// own product string; failing that its vendor/product ids at least tell two
/// different dongles apart.
fn describe(port_type: &serialport::SerialPortType) -> String {
    match port_type {
        serialport::SerialPortType::UsbPort(info) => {
            if let Some(product) = info.product.as_ref().filter(|s| !s.is_empty()) {
                product.clone()
            } else if let Some(manufacturer) =
                info.manufacturer.as_ref().filter(|s| !s.is_empty())
            {
                manufacturer.clone()
            } else {
                format!("USB {:04x}:{:04x}", info.vid, info.pid)
            }
        }
        serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
        serialport::SerialPortType::PciPort => "PCI".into(),
        serialport::SerialPortType::Unknown => String::new(),
    }
}

/// Whether a name is a COM port name and nothing else.
///
/// This is a security gate, not a tidiness check, and it is the reason the
/// frontend is allowed to name a device at all. `serialport` opens a Windows
/// name by handing it to `CreateFile` under the `\\.\` prefix, which reaches
/// far more than serial hardware: named pipes and other devices live in the
/// same namespace. The frontend is the only caller, but the rule this codebase
/// already follows for `custom:<id>` shells is that an arbitrary path must
/// never cross the IPC boundary, and the same rule applies here. `COM` followed
/// by one to three digits can only ever name a serial port.
fn is_com_port(name: &str) -> bool {
    let Some(digits) = name.strip_prefix("COM") else {
        return false;
    };
    (1..=3).contains(&digits.len())
        && digits.bytes().all(|b| b.is_ascii_digit())
        && matches!(digits.parse::<u32>(), Ok(n) if (1..=256).contains(&n))
}

/// Sort key: COM10 comes after COM9, which a plain string sort gets wrong.
fn port_number(name: &str) -> u32 {
    name.strip_prefix("COM")
        .and_then(|d| d.parse::<u32>().ok())
        .unwrap_or(u32::MAX)
}

/// Bounds on the requested line speed. The low end is the slowest rate anything
/// has used in living memory; the high end is past what any USB adapter will
/// agree to, and the driver rejects what it cannot do. The point is only that a
/// number crossing the IPC boundary is a number in a sane range.
fn valid_baud(baud: u32) -> bool {
    (50..=4_000_000).contains(&baud)
}

/// The Windows device path for a COM port. `CreateFile` reaches a serial port
/// only through the `\\.\` device namespace, which is what `serialport` builds
/// internally and what [`refusal_reason`] has to reproduce to ask the same
/// question. Only ever called with a name [`is_com_port`] has already passed.
fn device_path(port_name: &str) -> String {
    format!(r"\\.\{port_name}")
}

/// Why Windows refused a port, when `serialport` will not say.
///
/// Its Windows backend folds `ERROR_ACCESS_DENIED` (someone else has the port),
/// `ERROR_FILE_NOT_FOUND` and `ERROR_PATH_NOT_FOUND` into a single
/// `ErrorKind::NoDevice`, and keeps only the OS's own localized message. So the
/// kind cannot tell "another program has it" from "it is gone", and the message
/// cannot be read without assuming the machine runs in English. That folding is
/// why the first version of this shipped saying *Access is denied* for a busy
/// port: the arm matching `Io(PermissionDenied)` was never reachable, and every
/// failure fell through to the branch that prints what the OS said.
///
/// Opening the same device name through `std::fs` asks Windows again and gets a
/// real `io::Error` back, which std maps to the right kind whatever language the
/// machine is in. Read-only, because a port held by another process refuses any
/// `CreateFile` regardless of the access requested, and asking for less is the
/// smaller thing to do to a piece of hardware.
///
/// Only ever called *after* the real open has already failed, so the working
/// path never touches the port twice. By then the port is either busy (this
/// fails the same way, having opened nothing) or absent.
fn refusal_reason(port_name: &str) -> std::io::ErrorKind {
    match std::fs::File::open(device_path(port_name)) {
        // It opened this time, so whatever refused a moment ago has let go, or
        // was never about the port being taken. Nothing useful to say; the
        // caller falls back to reporting what the OS said.
        Ok(_) => std::io::ErrorKind::Other,
        Err(e) => e.kind(),
    }
}

/// What the reader thread sends back: bytes off the wire, or the reason it
/// stopped. A serial port has no EOF, so a fault is the only way a session ends
/// other than by being closed, and it has to carry its message.
enum FromPort {
    Data(Vec<u8>),
    Fault(String),
}

/// How long a write may make no progress at all before the line is called dead.
/// Generous, because "no progress" at 2400 baud is an ordinary moment rather
/// than a symptom; this is here to stop a wedged port parking a thread forever,
/// not to police slowness.
const WRITE_STALL_LIMIT: Duration = Duration::from_secs(30);

/// Write every byte to the port, tolerating the read timeout that also applies
/// to writes.
///
/// `write_all` cannot be used here, and getting this wrong is not a rare edge
/// case. `serialport` has one timeout for both directions, so the 50ms that
/// keeps the reader responsive is also the write timeout, and a write that takes
/// longer than 50ms is *the normal case* on a serial line: four kilobytes pasted
/// into a 9600-baud console takes three and a half seconds. `write_all` reports
/// the first timeout as an error and gives no way to learn how many bytes went
/// out before it, so the naive version both killed the session and could not
/// have resumed it if it wanted to. Tracking the offset by hand does.
fn write_all_slowly(
    port: &mut dyn serialport::SerialPort,
    data: &[u8],
) -> std::io::Result<()> {
    let mut sent = 0;
    let mut last_progress = std::time::Instant::now();
    while sent < data.len() {
        match port.write(&data[sent..]) {
            // Should not happen on a serial port, but a driver that keeps
            // saying it wrote nothing costs no timeout, so without this pause
            // the stall limit below would be reached by spinning a core flat
            // for thirty seconds rather than by waiting.
            Ok(0) => std::thread::sleep(READ_TIMEOUT),
            Ok(n) => {
                sent += n;
                last_progress = std::time::Instant::now();
            }
            // Not a failure: the driver's buffer is full because the line is
            // busy carrying the last of it. Each of these already cost a
            // timeout, so this is a paced retry and not a spin.
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
        if last_progress.elapsed() > WRITE_STALL_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "the port accepted nothing for 30 seconds",
            ));
        }
    }
    port.flush()
}

/// Opens a COM port and wires it into the shared session registry, emitting
/// `pty:data` as bytes arrive and `pty:closed` when the line faults or the tab
/// is closed.
///
/// `cols` / `rows` are accepted and unused: see the module header. They are in
/// the signature so this matches the other two open paths and the command layer
/// does not have to remember which sources have a geometry.
pub fn open_serial<E: PtyEvents>(
    events: E,
    state: &PtyState,
    session_id: String,
    port_name: &str,
    baud: u32,
) -> AppResult<()> {
    if !is_com_port(port_name) {
        return Err(AppError::InvalidInput(format!(
            "not a serial port name: {port_name}"
        )));
    }
    if !valid_baud(baud) {
        return Err(AppError::InvalidInput(format!(
            "unsupported line speed: {baud}"
        )));
    }
    // Present-ness is checked for the message, not for safety (the name gate
    // above is the safety). "COM7 is not connected" is worth a great deal more
    // to someone who has just unplugged a dongle than "The system cannot find
    // the file specified."
    if !list_ports().iter().any(|p| p.name == port_name) {
        return Err(AppError::InvalidInput(format!(
            "{port_name} is not connected. Check the cable, then reopen the list."
        )));
    }

    let mut port = serialport::new(port_name, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|e| match e.kind() {
            // Busy or absent, and `serialport` reports both as this. Ask
            // Windows again to find out which; see `refusal_reason`.
            serialport::ErrorKind::NoDevice => match refusal_reason(port_name) {
                // The overwhelmingly likely first-run failure, and the OS
                // phrasing for it ("Access is denied") sends people looking for
                // a permissions problem they do not have.
                std::io::ErrorKind::PermissionDenied => AppError::State(format!(
                    "{port_name} is already open in another program. Close that terminal \
                     (PuTTY, Tera Term, a script, or another Broadside tab) and try again."
                )),
                // Enumerated a moment ago and gone by the time we opened it:
                // the dongle came out between the menu and the click.
                std::io::ErrorKind::NotFound => AppError::State(format!(
                    "{port_name} is no longer connected. Check the cable, then reopen the list."
                )),
                _ => AppError::State(format!("open {port_name}: {e}")),
            },
            _ => AppError::State(format!("open {port_name}: {e}")),
        })?;

    // Assert the modem control lines. Plenty of console cables and USB adapters
    // leave the device mute until they see these, which presents as a tab that
    // connects and then sits there dead however many times Enter is pressed.
    // Best effort: a port that does not support them still carries data.
    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);

    let mut reader = port
        .try_clone()
        .map_err(|e| AppError::State(format!("{port_name} reader: {e}")))?;

    let (epoch, mut rx) = state.register(session_id.clone());
    let state = state.clone();
    let write_port_name = port_name.to_string();

    // Blocking reader thread. There is no handle to pull away to make this stop
    // (that is how the ConPTY path ends its reader), because a serial port has
    // no EOF: it would go on timing out forever. So it is told, and it looks at
    // the flag once per timeout.
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = stop.clone();
    let (port_tx, mut port_rx) = tokio::sync::mpsc::channel::<FromPort>(64);
    let reader_port_name = port_name.to_string();
    let read_tx = port_tx.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while !reader_stop.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                // A quiet line, which is nearly all of the time. Not an error
                // and not an end: go round and re-check the stop flag.
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Ok(0) => continue,
                Ok(n) => {
                    if read_tx.blocking_send(FromPort::Data(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    // The adapter was unplugged, or the driver gave up. Say so:
                    // this is the one failure that happens mid-session and the
                    // banner is the only place the operator will see why.
                    let _ = read_tx.blocking_send(FromPort::Fault(format!(
                        "{reader_port_name} disconnected: {e}"
                    )));
                    break;
                }
            }
        }
    });

    // Blocking writer thread, and it has to be a thread rather than a few lines
    // in the async task below, because writing to a serial port is slow in a way
    // no pipe is. A kilobyte pasted into a 9600-baud console occupies the line
    // for the best part of a second and `flush` waits for the hardware to drain
    // it; doing that inline would park a runtime worker for seconds at a time
    // and, worse, leave the session unable to hear its own Close until the paste
    // finished. Out here it blocks nothing, and the ordering guarantee comes free
    // from there being one channel and one consumer.
    //
    // Unbounded on purpose. The only producer is a person typing, pasting, or
    // broadcasting a line, so the queue is human-sized; a bounded one would have
    // to decide what to do when a slow line fell behind, and every answer to
    // that (drop bytes, block, fault) is worse than holding a few kilobytes.
    let (write_tx, mut write_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let write_fault_tx = port_tx.clone();
    std::thread::spawn(move || {
        while let Some(data) = write_rx.blocking_recv() {
            if let Err(e) = write_all_slowly(port.as_mut(), &data) {
                let _ = write_fault_tx.blocking_send(FromPort::Fault(format!(
                    "{write_port_name} write failed: {e}"
                )));
                break;
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut message: Option<String> = None;
        let mut reader_done = false;

        let emit = |session_id: &str, bytes: &[u8], events: &E| {
            events.data(PtyData {
                session_id: session_id.to_string(),
                data_b64: B64.encode(bytes),
            });
        };

        loop {
            tokio::select! {
                msg = port_rx.recv(), if !reader_done => match msg {
                    Some(FromPort::Data(bytes)) => emit(&session_id, &bytes, &events),
                    Some(FromPort::Fault(m)) => {
                        message = Some(m);
                        break;
                    }
                    None => reader_done = true,
                },
                cmd = rx.recv() => match cmd {
                    Some(SessionCmd::Write(d)) => {
                        // Handing it to the writer thread cannot block, so a
                        // Close arriving behind a large paste is still answered
                        // at once. A send that fails means the writer has gone,
                        // which it only does after reporting why, so the fault
                        // arrives on the other arm and says something useful.
                        if write_tx.send(d).is_err() {
                            break;
                        }
                    }
                    // A serial line has no geometry to set. Accepted so the
                    // frontend can resize every pane the same way.
                    Some(SessionCmd::Resize { .. }) => {}
                    Some(SessionCmd::Close) | None => break,
                },
            }
        }

        // Stop both threads. The reader is told with the flag and notices within
        // one timeout; the writer notices its channel closing. Each drops its own
        // handle to the port as it goes, so the port is released once both have.
        stop.store(true, Ordering::Relaxed);
        drop(write_tx);

        // Only report if the entry is still ours (a re-open on the same id, or a
        // deliberate close, must not emit a stray pty:closed).
        if state.remove_if_current(&session_id, epoch) {
            events.closed(PtyClosed {
                session_id: session_id.clone(),
                // Nothing exited, so there is no code to report; the message
                // above is the whole account of why this ended.
                exit_code: None,
                message,
            });
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{device_path, is_com_port, list_ports, port_number, refusal_reason, valid_baud};

    #[test]
    fn only_com_names_are_accepted() {
        assert!(is_com_port("COM1"));
        assert!(is_com_port("COM3"));
        assert!(is_com_port("COM256"));
        // The gate exists to keep everything else in the Windows device
        // namespace out of CreateFile, so these are the cases that matter.
        assert!(!is_com_port(r"\\.\pipe\anything"));
        assert!(!is_com_port(r"\\.\COM3"));
        assert!(!is_com_port("CON"));
        assert!(!is_com_port("LPT1"));
        assert!(!is_com_port("COM"));
        assert!(!is_com_port("COM0"));
        assert!(!is_com_port("COM257"));
        assert!(!is_com_port("COM1234"));
        assert!(!is_com_port("COM3;calc"));
        assert!(!is_com_port("com3"));
        assert!(!is_com_port(""));
    }

    #[test]
    fn ports_sort_numerically() {
        // The bug a string sort produces: COM10 ahead of COM9.
        assert!(port_number("COM9") < port_number("COM10"));
        assert!(port_number("COM1") < port_number("COM2"));
    }

    #[test]
    fn a_port_name_becomes_a_device_path() {
        // A bare "COM3" handed to CreateFile is a filename in the working
        // directory; only the device namespace reaches the hardware.
        assert_eq!(device_path("COM3"), r"\\.\COM3");
    }

    #[test]
    fn an_absent_port_reads_as_not_found() {
        // The point of this one is the plumbing, not the answer. It proves the
        // device path actually reaches CreateFile through std::fs: a path std
        // mangled on the way would come back as InvalidInput or PermissionDenied
        // instead, and `refusal_reason` would then quietly stop telling a busy
        // port apart from a missing one, which is the bug it exists to fix.
        let name = "COM254";
        if list_ports().iter().any(|p| p.name == name) {
            return; // this machine really does have one
        }
        assert_eq!(refusal_reason(name), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn baud_is_bounded() {
        assert!(valid_baud(9600));
        assert!(valid_baud(115_200));
        assert!(!valid_baud(0));
        assert!(!valid_baud(10_000_000));
    }
}
