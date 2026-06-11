use super::*;

fn hit_ids(command: &str) -> Vec<String> {
    check(command).into_iter().map(|h| h.rule_id).collect()
}

fn assert_hits(command: &str, expected: &[&str]) {
    let ids = hit_ids(command);
    assert_eq!(
        ids, expected,
        "command {command:?} expected {expected:?}, got {ids:?}"
    );
}

fn assert_clean(command: &str) {
    let ids = hit_ids(command);
    assert!(ids.is_empty(), "command {command:?} unexpectedly hit {ids:?}");
}

// ---- rm -rf ----

#[test]
fn rm_rf_combined_flags() {
    assert_hits("rm -rf /tmp/build", &["rm-rf"]);
}

#[test]
fn rm_rf_separate_flags() {
    assert_hits("rm -r -f /tmp/build", &["rm-rf"]);
}

#[test]
fn rm_rf_long_flags() {
    assert_hits("rm --recursive --force /data", &["rm-rf"]);
}

#[test]
fn rm_fr_reversed() {
    assert_hits("rm -fr /data", &["rm-rf"]);
}

#[test]
fn rm_capital_r() {
    assert_hits("rm -Rf /data", &["rm-rf"]);
}

#[test]
fn rm_recursive_only_is_clean() {
    assert_clean("rm -r olddir");
}

#[test]
fn rm_force_only_is_clean() {
    assert_clean("rm -f stale.lock");
}

#[test]
fn rm_behind_sudo() {
    assert_hits("sudo rm -rf /var/cache/app", &["rm-rf"]);
}

#[test]
fn rm_behind_sudo_user_flag() {
    assert_hits("sudo -u deploy rm -rf releases/old", &["rm-rf"]);
}

#[test]
fn rm_behind_env_assignment() {
    assert_hits("env LANG=C rm -rf ./x", &["rm-rf"]);
}

#[test]
fn rm_behind_nohup_nice_time() {
    assert_hits("nohup nice time rm -rf /scratch", &["rm-rf"]);
}

#[test]
fn rm_after_and_connector() {
    assert_hits("systemctl stop app && rm -rf /opt/app/cache", &["rm-rf"]);
}

#[test]
fn rm_after_semicolon() {
    assert_hits("true; rm -rf /x", &["rm-rf"]);
}

#[test]
fn rm_after_or_connector() {
    assert_hits("test -d /x || rm -rf /y", &["rm-rf"]);
}

#[test]
fn rm_inside_command_substitution() {
    assert_hits("echo $(rm -rf /tmp/x)", &["rm-rf"]);
}

#[test]
fn rm_inside_backticks() {
    assert_hits("echo `rm -rf /tmp/x`", &["rm-rf"]);
}

#[test]
fn rm_inside_substitution_in_double_quotes() {
    assert_hits("echo \"result: $(rm -rf /tmp/x)\"", &["rm-rf"]);
}

#[test]
fn rm_rf_quoted_as_data_is_clean() {
    // The dangerous string is data to grep, not a command.
    assert_clean("grep 'rm -rf' /var/log/audit.log");
}

#[test]
fn rm_rf_in_double_quoted_arg_is_clean() {
    assert_clean("echo \"never run rm -rf /\"");
}

#[test]
fn rm_full_path_binary() {
    assert_hits("/bin/rm -rf /data", &["rm-rf"]);
}

// ---- dd ----

#[test]
fn dd_to_device() {
    assert_hits("dd if=/dev/zero of=/dev/sda bs=1M", &["dd-device"]);
}

#[test]
fn dd_to_file_is_clean() {
    assert_clean("dd if=/dev/sda of=/backup/disk.img bs=1M");
}

// ---- mkfs ----

#[test]
fn mkfs_bare() {
    assert_hits("mkfs /dev/sdb1", &["mkfs"]);
}

#[test]
fn mkfs_dotted_variant() {
    assert_hits("mkfs.ext4 /dev/sdb1", &["mkfs"]);
}

// ---- partition tools ----

#[test]
fn fdisk_on_device() {
    assert_hits("fdisk /dev/sda", &["partition-tools"]);
}

#[test]
fn wipefs_on_device() {
    assert_hits("wipefs -a /dev/sdb", &["partition-tools"]);
}

#[test]
fn fdisk_list_only_is_clean() {
    // -l is read-only, but it still names a /dev path; the guard is
    // deliberately conservative here — reading a partition table via
    // broadcast is unusual enough that a CONFIRM is acceptable.
    assert_hits("fdisk -l /dev/sda", &["partition-tools"]);
}

#[test]
fn parted_without_device_is_clean() {
    assert_clean("parted --help");
}

// ---- shutdown family ----

#[test]
fn shutdown_now() {
    assert_hits("shutdown -h now", &["shutdown"]);
}

#[test]
fn reboot_plain() {
    assert_hits("reboot", &["shutdown"]);
}

#[test]
fn systemctl_poweroff() {
    assert_hits("systemctl poweroff", &["shutdown"]);
}

#[test]
fn systemctl_reboot() {
    assert_hits("sudo systemctl reboot", &["shutdown"]);
}

#[test]
fn systemctl_restart_service_is_clean() {
    assert_clean("systemctl restart nginx");
}

#[test]
fn init_zero() {
    assert_hits("init 0", &["shutdown"]);
}

#[test]
fn init_six() {
    assert_hits("init 6", &["shutdown"]);
}

#[test]
fn init_other_runlevel_is_clean() {
    assert_clean("init 3");
}

// ---- auth file truncation ----

#[test]
fn truncate_passwd() {
    assert_hits("echo x > /etc/passwd", &["truncate-auth-files"]);
}

#[test]
fn truncate_shadow_no_space() {
    assert_hits("cat /dev/null >/etc/shadow", &["truncate-auth-files"]);
}

#[test]
fn truncate_sudoers() {
    assert_hits("true > /etc/sudoers", &["truncate-auth-files"]);
}

#[test]
fn append_passwd_is_clean() {
    // >> appends; destructive truncation is the rule's scope.
    assert_clean("echo 'user:x:1001:' >> /etc/passwd");
}

#[test]
fn redirect_to_other_file_is_clean() {
    assert_clean("echo hello > /tmp/out.txt");
}

#[test]
fn reading_passwd_is_clean() {
    assert_clean("cat /etc/passwd");
}

// ---- recursive chmod/chown ----

#[test]
fn chmod_recursive_etc() {
    assert_hits("chmod -R 777 /etc", &["recursive-chmod-chown-system"]);
}

#[test]
fn chown_recursive_root_slash() {
    assert_hits("chown -R nobody /", &["recursive-chmod-chown-system"]);
}

#[test]
fn chmod_recursive_subpath_of_system_root() {
    assert_hits("chmod -R 600 /etc/ssl", &["recursive-chmod-chown-system"]);
}

#[test]
fn chmod_recursive_home_is_clean() {
    assert_clean("chmod -R 755 /home/deploy/app");
}

#[test]
fn chmod_non_recursive_etc_is_clean() {
    assert_clean("chmod 644 /etc/hosts");
}

#[test]
fn chmod_etcetera_lookalike_is_clean() {
    assert_clean("chmod -R 755 /etcetera");
}

// ---- fork bomb ----

#[test]
fn fork_bomb_spaced() {
    assert_hits(":(){ :|:& };:", &["fork-bomb"]);
}

#[test]
fn fork_bomb_compact() {
    assert_hits(":(){:|:&};:", &["fork-bomb"]);
}

// ---- pipe to shell ----

#[test]
fn curl_pipe_bash() {
    assert_hits("curl -fsSL https://example.com/install.sh | bash", &["pipe-to-shell"]);
}

#[test]
fn wget_pipe_sh() {
    assert_hits("wget -qO- https://x.io/setup | sh", &["pipe-to-shell"]);
}

#[test]
fn curl_pipe_sudo_bash() {
    assert_hits("curl -s https://x.io/i.sh | sudo bash", &["pipe-to-shell"]);
}

#[test]
fn curl_to_file_is_clean() {
    assert_clean("curl -o /tmp/installer.sh https://example.com/install.sh");
}

#[test]
fn curl_pipe_jq_is_clean() {
    assert_clean("curl -s https://api.example.com/health | jq .status");
}

#[test]
fn shell_then_curl_is_clean() {
    // Order matters: sh feeding curl is not the dangerous shape.
    assert_clean("sh -c 'date' && curl https://example.com");
}

// ---- crontab ----

#[test]
fn crontab_remove() {
    assert_hits("crontab -r", &["crontab-remove"]);
}

#[test]
fn crontab_list_is_clean() {
    assert_clean("crontab -l");
}

// ---- firewall ----

#[test]
fn iptables_flush() {
    assert_hits("iptables -F", &["firewall-flush"]);
}

#[test]
fn iptables_flush_long() {
    assert_hits("iptables --flush", &["firewall-flush"]);
}

#[test]
fn nft_flush_ruleset() {
    assert_hits("nft flush ruleset", &["firewall-flush"]);
}

#[test]
fn iptables_list_is_clean() {
    assert_clean("iptables -L -n");
}

#[test]
fn nft_list_ruleset_is_clean() {
    assert_clean("nft list ruleset");
}

// ---- account removal ----

#[test]
fn userdel() {
    assert_hits("userdel olduser", &["account-removal"]);
}

#[test]
fn groupdel() {
    assert_hits("sudo groupdel oldgroup", &["account-removal"]);
}

#[test]
fn passwd_delete() {
    assert_hits("passwd -d someuser", &["account-removal"]);
}

#[test]
fn passwd_change_is_clean() {
    assert_clean("passwd someuser");
}

// ---- multiple hits ----

#[test]
fn compound_command_multiple_hits() {
    let ids = hit_ids("rm -rf /opt/app && reboot");
    assert!(ids.contains(&"rm-rf".to_string()));
    assert!(ids.contains(&"shutdown".to_string()));
    assert_eq!(ids.len(), 2);
}

#[test]
fn duplicate_rule_reported_once() {
    assert_hits("rm -rf /a && rm -rf /b", &["rm-rf"]);
}

// ---- everyday commands stay clean ----

#[test]
fn everyday_commands_clean() {
    for cmd in [
        "uptime",
        "df -h",
        "free -m",
        "systemctl status nginx",
        "journalctl -u app --since today",
        "docker ps -a",
        "tail -n 100 /var/log/syslog",
        "ps aux | grep java",
        "find /var/log -name '*.gz' -mtime +30",
        "apt-get update && apt-get upgrade -y",
        "ls -la /etc",
        "du -sh /var/*",
        "ip addr show",
        "uname -a; hostname; id",
    ] {
        assert_clean(cmd);
    }
}

// ---- sudo rewrite (D-026) ----

#[test]
fn sudo_rewrite_simple() {
    let r = rewrite_for_sudo("sudo systemctl restart nginx");
    assert_eq!(r.command, "sudo -S -p '' systemctl restart nginx");
    assert!(r.needs_password);
}

#[test]
fn sudo_rewrite_preserves_quoting() {
    let r = rewrite_for_sudo("sudo sh -c 'echo \"a b\" > /tmp/x'");
    assert_eq!(r.command, "sudo -S -p '' sh -c 'echo \"a b\" > /tmp/x'");
}

#[test]
fn sudo_rewrite_compound() {
    let r = rewrite_for_sudo("sudo apt update && sudo apt upgrade -y");
    assert_eq!(
        r.command,
        "sudo -S -p '' apt update && sudo -S -p '' apt upgrade -y"
    );
}

#[test]
fn sudo_rewrite_mid_pipeline() {
    let r = rewrite_for_sudo("cat config | sudo tee /etc/app.conf");
    assert_eq!(r.command, "cat config | sudo -S -p '' tee /etc/app.conf");
}

#[test]
fn sudo_behind_nohup() {
    let r = rewrite_for_sudo("nohup sudo service app restart");
    assert_eq!(r.command, "nohup sudo -S -p '' service app restart");
}

#[test]
fn no_sudo_no_rewrite() {
    let r = rewrite_for_sudo("systemctl status nginx");
    assert_eq!(r.command, "systemctl status nginx");
    assert!(!r.needs_password);
}

#[test]
fn sudo_as_data_not_rewritten() {
    let r = rewrite_for_sudo("grep sudo /var/log/auth.log");
    assert_eq!(r.command, "grep sudo /var/log/auth.log");
    assert!(!r.needs_password);
}

#[test]
fn quoted_sudo_not_rewritten() {
    let r = rewrite_for_sudo("echo 'sudo rm'");
    assert_eq!(r.command, "echo 'sudo rm'");
    assert!(!r.needs_password);
}

#[test]
fn doas_detected_without_rewrite() {
    let r = rewrite_for_sudo("doas service app restart");
    assert_eq!(r.command, "doas service app restart");
    assert!(r.needs_password);
    assert!(r.has_doas);
}
