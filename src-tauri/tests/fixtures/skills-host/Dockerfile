# A host worth driving a skill against: a real OpenSSH server, a real bash login
# shell, and a sudo that asks for a password.
#
# Built and run by tests/skills_host/mod.rs, which is used by tests/skill_pane.rs
# only. Nothing here is shared with the linuxserver fixture the other SSH suites
# use: that one is an Alpine image whose login shell and sudo are not what an
# operator's host looks like, and the whole point of this one is that the shell
# behaves the way the engine assumes.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server sudo procps zsh ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# A user who is not root, with a password, and a sudo that asks for it. The
# password prompt is deliberate: the engine's sudo injector has to answer it.
RUN useradd --create-home --shell /bin/bash skilltest \
 && echo 'skilltest:skillpass-123' | chpasswd \
 && adduser skilltest sudo

RUN mkdir -p /run/sshd \
 && ssh-keygen -A \
 && printf '%s\n' \
      'PermitRootLogin no' \
      'PasswordAuthentication yes' \
      'PrintLastLog yes' \
      'PrintMotd no' \
      'AcceptEnv LANG LC_*' \
      > /etc/ssh/sshd_config.d/skilltest.conf

# Something for the connect-time MOTD reprint to find.
RUN printf 'Broadside skills test host. Nothing here is real.\n' > /etc/motd

# An interactive program to answer: prints a prompt with no newline, waits for a
# line, and says what it was told. This is the expect/send primitive's job.
RUN printf '%s\n' \
      '#!/bin/bash' \
      'printf "Continue? "' \
      'read -r answer' \
      'printf "confirmed-%s\n" "$answer"' \
      > /usr/local/bin/ask-confirm \
 && chmod +x /usr/local/bin/ask-confirm

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
