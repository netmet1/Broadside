/**
 * The two reference tables in Help: every keyboard shortcut, and every warning
 * the app can put in front of you.
 *
 * Kept out of `HelpPage.tsx` because they are data, not prose: a table row is
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
        what: "Maximize the selected terminal to fill the window. Press it again to restore. Esc does not restore: it goes to the program in the terminal, since editors such as vi depend on it.",
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
        what: "Fill the screen with the grid: the sidebar, status bar, toolbar and tab strip slide away. Press it again to bring them back, or use the tab at the top of the screen. Esc does not leave fullscreen, so it still reaches vi.",
      },
      {
        keys: <Kbd>Esc</Kbd>,
        where: "Terminal controls",
        what: "Hand the keyboard back to the terminal after Ctrl+Shift+T put it in the toolbar. It does not leave fullscreen.",
      },
      {
        keys: <Kbd>Ctrl+Shift+T</Kbd>,
        where: "Terminals",
        what: "Put the keyboard into the toolbar, with a ring around the button that has focus. In fullscreen the hidden controls slide down too.",
      },
      {
        keys: (
          <>
            <Kbd>Tab</Kbd> / <Kbd>Shift+Tab</Kbd>
          </>
        ),
        where: "Terminal controls",
        what: "Move along the toolbar and tab strip once Ctrl+Shift+T has put you there. Tab wraps round at the last control. Esc goes back to the terminal.",
      },
      {
        keys: (
          <>
            <Kbd>Alt+Left</Kbd> / <Kbd>Alt+Right</Kbd>
          </>
        ),
        where: "Terminals",
        what: "Previous / next terminal tab, wrapping at the ends. Works with the focus inside a terminal; the shell never sees the key.",
      },
      {
        keys: (
          <>
            <Kbd>Left</Kbd> / <Kbd>Right</Kbd> then <Kbd>Enter</Kbd>
          </>
        ),
        where: "Tab strip",
        what: "Move along the tabs once Tab has put the keyboard on the tab strip (Home and End jump to the ends), then Enter or Space chooses one.",
      },
    ],
  },
  {
    group: "Inside a terminal",
    rows: [
      {
        keys: <Kbd>Ctrl+Shift+C</Kbd>,
        where: "Terminals",
        what: "Copy the selection and clear it, the same as right-clicking it. A terminal cannot see the Shift, so plain Ctrl+C is untouched and still interrupts what is running.",
      },
      {
        keys: <Kbd>Ctrl+Shift+V</Kbd>,
        where: "Terminals",
        what: "Paste the clipboard into the shell as if typed. Plain Ctrl+V is left to the shell.",
      },
      {
        keys: <Kbd>Right-click</Kbd>,
        where: "Terminals, Skills",
        what: "With text selected, copy it (a short toast confirms) and clear the highlight. With nothing selected, paste. A skill pane only copies: it never pastes into a run.",
      },
      {
        keys: <Kbd>Select with the mouse</Kbd>,
        where: "Terminals, Skills",
        what: "Selects text without copying it; right-click or press Ctrl+Shift+C to copy. Hold Shift to select in tmux or vim when they have the mouse on.",
      },
      {
        keys: <Kbd>Ctrl+mouse wheel</Kbd>,
        where: "Terminals, Skills",
        what: "Make the text in every terminal bigger or smaller, between 8 and 32 px. The size is saved in Settings, Appearance. Tick Strict beside that setting if a program in your terminal needs Ctrl and the wheel for itself.",
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
        what: "Step back and forth through the commands you have sent. Works from the first or last line, so editing a multi-line command still moves the cursor normally. What you had typed is kept, so you can always get back to it.",
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
        what: "Narrows the help to the sections that mention what you type, including these tables. Matches are marked in amber, with arrows beside the count to move between them. Punctuation is optional: ctrl shift g finds Ctrl+Shift+G. Each section in the list on the left shows how many matches it has, or says keyword when it matched a related word it does not actually use.",
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
          "This host's login shell is not one Broadside can fully work with. Terminals, broadcasts, file transfer and sudo auto-fill all work as normal, but MultiTerminal cannot separate its output into command blocks and skills cannot run here. In the Broadcast, PTY Broadcast, MultiTerminal and Skills lists the same warning is an amber triangle; hover it for the words. The host can still be selected, but a command written for bash may not mean the same thing to its shell.",
      },
      {
        message: <Msg>An amber “no shell” chip</Msg>,
        where: "Hosts in full; a triangle alone in the picker rails",
        means:
          "What this host runs at login is not a shell but, usually, an appliance's console menu (a pfSense admin account, for example). Broadside sends it nothing on connect, so the menu appears exactly as the device draws it. MultiTerminal command blocks and skills are unavailable; terminals, broadcasts and file transfer are not affected.",
      },
      {
        message: <Msg>An amber “shell unread” chip</Msg>,
        where: "Hosts in full; a triangle alone in the picker rails",
        means:
          "The connection worked, but the host would not say what its login shell is (a restricted account, for example), so Broadside sends nothing rather than guess. MultiTerminal command blocks and skills are unavailable. If you know the host runs bash or zsh, open it in Hosts and set Shell integration to Always. It can also mean the host was too slow to answer: a slow network home directory, or a .bashrc that loads tools such as nvm or conda before its interactive check. The same fix applies.",
      },
      {
        message: <Msg>An amber “no integration” chip</Msg>,
        where: "Hosts in full; a triangle alone in the picker rails",
        means:
          "Shell integration is set to Never on this host, so Broadside sends it nothing on connect. MultiTerminal command blocks and skills are unavailable while it is set. Change it in the host's form.",
      },
      {
        message: <Msg>“N checked hosts report no blocks”</Msg>,
        where: "MultiTerminal",
        means:
          "Those hosts will run every command you send but show nothing here, because this page needs bash or zsh with shell integration. Nothing is lost: the output is in each host's own terminal tab. Hover the message to see which hosts, and why.",
      },
      {
        message: <Msg>A red Test connection icon</Msg>,
        where: "Hosts",
        means:
          "The last attempt to reach this host failed (a test, a terminal, a broadcast, an SFTP session or a skill run). It is kept after a restart and clears itself the next time anything connects to the host successfully. Hover the button for the details, and see Logs for what went wrong.",
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
          "The server accepted the connection and then hung up during login. Most often the host is refusing too many logins at once (OpenSSH's MaxStartups, 10 by default). Broadside limits and retries these, so it should be rare; if it keeps happening, raise MaxStartups on the host or open fewer terminals at a time.",
      },
      {
        message: <Msg>Unreachable: connection timed out after 10s</Msg>,
        where: "Terminal pane",
        means:
          "Nothing answered on that address and port. The host is off, the port is wrong, or a firewall is dropping it. Not retried automatically: a host that is not there does not become there.",
      },
      {
        message: <Msg>Authentication failed: …</Msg>,
        where: "Terminal pane",
        means:
          "The host refused the credentials: wrong password, wrong username, or a key the host does not accept. A key passphrase problem looks different (see below).",
      },
      {
        message: (
          <Msg>
            The private key … is encrypted and no passphrase is stored for it
          </Msg>
        ),
        where: "Terminal pane, Files, Test connection",
        means:
          "The key file needs a passphrase and none is saved with it. Nothing was sent to the host. Edit the host, choose Replace credentials, and enter the passphrase. If you see this on a host that used to work, the key file has changed since you saved the host.",
      },
      {
        message: <Msg>This key is encrypted. Enter its passphrase to save it</Msg>,
        where: "Host form, under Key passphrase",
        means:
          "Broadside opened the key file you chose and found it encrypted, so the passphrase is required rather than optional for this one. The label above the field says so too.",
      },
      {
        message: <Msg>That passphrase does not open this key</Msg>,
        where: "Host form, under Key passphrase",
        means:
          "The file is a key and it is encrypted, but the passphrase entered does not decrypt it. Caught on save rather than at the first connect.",
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
        message: <Msg>The host key has changed: the connection was refused</Msg>,
        where: "Host-key dialog",
        means:
          "The server presented a different key from the one on record. That is either a rebuilt or re-keyed server, or the connection being intercepted. Nothing was sent and no password was offered. Do not accept it until you know which.",
      },
      {
        message: <Msg>host key changed: refused</Msg>,
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
        message: <Msg>A pill on that banner reading “SSH 12/14 86%”</Msg>,
        where: "Terminal pane, remote sessions only",
        means:
          "While the pane sits closed, Broadside keeps checking whether the host's SSH port is answering, so you can see when a rebooted machine is back. Green: answering now, so Reconnect should work. Red: not answering. Amber: missed the last check but has been answering. The figures cover the last two minutes. How often it checks is set on the host's form. It never logs in, and it stops when you reconnect or close the tab.",
      },
      {
        message: (
          <Msg>An amber line across the bottom of the pane, with “Got it”</Msg>
        ),
        where: "Terminal pane",
        means:
          "The same warning as the amber chip on the host row, shown once where you are working. Nothing is broken and the tab is usable. Got it hides it for that host until something about the host's shell changes.",
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
