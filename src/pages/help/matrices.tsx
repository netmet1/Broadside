/**
 * The two reference tables in Help: every keyboard shortcut, and every warning
 * the app can put in front of you.
 *
 * Kept out of `HelpPage.tsx` because they are data, not prose — a table row is
 * added here when a key or a message is added to the app, and the page that
 * renders them does not need to grow to hold them.
 *
 * Both tables are a promise: a shortcut listed here works, and a message listed
 * here is one the app can actually produce. When you change a key or the words
 * of a warning, change it here in the same commit.
 */

import { Fragment, type ReactNode } from "react";

import { textOf } from "./searchText";

/** A key or chord, set apart from the prose around it. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="whitespace-nowrap rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] font-medium text-foreground">
      {children}
    </kbd>
  );
}

/** Wide tables scroll inside themselves rather than pushing the page sideways. */
function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-left text-xs">
        {children}
      </table>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="border-b border-border bg-muted/50 px-3 py-2 font-semibold">
      {children}
    </th>
  );
}

function Td({ children }: { children: ReactNode }) {
  return (
    <td className="border-b border-border/50 px-3 py-2 align-top">{children}</td>
  );
}

/** A heading row that names the part of the app the rows under it belong to. */
function GroupRow({ label, span }: { label: string; span: number }) {
  return (
    <tr>
      <td
        colSpan={span}
        className="border-b border-border bg-muted/30 px-3 py-1.5 font-heading text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </td>
    </tr>
  );
}

type ShortcutRow = { keys: ReactNode; where: string; what: string };
type ShortcutGroup = { group: string; rows: ShortcutRow[] };

const SHORTCUTS: ShortcutGroup[] = [
  {
    group: "Anywhere in Broadside",
    rows: [
      {
        keys: <Kbd>F11</Kbd>,
        where: "Terminals",
        what: "Maximize the selected terminal to fill the window, hiding every other part of the app. Press it again to restore. It works from inside a maximized terminal wherever you are.",
      },
      {
        keys: <Kbd>Ctrl+F</Kbd>,
        where: "Terminals, Broadcast, Logs",
        what: "Open the find bar for whatever output you are looking at, instead of sending Ctrl+F to the shell.",
      },
      {
        keys: <Kbd>Enter</Kbd>,
        where: "Find bar",
        what: "Go to the next match.",
      },
      {
        keys: <Kbd>Esc</Kbd>,
        where: "Find bar, dialogs, menus",
        what: "Close it without doing anything.",
      },
    ],
  },
  {
    group: "The Terminals grid",
    rows: [
      {
        keys: <Kbd>Ctrl+Shift+G</Kbd>,
        where: "Grid",
        what: "Fill the screen with the grid: the sidebar, status bar, toolbar and tab strip all go, and the tiles take the whole window. Press it again to bring them back. Deliberately not a function key — F10 belongs to mc and nano.",
      },
      {
        keys: <Kbd>Esc</Kbd>,
        where: "Grid fullscreen",
        what: "Leave fullscreen. With the keyboard in the controls strip it hands focus back to the terminal instead, and the next press leaves fullscreen.",
      },
      {
        keys: <Kbd>Ctrl+Shift+T</Kbd>,
        where: "Terminals",
        what: "Put the keyboard into the controls. In fullscreen the hidden strip slides down and its first button takes focus, with a ring around it so you can see where you are. This is the only way in: Tab inside a tile belongs to the shell.",
      },
      {
        keys: (
          <>
            <Kbd>Tab</Kbd> / <Kbd>Shift+Tab</Kbd>
          </>
        ),
        where: "Terminal controls",
        what: "Walk forwards and backwards along the toolbar and tab strip once Ctrl+Shift+T has put you there. The strip stays down the whole time, and Tab wraps round at the last control rather than dropping into the grid. Esc is the way out.",
      },
      {
        keys: (
          <>
            <Kbd>Alt+Left</Kbd> / <Kbd>Alt+Right</Kbd>
          </>
        ),
        where: "Terminals",
        what: "Previous / next terminal tab, wrapping at the ends. Works with the focus inside a terminal — the shell never sees the key.",
      },
    ],
  },
  {
    group: "Inside a terminal",
    rows: [
      {
        keys: <Kbd>Ctrl+Shift+C</Kbd>,
        where: "Terminals",
        what: "Copy the selection. A terminal cannot see the Shift, so plain Ctrl+C is untouched and still interrupts what is running.",
      },
      {
        keys: <Kbd>Ctrl+Shift+V</Kbd>,
        where: "Terminals",
        what: "Paste the clipboard into the shell as if typed. Plain Ctrl+V is left to the shell.",
      },
      {
        keys: <Kbd>Right-click</Kbd>,
        where: "Terminals",
        what: "Paste, the PuTTY and Windows Terminal way. No context menu appears.",
      },
      {
        keys: <Kbd>Select with the mouse</Kbd>,
        where: "Terminals",
        what: "Copies as soon as you let go of the button, with a short toast to confirm it. There is no separate copy step.",
      },
      {
        keys: <Kbd>Ctrl+mouse wheel</Kbd>,
        where: "Terminals, Skills",
        what: "Make the terminal text bigger or smaller, one step a notch, between 8 and 32 px. Every open terminal follows, and the size you stop on is saved in Settings, Appearance. Broadside takes this combination while the zoom is on, so the terminal does not see it: tick Strict beside that field to give it back to tmux, vim, htop and the fast scrollback.",
      },
      {
        keys: <Kbd>Tab</Kbd>,
        where: "Terminals",
        what: "The shell's own completion, always. Nothing in Broadside takes it.",
      },
    ],
  },
  {
    group: "Renaming a tab",
    rows: [
      {
        keys: <Kbd>Enter</Kbd>,
        where: "Tab rename",
        what: "Commit the new name. An empty name clears the override and the tab goes back to its shell name.",
      },
      {
        keys: <Kbd>Esc</Kbd>,
        where: "Tab rename",
        what: "Cancel and keep the old name.",
      },
    ],
  },
  {
    group: "The command composer (Broadcast, PTY Broadcast, MultiTerminal)",
    rows: [
      {
        keys: <Kbd>Enter</Kbd>,
        where: "Composer",
        what: "Send the command.",
      },
      {
        keys: <Kbd>Shift+Enter</Kbd>,
        where: "Composer",
        what: "Start a new line instead of sending, for a multi-line command.",
      },
      {
        keys: (
          <>
            <Kbd>Up</Kbd> / <Kbd>Down</Kbd>
          </>
        ),
        where: "Composer",
        what: "Walk back and forth through the commands you have sent. Only from the first / last line, so editing a multi-line command still moves the caret normally. What you had typed is kept as a stop on the cycle, so you can always get back to it.",
      },
    ],
  },
  {
    group: "SFTP Commander",
    rows: [
      {
        keys: <Kbd>Ctrl+click</Kbd>,
        where: "File list",
        what: "Add or remove one file from the selection.",
      },
      {
        keys: <Kbd>Shift+click</Kbd>,
        where: "File list",
        what: "Select everything between the last click and this one.",
      },
    ],
  },
  {
    group: "This help page",
    rows: [
      {
        keys: <Kbd>Type in the filter</Kbd>,
        where: "Help",
        what: "Searches everything a section says, including these tables, and keeps the ones that match: if you can read it here you can find it here. Matching words are marked in amber and the first is scrolled to, with arrows beside the count for the rest. Punctuation is optional: typing ctrl shift g finds Ctrl+Shift+G, and 16 20 finds 16/20. Each section in the list on the left carries the number of marks inside it. A section can also be found by words it does not use, such as the wrong name for a thing; it is kept with nothing marked in it and the list says keyword instead of a number.",
      },
    ],
  },
];

export function ShortcutMatrix() {
  return (
    <TableFrame>
      <thead>
        <tr>
          <Th>Key</Th>
          <Th>Where</Th>
          <Th>What it does</Th>
        </tr>
      </thead>
      <tbody>
        {SHORTCUTS.map((g) => (
          <Fragment key={g.group}>
            <GroupRow label={g.group} span={3} />
            {g.rows.map((r, i) => (
              <tr key={`${g.group}-${i}`}>
                <Td>{r.keys}</Td>
                <Td>
                  <span className="whitespace-nowrap text-muted-foreground">
                    {r.where}
                  </span>
                </Td>
                <Td>{r.what}</Td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </TableFrame>
  );
}

// The help filter searches what a section says, and a table built from data is
// invisible to a walk of the element tree. Publishing the words here, off the
// same array the table renders from, means a row that is added is searchable
// the moment it is added.
ShortcutMatrix.searchText = SHORTCUTS.map((g) =>
  [g.group, ...g.rows.map((r) => `${textOf(r.keys)} ${r.where} ${r.what}`)].join(
    " ",
  ),
).join(" ");

type WarningRow = { message: ReactNode; where: string; means: string };
type WarningGroup = { group: string; rows: WarningRow[] };

/** Quoted app text, so a row reads as "the words you saw". */
function Msg({ children }: { children: ReactNode }) {
  return (
    <span className="font-medium text-amber-700 dark:text-amber-300">
      {children}
    </span>
  );
}

const WARNINGS: WarningGroup[] = [
  {
    group: "On a host row",
    rows: [
      {
        message: <Msg>An amber chip naming a shell (fish, csh, tcsh, …)</Msg>,
        where: "Hosts in full; a triangle alone in the picker rails",
        means:
          "This host's login shell is not one of the Bourne-family shells Broadside can drive. Terminals, broadcast and file transfer all work as normal, and so does sudo password auto-fill; command block tracking is unavailable and skills cannot run here. The tab still opens looking like a fresh login, because the part of the setup that a shell like fish can read is still sent. The chip names whatever the host reported, and Broadside only reads a name it can recognise as a shell path — a chip naming something from your own startup script was a bug, fixed in 1.3.0. The chip is what the last completed connection read. It appears in the Broadcast, PTY Broadcast, MultiTerminal and Skills lists too, where the host stays selectable: nothing there is broken by it, but a command written for bash may not mean the same thing to that shell. Those lists are narrow, so there it is the amber triangle on its own and hovering it gives the words.",
      },
      {
        message: <Msg>An amber “no shell” chip</Msg>,
        where: "Hosts in full; a triangle alone in the picker rails",
        means:
          "What this host runs at login is not a shell at all. The usual case is an appliance that answers with a console menu — a pfSense admin account, for instance, whose login shell really is the menu program. Broadside sends such a host nothing whatsoever on connect and leaves the screen exactly as the host drew it. This is what stops the menu being printed twice: anything sent to it, even a harmless screen clear, is read as a menu selection and answered by redrawing. Command block tracking and skills are unavailable; terminals, broadcast and file transfer are not affected.",
      },
      {
        message: <Msg>An amber “shell unread” chip</Msg>,
        where: "Hosts in full; a triangle alone in the picker rails",
        means:
          "The connection succeeded but the host would not say what its login shell is — a forced command, a restricted account, or a server too slow to answer in time. Broadside sends nothing rather than guess, because guessing wrong on an appliance is what makes a console menu print itself twice. The cost is command block tracking and skills. If you know the host runs bash or zsh, open it in Hosts and set Shell integration to Always: both come back, and the chip goes.",
      },
      {
        message: <Msg>An amber “no integration” chip</Msg>,
        where: "Hosts in full; a triangle alone in the picker rails",
        means:
          "Not a problem with the host: Shell integration is set to Never on it, so Broadside sends it nothing on connect by your own instruction. Command block tracking and skills are unavailable while it is set. Change it in the host's form.",
      },
      {
        message: <Msg>“N checked hosts report no blocks”</Msg>,
        where: "MultiTerminal",
        means:
          "Those hosts will take every command you send and show nothing here, because this page reads markers that only bash and zsh install. It is not a hang and nothing is lost: the output is in each host's own terminal tab. Hover the message to see which hosts, and which of the two reasons applies — a shell that cannot take the markers, or one that could not be read and can be overridden in Hosts.",
      },
      {
        message: <Msg>A red Test connection icon</Msg>,
        where: "Hosts",
        means:
          "The last attempt to reach this host failed — a test, a terminal, a broadcast, an SFTP session or a skill run, whichever happened most recently. It is stored with the host rather than remembered for the session, so it is still there after a restart, which is the point: a machine that is down is usually still down tomorrow. It clears itself the first time anything connects to that host successfully, so there is nothing to dismiss. Hover the button for the wording, and see Logs for what actually went wrong.",
      },
      {
        message: <Msg>No credentials set</Msg>,
        where: "Hosts",
        means:
          "The host is saved but has no password or key stored, so nothing can connect to it. Edit the host and add one.",
      },
      {
        message: <Msg>A latency in milliseconds after a test</Msg>,
        where: "Hosts",
        means:
          "Not a warning. The connection was made, authenticated and closed again, and that is how long connect and auth took.",
      },
    ],
  },
  {
    group: "Opening a terminal",
    rows: [
      {
        message: <Msg>Unreachable: …</Msg>,
        where: "Terminal pane",
        means:
          "Broadside never got as far as a login. The rest of the line is the operating system's own words for why. Try again is beside Close tab, because most of these are worth a second attempt.",
      },
      {
        message: (
          <Msg>
            Unreachable: An existing connection was forcibly closed by the
            remote host. (os error 10054)
          </Msg>
        ),
        where: "Terminal pane",
        means:
          "The server accepted the connection and then hung up during the handshake. Most often that is OpenSSH's MaxStartups: it counts connections that have not finished authenticating, and past ten (the default) it starts dropping them — which is what opening a wall of terminals at once looks like from the server's side. Broadside now keeps at most eight handshakes in flight and retries a dropped one twice, so this should be rare; if it persists, raise MaxStartups on the host or open fewer at a time.",
      },
      {
        message: <Msg>Unreachable: connection timed out after 10s</Msg>,
        where: "Terminal pane",
        means:
          "Nothing answered on that address and port. The host is off, the port is wrong, or a firewall is dropping it. Not retried automatically — a host that is not there does not become there.",
      },
      {
        message: <Msg>Authentication failed: …</Msg>,
        where: "Terminal pane",
        means:
          "The host answered and refused the credentials. Wrong password, wrong key, wrong username, or the key needs a passphrase Broadside was not given.",
      },
      {
        message: <Msg>No credentials stored. Edit the host on the Hosts page.</Msg>,
        where: "Terminal pane, Broadcast",
        means: "Nothing was tried: there is no password or key saved for this host.",
      },
      {
        message: <Msg>Waiting on host-key verification…</Msg>,
        where: "Terminal pane",
        means:
          "The connection is held open while you answer the host-key dialog. Nothing is sent to the host until you do.",
      },
    ],
  },
  {
    group: "Host keys",
    rows: [
      {
        message: <Msg>This host's key is not known yet</Msg>,
        where: "Host-key dialog",
        means:
          "First connection to this address and port. Broadside has no key on record, so it is showing you the fingerprint the server presented and asking whether to trust it. Check it against the host itself before accepting.",
      },
      {
        message: <Msg>The host key has changed — the connection was refused</Msg>,
        where: "Host-key dialog",
        means:
          "The server presented a different key from the one on record. That is either a rebuilt or re-keyed server, or the connection being intercepted. Nothing was sent and no password was offered. Do not accept it until you know which.",
      },
      {
        message: <Msg>host key changed — refused</Msg>,
        where: "SFTP Broadcast",
        means: "The same thing, on one host of a batch. The others carried on.",
      },
    ],
  },
  {
    group: "While a terminal is open",
    rows: [
      {
        message: <Msg>A slim banner across the bottom of a tile</Msg>,
        where: "Terminal pane",
        means:
          "The shell has exited or the connection dropped. The scrollback is kept and stays readable; Reconnect starts a fresh shell on the same host, Close tab throws it away.",
      },
      {
        message: <Msg>Every terminal is hidden from the grid.</Msg>,
        where: "Grid",
        means:
          "Not a failure. Terminals are open but every one has been taken out of the grid from its tab. Use the grid button on a tab to bring one back.",
      },
    ],
  },
];

export function WarningMatrix() {
  return (
    <TableFrame>
      <thead>
        <tr>
          <Th>What you see</Th>
          <Th>Where</Th>
          <Th>What it means</Th>
        </tr>
      </thead>
      <tbody>
        {WARNINGS.map((g) => (
          <Fragment key={g.group}>
            <GroupRow label={g.group} span={3} />
            {g.rows.map((r, i) => (
              <tr key={`${g.group}-${i}`}>
                <Td>{r.message}</Td>
                <Td>
                  <span className="whitespace-nowrap text-muted-foreground">
                    {r.where}
                  </span>
                </Td>
                <Td>{r.means}</Td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </TableFrame>
  );
}

// As above: the words of every warning, so searching the message you are
// actually looking at finds the row that explains it.
WarningMatrix.searchText = WARNINGS.map((g) =>
  [
    g.group,
    ...g.rows.map((r) => `${textOf(r.message)} ${r.where} ${r.means}`),
  ].join(" "),
).join(" ");
