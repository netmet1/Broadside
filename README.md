# Broadside

**One command. Every machine. At once.**

Broadside is an SSH console for Windows and macOS, for people who run more than one
server. Type a command once and send it to every host at the same time, then drop
into a full, interactive terminal on any single machine the moment you need to work
directly. Your local shells live in the same window, so managing a whole fleet and
fixing one box no longer means juggling a dozen terminal tabs.

It is built for the everyday reality of operations: rolling the same update across a
group of servers, checking a setting everywhere at once, or babysitting a long
routine that you would rather not type out by hand ever again.

## Why Broadside

Most SSH tools make you choose. A broadcast tool blasts commands but gives you no
real shell. A terminal gives you a real shell but only one machine at a time.
Broadside refuses the trade-off:

- **Broadcast and interact.** Fan a command out to a group of hosts, then jump into
  a genuine interactive terminal on any one of them without opening a second app.
- **Remote and local, together.** SSH hosts and local shells (PowerShell, Command
  Prompt and WSL on Windows; zsh, bash and the rest on a Mac) sit side by side in
  one window.
- **Repeat without retyping.** Capture a sequence of commands as a **Skill** and let
  Broadside run it across your machines hands-free.

## Features

### Broadcast
Send one command to a whole group of SSH hosts in a single keystroke. Pick the
machines, type once, and watch the results come back from all of them.

### Real per-host terminals
Every host gets a full, interactive shell, not a stripped-down command runner. Open
as many concurrent sessions as you need and switch between them with tabs, or tile
them all at once in a **Grid** and pin exactly how many sit across and how big each
one is.

### Local shells
Open PowerShell, Command Prompt and WSL on Windows, or zsh, bash and any other shell
on a Mac, right alongside your remote hosts, launch several at once, and broadcast a
command across them just like your SSH sessions.

### Skills: automate the routine
Record a sequence of commands one time, then run it whenever you like. Broadside
watches each command's output and sends the next step at the right moment, waits for
a set time when it needs to, and can branch down a different path based on what a
command prints. A visual, zoomable flow map shows the whole routine at a glance, and
skills import and export in a click so you can share them.

### Stay organized
Color-code and tag your hosts so the right machines are always one click away, move
files across with the built-in SFTP browser, and keep an audit log of every command
and where it ran.

### Learn it in seconds
A built-in **Help** tab documents every feature, so there is nothing to look up
elsewhere.

## Platform

- **Windows:** built and tested on **Windows 11**. Windows 10 is untested.
- **macOS:** macOS 13.3 (Ventura) or later, as one app for Apple silicon and Intel.
  Saved passwords go in your login Keychain.

## Install

### Windows

Download the latest `msi` from the [Releases](../../releases) page and run the
installer. When Windows shows `Publisher: Unknown`, that is expected for an unsigned
build: choose `Run anyway`. Open the `Help` tab at the bottom of the left rail to
learn any feature.

Every release lists the installer's `SHA-256` in its notes, so you can confirm the
file you downloaded is the one that was built:

```powershell
Get-FileHash .\Broadside_x.y.z_x64_en-US.msi -Algorithm SHA256
```

The same hash is also attached to the release as a `.sha256` file. From v1.3.0,
each installer also carries a GitHub build attestation, a signed record that this
exact file was built from this repository by its release workflow. Check it with
the [GitHub CLI](https://cli.github.com/):

```powershell
gh attestation verify .\Broadside_x.y.z_x64_en-US.msi --repo netmet1/Broadside
```

Neither is a Windows code signature, so the `Publisher: Unknown` prompt still
appears.

### If Windows Defender flags it

An unsigned application that is only days old, has few users, and opens terminal
sessions fits the profile Defender's machine-learning heuristics are built to be
suspicious of. It has produced at least one false positive on Broadside
(`Trojan:Win32/Bearfoos.A!ml`), where the app was quarantined and had to be
restored from `Windows Security` under `Protection history`.

If it happens to you:

1. Check the `SHA-256` above matches the release notes. If it does not, do not
   restore it: report it instead.
2. Restore the file from `Windows Security` -> `Virus & threat protection` ->
   `Protection history`.
3. Please also [open an issue](../../issues) with the detection name and the
   version, so it can be reported to Microsoft as a false positive.

Adding a Defender exclusion will stop the prompts, but it is a blunt instrument
that also stops Defender protecting that path. It is a stopgap, not a fix. The
real fix is code signing, which is being worked on.

### macOS

Download the latest `dmg` from the [Releases](../../releases) page, open it, and
drag Broadside to Applications.

A build that is not notarized by Apple is stopped the first time you open it, with
a message that macOS cannot check it for malicious software. Control-click
Broadside in Applications and choose `Open`, or open `System Settings` ->
`Privacy & Security` and click `Open Anyway`. macOS then asks two things the first
time they come up; allow both:

- **Local Network**, the first time Broadside connects to a host on your own
  network. Without it, every LAN connection fails with `No route to host`.
- **Keychain**, the first time it saves or reads a password. Choose
  `Always Allow`.

An unsigned build asks both again after each update, because macOS ties those
permissions to the exact app they were given to.

The release notes list the disk image's `SHA-256` too, and the same
`.sha256` file and build attestation are attached:

```sh
shasum -a 256 Broadside_x.y.z_universal.dmg
gh attestation verify Broadside_x.y.z_universal.dmg --repo netmet1/Broadside
```

## Built with

Tauri 2, Rust, React, and TypeScript, for a small, fast, native app on Windows and
macOS.

## Local development

Prerequisites:

- Rust (stable, 1.95+)
- Node.js 20.19+ and npm
- On Windows: the Windows SDK (WebView2 is auto-installed by the Tauri bootstrapper)
- On macOS: the Xcode Command Line Tools (`xcode-select --install`)

Install and run (the same on both):

```sh
npm install
npm run tauri dev
```

A release build of each installer:

```sh
# Windows: the MSI, under src-tauri/target/release/bundle/msi
npm run tauri build

# macOS: one universal DMG, under
# src-tauri/target/universal-apple-darwin/release/bundle/dmg
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles dmg
```

`scripts/ci.ps1` (the local CI) and `scripts/release.ps1` are PowerShell. On a Mac,
`brew install powershell` and run them with `pwsh`.

Scripts:

- `npm run dev` - Vite frontend only (rarely useful without Tauri)
- `npm run tauri dev` - full app in dev mode
- `npm run typecheck` - `tsc -b`
- `npm run lint` - ESLint
- `npm run build` - production frontend build (the Tauri bundle is a separate step)

## Status

Actively developed. See the [Releases](../../releases) page for the latest version.

## Support

Broadside is free and open source. If it's useful to you, you can support
continued development with a one-time or recurring tip on
[Ko-fi](https://ko-fi.com/netmet). Thank you.

## License

Broadside is licensed under the [GNU General Public License v3.0](./LICENSE)
(`GPL-3.0-only`). You are free to use, study, share, and modify it; derivative
works must remain under the GPL. See [`NOTICE.md`](./NOTICE.md) for the copyright
notice and commercial-licensing contact.

## Inspiration

This application was inspired by **RadSSH**, a Python tool written by my friend and former colleague Paul. You can find it on [GitHub](https://github.com/radssh/radssh) and read the [docs here](https://radssh.readthedocs.io/en/v1.1.0/).