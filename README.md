# Broadside

**One command. Every machine. At once.**

Broadside is a Windows SSH console for people who run more than one server. Type a
command once and send it to every host at the same time, then drop into a full,
interactive terminal on any single machine the moment you need to work directly.
Your local Windows shells live in the same window, so managing a whole fleet and
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
- **Remote and local, together.** SSH hosts and local Windows shells (PowerShell,
  Command Prompt, WSL) sit side by side in one window.
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

### Local Windows shells
Open PowerShell, Command Prompt, and WSL right alongside your remote hosts, launch
several at once, and broadcast a command across them just like your SSH sessions.

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

Built and tested on **Windows 11**. Windows 10 is untested.

## Install

Download the latest `msi` from the [Releases](../../releases) page and run the
installer. When Windows shows `Publisher: Unknown`, that is expected for an unsigned
build: choose `Run anyway`. Open the `Help` tab at the bottom of the left rail to
learn any feature.

## Built with

Tauri 2, Rust, React, and TypeScript, for a small, fast, native Windows app.

## Local development

Prerequisites:

- Rust (stable, 1.95+)
- Node.js 20+ and npm
- Windows SDK (WebView2 is auto-installed by the Tauri bootstrapper)

Install and run:

```powershell
npm install
npm run tauri dev
```

Scripts:

- `npm run dev` - Vite frontend only (rarely useful without Tauri)
- `npm run tauri dev` - full app in dev mode
- `npm run typecheck` - `tsc -b`
- `npm run lint` - ESLint
- `npm run build` - production frontend build (the Tauri bundle is a separate step)

## Status

Actively developed. See the [Releases](../../releases) page for the latest version.

## License

Proprietary. All rights reserved. See [`NOTICE.md`](./NOTICE.md).
