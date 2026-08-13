/**
 * The words of the Help centre: every section, in the order they are read.
 *
 * Split out of `HelpPage.tsx`, which was the page and the book in one file. The
 * page is the filter box, the contents list and the scrolling; this is what it
 * shows. Two things read from here and both want the prose without the page
 * around it: the page itself, and the release build of the help PDF, which
 * renders these same elements into a document (see `scripts/help-pdf`).
 *
 * Everything here is a plain element tree built once at module load. No hooks,
 * and nothing touches the DOM until a link is clicked, so it renders on a
 * server as happily as in the app.
 *
 * The `data-h` attributes are how the PDF knows what a piece of prose *is*. The
 * Tailwind classes beside them style a screen and mean nothing on paper, so the
 * print stylesheet matches on these instead. Add one to any new wrapper here
 * that carries meaning rather than decoration.
 */

/* eslint-disable react-refresh/only-export-components */
// What this file exports is prose, not a component: the wrappers below are
// private, and there is no boundary here for fast refresh to hold on to.

import { type ReactNode } from "react";

import { ShortcutMatrix, WarningMatrix } from "@/pages/help/matrices";

/** Stable DOM id for a glossary entry, used by inline term links. */
function glossaryId(term: string): string {
  return "help-sec-glossary-" + term.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Smooth-scroll a section or glossary entry to the top of the scroll area.
 * The `help-sec-` scroll-margin rule in index.css keeps it clear of anything
 * pinned at the top. */
export function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** An inline link to another help section (not a glossary term). */
function SectionLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <a
      href={"#" + id}
      onClick={(e) => {
        e.preventDefault();
        scrollToId(id);
      }}
      data-h="link"
      className="font-medium text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {children}
    </a>
  );
}

/** An inline link to a glossary entry. Renders the term text and jumps to its
 * definition when clicked. */
function Term({ term, children }: { term: string; children?: ReactNode }) {
  return (
    <a
      href={"#" + glossaryId(term)}
      onClick={(e) => {
        e.preventDefault();
        scrollToId(glossaryId(term));
      }}
      data-h="term"
      className="font-medium text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
      title="Jump to definition"
    >
      {children ?? term}
    </a>
  );
}

// Without children this puts the term itself on the page, and a walk of the
// element tree would find nothing there to search for. See ./help/searchText.
Term.searchProps = ["term"] as const;

/** Accent for the names of app areas and named controls (tabs, buttons, key
 * settings), so they stand out from the surrounding prose. Distinct from the
 * dotted-underline glossary links above and from the emerald/amber/red status
 * colors used elsewhere in the app. */
function Nav({ children }: { children: ReactNode }) {
  return (
    <span data-h="nav" className="font-medium text-sky-600 dark:text-sky-400">
      {children}
    </span>
  );
}

/** A high-level lead paragraph, visually distinct from the detail that follows. */
function Lead({ children }: { children: ReactNode }) {
  return (
    <p data-h="lead" className="text-[0.95rem] text-foreground">
      {children}
    </p>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return (
    <div
      data-h="detail"
      className="space-y-2 border-l-2 border-border/60 pl-4"
    >
      {children}
    </div>
  );
}

function H3({ children }: { children: ReactNode }) {
  return (
    <h3 data-h="h3" className="font-heading text-sm font-semibold text-foreground">
      {children}
    </h3>
  );
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

/** Glossary terms, in display order. Each gets an anchor that inline term
 * links target. Definitions are written for a non-specialist reader. */
const GLOSSARY: { term: string; label: string; def: ReactNode }[] = [
  {
    term: "SSH",
    label: "SSH (Secure Shell)",
    def: (
      <>
        A network protocol for running commands on another computer over an
        encrypted connection. Broadside uses SSH to reach every host you add.
        All traffic between the app and a host travels inside this encrypted
        channel.
      </>
    ),
  },
  {
    term: "sftp",
    label: "SFTP (SSH File Transfer Protocol)",
    def: (
      <>
        A way to browse and copy files over an <Term term="SSH" /> connection,
        using the same login and encrypted channel as a remote shell. Broadside's
        SFTP tab uses it to move files to and from your hosts; nothing travels
        outside the SSH session.
      </>
    ),
  },
  {
    term: "PTY",
    label: "PTY (pseudo-terminal)",
    def: (
      <>
        A two-way text channel that behaves like a real terminal screen and
        keyboard. Interactive programs (a login shell, a text editor, a progress
        bar) need a PTY so they can redraw the screen and read keystrokes. Each
        Terminals tab opens its own PTY.
      </>
    ),
  },
  {
    term: "ConPTY",
    label: "ConPTY (Windows pseudo-console)",
    def: (
      <>
        Windows' built-in version of a <Term term="PTY" />. Broadside uses it
        to run local Windows shells (PowerShell, Command Prompt, WSL) inside a
        Terminals tab, the same way it runs remote shells over <Term term="SSH" />.
      </>
    ),
  },
  {
    term: "shell",
    label: "Shell",
    def: (
      <>
        The program that reads the commands you type and runs them, for example
        bash on Linux or PowerShell on Windows. A terminal tab is a window onto a
        shell.
      </>
    ),
  },
  {
    term: "posix",
    label: "POSIX",
    def: (
      <>
        The standard that Unix-like systems agree on, and the reason a command
        typed for Linux usually works on macOS or inside WSL. In Broadside it is
        the name of a <Term term="shell" /> family: a Bash-like terminal such as
        Git Bash, MSYS2 or Cygwin speaks the same command language as a Linux
        host, so those tabs are grouped with WSL rather than with PowerShell or
        Command Prompt. A custom terminal set to the Bash-like language is shown
        with a <code>posix</code> tag and joins the <Nav>WSL / POSIX</Nav> tab in{" "}
        <Nav>PTY Broadcast</Nav>, which keeps a broadcast command valid for
        everything it reaches.
      </>
    ),
  },
  {
    term: "sudo",
    label: "sudo",
    def: (
      <>
        A Unix command that runs another command with administrator rights. It
        usually asks for your password first. Broadside can fill that password
        prompt for you when the feature is turned on (see the Security section).
      </>
    ),
  },
  {
    term: "TOFU",
    label: "TOFU and host keys",
    def: (
      <>
        Every <Term term="SSH" /> server has a unique host key, a fingerprint
        that proves it is the same machine you connected to before. TOFU (Trust
        On First Use) means the app remembers a host's key the first time you
        connect and warns you if it ever changes, which can signal that the
        connection is being intercepted.
      </>
    ),
  },
  {
    term: "key-vs-password",
    label: "SSH key vs password",
    def: (
      <>
        Two ways to prove who you are to an <Term term="SSH" /> server. A
        password is a secret you type. An SSH key is a pair of files (a private
        key you keep and a public key the server holds); the private key can be
        protected by a passphrase. Keys are generally more secure than passwords.
      </>
    ),
  },
  {
    term: "passphrase",
    label: "Key passphrase",
    def: (
      <>
        A secret that unlocks an SSH private key file, so that simply copying
        the file is not enough to use it. Optional when the key is created, but
        required to use a key that has one. It never reaches the host: it
        decrypts the file on your own machine before the connection is made.
        Broadside stores it for you in the same protected place as your other
        secrets, and checks it when you pick the key.
      </>
    ),
  },
  {
    term: "credential-manager",
    label: "Windows Credential Manager",
    def: (
      <>
        A secrets vault built into Windows, tied to your Windows user account.
        Broadside stores passwords and passphrases here first so they are
        protected by your Windows login and never kept in plain text.
      </>
    ),
  },
  {
    term: "argon2",
    label: "argon2",
    def: (
      <>
        A modern password-hashing algorithm. Hashing turns a passcode into a
        fixed fingerprint that cannot be reversed back into the original. The
        admin lock stores only this fingerprint, so the passcode itself is never
        saved anywhere.
      </>
    ),
  },
  {
    term: "csv",
    label: "CSV",
    def: (
      <>
        A plain-text spreadsheet format (comma-separated values) where each line
        is one record. Broadside can import a list of hosts from a CSV file.
        The importer never reads passwords from the file.
      </>
    ),
  },
  {
    term: "exec-channel",
    label: "Exec channel",
    def: (
      <>
        A way to run a single command on a host over <Term term="SSH" /> and
        collect its output, without opening a full interactive screen. Broadcast
        uses this. It is faster for one-shot commands but cannot drive
        interactive programs.
      </>
    ),
  },
  {
    term: "ansi",
    label: "ANSI and xterm",
    def: (
      <>
        ANSI codes are the invisible control sequences a program sends to color
        text, move the cursor and clear the screen. xterm is the long-standing
        terminal standard those codes follow. Broadside renders them so remote
        output looks the way it would in a native terminal.
      </>
    ),
  },
];

export type HelpSection = {
  id: string;
  title: string;
  /** Words the section does *not* say that should still find it: the wrong name
   * for a thing, the symptom rather than the feature, the term someone arrives
   * with. What the section does say is searched from the body itself.
   *
   * Not a phrase another section *does* say. `16/20 sessions connected` was
   * kept here from when keywords were the whole index, and it listed Terminals
   * beside the Overview that could actually show the words, with nothing in it
   * to mark. Once a phrase is on the page, it belongs to the page that says it. */
  keywords: string;
  body: ReactNode;
};

export const SECTIONS: HelpSection[] = [
  {
    id: "help-sec-overview",
    title: "Overview and getting started",
    keywords:
      "intro introduction start home rail sidebar navigation theme dark light maximize fullscreen status bar hint version window size dimensions resolution pixels how big width height 1024x700 minimum smallest font size terminal app application point px live readout bottom left corner what are those numbers three numbers keep disappearing hint replaces them hint stuck on screen stays forever wont go away numbers gone idle timeout three and a half seconds mouse resting on button walked away esc escape key does not exit fullscreen why not restore f11 only vi vim insert mode editor keeps the key",
    body: (
      <>
        <Lead>
          Broadside is an SSH console built around one idea: send one command
          to many machines at once, while still giving each machine its own full
          interactive terminal when you need it. It also opens local Windows
          shells in the same window.
        </Lead>
        <Detail>
          <H3>The left rail</H3>
          <p>
            The buttons down the left side switch between the main areas of the
            app: <Nav>Hosts</Nav>, <Nav>Terminals</Nav>, <Nav>Broadcast</Nav>,{" "}
            <Nav>PTY Broadcast</Nav>, <Nav>MultiTerminal</Nav>, <Nav>Skills</Nav>,{" "}
            <Nav>SFTP</Nav>, <Nav>Logs</Nav> and <Nav>Settings</Nav>. <Nav>Help</Nav> and{" "}
            <Nav>About</Nav> sit at
            the bottom. The rail collapses to icons only on narrow windows, or
            with the collapse button at the top. Drag its right edge to resize
            it, or double-click that edge to reset the width.
          </p>
          <H3>Finding your way</H3>
          <Bullets>
            <li>
              Hover almost any control and a short explanation appears in the
              status bar along the bottom of the window. The right-hand end of
              that bar counts what the page is showing. On{" "}
              <Nav>Terminals</Nav> that is how many tabs are open, and it
              becomes a pair like <Nav>16/20 sessions connected</Nav> as soon as
              one of them is not: the second number is the tabs, the first is
              the ones with a live connection, and the difference is the tabs
              showing red.
            </li>
            <li>
              When nothing is being hovered, that same left-hand end shows three
              live numbers instead: the window size, the terminal font size and
              the app font size. The window size is the drawing area in the
              units the window is sized in, so dragging the window as small as
              it goes reads <Nav>1024x700</Nav>. All three follow a change as
              you make it, which is the point of them: drag an edge, or hold{" "}
              <Nav>Ctrl</Nav> and turn the wheel over a terminal, and watch the
              number rather than guessing. Hover any control and they step aside
              for its hint, then come back when you move off it, or after about
              three and a half seconds with nobody at the machine. Reading a
              hint counts as being there, because moving the mouse resets that
              clock; what it catches is a pointer left resting on a button with
              the room empty. Turning hints
              off in <Nav>Settings</Nav> leaves them showing all the time.
            </li>
            <li>
              The current app version is shown next to the Broadside name at
              the top of the rail and in the About dialog.
            </li>
            <li>
              Switch between light and dark appearance in <Nav>Settings</Nav>,
              under <Nav>Appearance</Nav>.
            </li>
            <li>
              Press <Nav>F11</Nav> (or the maximize button on a terminal tab) to
              fill the whole window with a single terminal, and <Nav>F11</Nav>{" "}
              again to return. <b>Esc does not come back out</b>, in either
              fullscreen, and that is deliberate: Esc is the key{" "}
              <code>vi</code> is built around, and the program most likely to be
              running full-screen in a terminal is an editor. Taking a press of
              it to resize a window would cost more than it saved, so Esc goes
              straight through to whatever you are running. Use <Nav>F11</Nav>,
              or the restore button in the banner along the top. The banner
              names the terminal you are looking at, and{" "}
              <Nav>Alt+Left</Nav> / <Nav>Alt+Right</Nav> still change sessions
              while you are maximized, so the name changes with them.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-hosts",
    title: "Hosts",
    keywords:
      "server add edit import csv credentials password key sudo color status online offline columns multi-select connect tags tag chip filter sort group untagged hidden missing fields resize column find by label search box query narrow amber chip warning login shell unsupported what does it mean shell integration auto always never console menu pfsense rc.initial no shell shell unread override command block tracking import export menu",
    body: (
      <>
        <Lead>
          The <Nav>Hosts</Nav> tab is your address book of machines to connect
          to. Each host records how to reach it (address, port, username) and how
          to sign in.
        </Lead>
        <Detail>
          <H3>Adding and editing hosts</H3>
          <Bullets>
            <li>
              Give each host a label, address, port and username. You can assign
              a color so the host is easy to spot across the app.
            </li>
            <li>
              Choose how to sign in: a <Term term="key-vs-password">password</Term>{" "}
              or an <Term term="key-vs-password">SSH key</Term> (with an optional{" "}
              <Term term="passphrase" />). You can also store a{" "}
              <Term term="sudo" /> password for administrator commands.
            </li>
            <li>
              Pick a key file and Broadside opens it there and then, so it can
              tell you whether it is encrypted before you save. If it is, the
              passphrase field changes from optional to required and saving
              without one is refused, as is a passphrase that does not open the
              key. This is the only place a key passphrase can be asked for: it
              decrypts a file on your own machine before the connection is made,
              so the host never sees it and a terminal can never prompt for it.
            </li>
            <li>
              For your safety, saved passwords and passphrases are never shown
              again after you save them. You can replace a secret, but the app
              will not display the stored value. See the{" "}
              <SectionLink id="help-sec-security">Security section</SectionLink>{" "}
              for where these are kept.
            </li>
            <li>
              A host row can carry a small amber chip, most often the name of a
              login shell Broadside cannot fully drive.{" "}
              <SectionLink id="help-sec-warnings">
                Warnings and messages
              </SectionLink>{" "}
              lists every chip, banner and error the app can show you and what
              each one actually means.
            </li>
            <li>
              <b>Shell integration</b>, its own card at the foot of the host's
              form, is the answer to that chip. When a terminal opens,
              Broadside normally sends one setup line that installs the markers
              command block tracking reads, clears the login banner and reprints
              it, so the tab looks like a fresh login. Whether that line is safe
              depends on what is on the other end, and the form shows what the
              last connection found. <Nav>Auto</Nav> believes it, and is the
              default. <Nav>Always</Nav> says the host really is bash or zsh
              whatever it reports, which is what to use for a machine that will
              not answer the question (a forced command, a restricted account)
              and is losing command block tracking because of it. It answers a
              question the connection could not, rather than overruling one it
              could: a host that named its shell keeps its chip, because sending
              the line to fish does not make fish able to use it.{" "}
              <Nav>Never</Nav> sends the host nothing at all and leaves its
              login screen exactly as it draws it. Appliances that greet you
              with a console menu rather than a shell are detected and left
              alone on their own, without needing this set. The setting is read
              when a terminal opens, so it applies to the next tab you open on
              that host rather than to one already running.
            </li>
            <li>
              The same mark appears wherever a host is picked: the{" "}
              <Nav>Broadcast</Nav>, <Nav>PTY Broadcast</Nav>,{" "}
              <Nav>MultiTerminal</Nav> and <Nav>Skills</Nav> lists, as the
              amber triangle on its own, with the words on hover. Those lists
              are narrow and the label is what you are reading there. Nothing is
              ever hidden from a list for this: broadcasting to a shell
              Broadside cannot drive works perfectly well, and a host that
              quietly vanished would be far harder to explain than one that is
              marked.
            </li>
          </Bullets>
          <H3>Importing many hosts</H3>
          <p>
            <Nav>Import hosts…</Nav> and <Nav>Export hosts…</Nav> are both in
            the <Nav>Import / Export</Nav> menu at the top of the page.{" "}
            <Nav>Import</Nav> loads a list of hosts from a{" "}
            <Term term="csv" /> file. The importer only reads connection details,
            never passwords. If a label is already in use for a different machine,
            the import keeps both by adding a numbered suffix (for example web
            becomes web-2).
          </p>
          <p>
            Tip: to build that file without guessing the format, add one host
            here manually first, use <Nav>Export</Nav> to save the list to a CSV
            or spreadsheet, then fill in the rest of your hosts in that same file
            (keeping its column headers) and <Nav>Import</Nav> it back.
          </p>
          <H3>Working with the list</H3>
          <Bullets>
            <li>
              The <Nav>Status</Nav> column shows whether each host currently
              answers on the network. Its header is the single letter S when the
              column is narrow.
            </li>
            <li>
              A colored dot marks hosts that have a live terminal connection open
              right now.
            </li>
            <li>
              Select several hosts and open a terminal for all of them at once.
            </li>
            <li>
              The <Nav>Find by label…</Nav> box at the top right narrows the table
              to hosts whose label matches what you type (case-insensitive), the
              same as the search boxes on the broadcast rails. It combines with the
              tag filter and clears with the <Nav>x</Nav>.
            </li>
            <li>
              You can hide columns you do not use from <Nav>Settings</Nav>, under{" "}
              <Nav>Appearance</Nav>. When a column is hidden, each row gets a small
              tag/label icon in its <Nav>Actions</Nav>; click it to see that host's
              values for the hidden columns.
            </li>
          </Bullets>
          <H3>Tags</H3>
          <Bullets>
            <li>
              Give a host one or more tags to group machines (for example prod,
              web, eu). Separate multiple tags with commas. Each tag shows as its
              own small chip in the <Nav>Tag</Nav> column; untagged hosts show a
              dash. As you type a tag on the host form, a dropdown suggests
              matching tags already used elsewhere, so spellings stay consistent.
            </li>
            <li>
              Click the <Nav>Tag</Nav> header to sort by the host's first tag
              (untagged hosts sink to the bottom, or rise to the top when you
              reverse the sort).
            </li>
            <li>
              The filter icon in the <Nav>Tag</Nav> header opens a checklist of
              every tag in use. Uncheck tags to hide the hosts that only carry
              them; a host stays visible as long as one of its tags is still
              checked. The icon is highlighted while a filter is active, and the
              status bar shows how many hosts are being shown. The filter lasts for
              the session and resets when you restart the app.
            </li>
            <li>
              Drag the separator on the right edge of the <Nav>Tag</Nav> column to
              resize it, or double-click that edge to fit it to the contents. The
              width is remembered.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-terminals",
    title: "Terminals",
    keywords:
      "terminal tab interactive shell local powershell pwsh wsl cmd command prompt drag reorder find search maximize close all conpty pty plus launcher path restart shortcut commands scope alt arrow switch next previous keyboard navigation copy paste clipboard right-click select ctrl shift c v go to session jump scroll center grid tiled layout split screen tabs toggle side by side watch several settings columns across item width height characters rows pin fixed size horizontal scroll auto profile profiles saved launch working directory folder browse startup command name label how many claude open in directory eye hide show title bar header chrome peek hover outline host colour selected active tile denser rename pencil tab name title exclude ignore hide from grid order rearrange match two terminals side by side full window fullscreen ctrl shift g keyboard shortcut not f10 mc nano function key strip reveal slide focus controls ctrl shift t toolbar keyboard reach tab key drag resize tile edge corner handle reset size temporary this session only not saved single terminal fills ignores grid settings custom terminal application git bash msys2 cygwin exe program arguments browse add your own posix family command language broadcast rail send to several at once composer targets in place reset display redraw garbled stuck full screen prompt dialog box debconf needrestart kernel upgrade escape sequences echoed arrow keys not working enter tab unresponsive noninteractive ctrl l redraw prompt blank pane after reset why no ctrl c interrupt stray ^l character while command running sleep long command still clears output disappeared missing after reset display screen wiped when command finished withdraw redraw type ahead kept reset grid strict checkbox drag saved written to settings lost on restart short last row stretch tall tile in the last column leave the gap fill hole uneven columns trimmed to terminals open auto fit fewer than columns try again retry failed connection unreachable close tab focus ring where is the keyboard esc leaves the strip back to the terminal tab wraps does not go into the grid hidden buttons appear when focused status bar count sessions connected red tab not connected magnify enlarge shrink squint hard to read focus follows mouse hover highlight which tile is active where does my typing go paste lands wrong terminal mouse over outline moves view menu sessions menu grouped controls toolbar crowded buttons missing where did the button go reset grid reset display side by side compact tab labels small window narrow 1024 rail fits tiles too small grid unusable ridiculous cramped one column stacked single column instead of two why did the grid stack minimum window size small screen laptop 16 inch large monitor app font size big text buttons lost their labels icons only sessions button cut off clipped edge horizontal scrollbar chrome too big too many terminals open at once how many can i watch greyed out ghosted dimmed pale disabled menu entry vanished where did reset grid go why cant i click it full tab labels checkbox tick empty box unchecked initials dot esc does nothing in fullscreen does not exit maximized terminal grid ctrl shift g only vi vim editor keeps escape empty grid nothing to show view menu disappears behind strip menu cut off top of screen dropdown clipped in fullscreen pull tab handle grabber top centre middle of the top edge how do i get the toolbar back controls gone cant find the toolbar in fullscreen top edge does not open the strip any more moving the mouse to the top does nothing click the tab tab does not open the strip nothing happens when i hover the tab strip blinks flickers bounces after closing a menu focus changes too fast moving to the toolbar sweeping across tiles crossing a tile on the way wrong tile became active settle pause delay before focus moves shortcut list changed to the wrong session go button keeps the keyboard stuck in the toolbar cannot type after pressing go have to click the tile again serial console com port baud rate line speed 9600 115200 8n1 console cable usb serial adapter router switch firewall rs232 db9 rj45 rollover port already in use access denied putty tera term blank pane press enter garbage characters wrong speed unplugged disconnected select a tab with the keyboard arrow keys along the tab strip cannot reach the tabs by tabbing home end enter choose session no mouse typing went into the other window wrong application typed in my browser by mistake keystrokes lost window not focused not the active window inactive background looks active but is not scroll bars appear on hover when unfocused alt tab back to broadside outline moved while i was away click to activate first click activates and selects hover does not focus the window focus follows mouse across applications how many matches find bar does not say how many no count number of results 3 of 17 which match am i on next previous match highlight all matches yellow search scrollback for a word ctrl f in a terminal search says nothing found when there are matches retry all close failed unhide all bulk repair reconnect everything red tabs at once clear away dead tabs remove failed connections tidy up serial shortcut scope greyed go button disabled no commands for com port no serial shortcuts empty picker list nothing to pick manage shortcuts add the first one console cable cisco ios show version tab colour color local shell tint powershell blue command prompt wsl which tab am i typing in profile colour my font is missing inter segoe ui arial proportional not in the list why cant i pick my favourite font variable width scrollback scroll back buffer history how far up can i scroll output cut off truncated lost older lines gone only 1000 lines 5000 lines memory per pane raise the limit end a session hang up disconnect without closing the tab unplug keep the pane keep the output stay on screen close the shell not the tab mangled garbled box drawing characters question marks accents emoji utf-8 unicode code page 437 chcp 65001 claude logo ascii art broken corners weird symbols in powershell local shell encoding",
    body: (
      <>
        <Lead>
          <Nav>Terminals</Nav> gives you full, interactive terminal sessions, one
          per tab. Each tab is a real <Term term="shell" /> running over a{" "}
          <Term term="PTY" />, so editors, progress bars and anything that needs a
          live screen all work normally.
        </Lead>
        <Detail>
          <H3>Remote and local shells</H3>
          <Bullets>
            <li>
              Open a remote shell by starting a terminal for a host from the{" "}
              <Nav>Hosts</Nav> tab. The connection runs over <Term term="SSH" />.
            </li>
            <li>
              Open a local Windows shell with the <Nav>plus button</Nav> at the
              end of the tab strip. It lists the shells installed on your PC:
              Windows PowerShell, PowerShell 7 (pwsh), Command Prompt and any
              installed WSL distributions. Local shells run through{" "}
              <Term term="ConPTY" />.
            </li>
            <li>
              Rename a local shell tab with the <Nav>pencil</Nav> on the tab:
              type a name and press <Nav>Enter</Nav> (or <Nav>Esc</Nav> to
              cancel). The name is used everywhere that tab appears, including
              the grid tile and the broadcast lists, and an empty name puts the
              shell's own name back. The rename lasts for the rest of the
              session and is not kept across restarts. Tabs opened from a
              profile already carry the profile's name, so they have no pencil.
            </li>
            <li>
              A second tab on the same shell or the same host is numbered:{" "}
              <Nav>PowerShell</Nav>, then <Nav>PowerShell 02</Nav>,{" "}
              <Nav>PowerShell 03</Nav>. The number counts the order you opened
              them in, not the order they sit in, so dragging a tab about never
              renames anything. A tab you have renamed keeps its number without
              showing it, which is why renaming the second one leaves you with{" "}
              <Nav>PowerShell</Nav>, your own name, and{" "}
              <Nav>PowerShell 03</Nav>: renaming one tab is not a reason to
              relabel a different one under you.
            </li>
          </Bullets>
          <H3>Serial consoles (COM ports)</H3>
          <Bullets>
            <li>
              The <Nav>plus button</Nav> menu also lists the COM ports on this
              PC, under <Nav>Serial console</Nav>. Picking one opens the console
              cable as an ordinary terminal tab, so the switch, router or
              firewall you are plugged into sits beside your SSH sessions
              instead of in a second program. Where the OS knows what a port is
              (the product name of a USB serial adapter, say) it is shown under
              the port name, which is the only way to tell two identical black
              dongles apart.
            </li>
            <li>
              The box beside each port is the <Nav>line speed</Nav> in baud. It
              starts at <Nav>9600</Nav>, which is what a console port is set to
              unless someone changed it; a board that wants{" "}
              <Nav>115200</Nav> says so in its documentation. Whatever you open
              a port at is remembered for that port, so the next time is one
              click. The other line settings are the usual 8 data bits, no
              parity, one stop bit, no flow control.
            </li>
            <li>
              A serial tab looks empty when it opens, and that is normal: the
              port is a piece of wire and nothing has spoken yet. Press{" "}
              <Nav>Enter</Nav> to make the device draw its prompt. The tab's
              label carries the speed (<Nav>COM3 @ 9600</Nav>), which is the
              first thing to check if what comes back is garbage rather than
              text.
            </li>
            <li>
              A COM port belongs to one program at a time. A port you already
              have a tab on is shown in the menu as{" "}
              <Nav>already open</Nav> and cannot be picked twice, so the only
              way to meet this is another program holding it: PuTTY, Tera Term,
              a script of your own. Then the tab says the port is already open
              elsewhere and names the fix; close the other one and press{" "}
              <Nav>Try again</Nav>. Unplugging the adapter mid-session ends the
              tab with the reason on its banner.
            </li>
            <li>
              Unlike a shell, a serial port has no size and no working
              directory, so <Nav>How many</Nav> does not apply to it (one cable
              is one tab) and resizing the pane does not tell the far end
              anything. Devices that care are told by hand, usually with a{" "}
              <Nav>terminal width</Nav> command of their own.
            </li>
            <li>
              Serial tabs have their own family in{" "}
              <SectionLink id="help-sec-ptybroadcast">
                PTY Broadcast
              </SectionLink>{" "}
              and in the <Nav>Broadcast</Nav> rail, so one line can go to a rack
              of console cables at once. Every serial send asks for confirmation
              first.
            </li>
          </Bullets>
          <H3>How local shells are detected (important)</H3>
          <Bullets>
            <li>
              Detection uses your Windows PATH, not a fixed install folder, so the
              install location does not matter as long as the installer added the
              shell to PATH. A shell installed without being put on PATH (for
              example an unzipped portable build, or a disabled app execution
              alias) will not appear in the list.
            </li>
            <li>
              Broadside reads PATH when it starts. If you install a new shell
              while the app is already running, restart Broadside for it to
              show up in the launcher.
            </li>
            <li>
              You can hide shells you do not use from the launcher in{" "}
              <Nav>Settings</Nav> under <Nav>Appearance</Nav>. Every detected
              shell is shown by default; a newly installed one appears
              automatically once detected.
            </li>
          </Bullets>
          <H3>Your own terminal applications</H3>
          <Bullets>
            <li>
              Detection only finds the shells Broadside knows how to look for.
              For anything else, such as <Nav>Git Bash</Nav>, MSYS2 or Cygwin,
              open <Nav>Settings</Nav> and the <Nav>Custom terminals</Nav>{" "}
              section and add it yourself. There is an <Nav>Add Git Bash</Nav>{" "}
              button that fills in the usual path and options for you, so that
              case is normally one click and a save.
            </li>
            <li>
              Give it a name (used in the launcher and as the tab title), the
              full path to the program (the <Nav>Browse</Nav> button finds it),
              any arguments it needs, and which command language it speaks. Git
              Bash is normally given <code>--login -i</code>. It opens without
              those, because a program started in a terminal tab already has a
              screen and a keyboard and Bash goes interactive on its own; what
              <code> --login</code> adds is the profile Git for Windows ships,
              which is where the coloured <code>MINGW64</code> prompt with the
              branch name and the full set of Unix tools on the path come from.
              Without it you get a working but plain <code>bash-5.2$</code>{" "}
              shell.
            </li>
            <li>
              The program must be a full path to a real <code>.exe</code>.
              Broadside checks that when you save, so a typo is caught there
              rather than when you try to open a tab. Arguments are handed to
              the program directly rather than through a shell, so there is no
              quoting to get right.
            </li>
            <li>
              The command language matters for more than the icon: it decides
              which <Nav>PTY Broadcast</Nav> tab the terminal belongs to, so a
              broadcast command is always valid for everything it reaches. A
              Bash-like (<Term term="posix" />) terminal joins the{" "}
              <Nav>WSL / POSIX</Nav> tab.
            </li>
            <li>
              A terminal you add appears in the <Nav>+</Nav> menu straight away,
              with no restart, and can be used by a saved shell profile like any
              other shell. Removing one takes it out of the launcher; a profile
              still pointing at it is flagged rather than silently broken.
            </li>
          </Bullets>
          <H3>Tab colours</H3>
          <Bullets>
            <li>
              A saved host carries a colour, and its tabs and grid tiles wear
              it. Local tabs do too, set in <Nav>Settings</Nav> under{" "}
              <Nav>Custom terminals</Nav>. The colour belongs to the{" "}
              <b>kind of shell</b>, not to the tab: one for PowerShell, one for
              Command Prompt, one for WSL, one for the Bash-like terminals, one
              for serial. A custom terminal takes the colour of the command
              language it declares, so Git Bash and MSYS2 are both Bash-like and
              wear the same one.
            </li>
            <li>
              Two PowerShell tabs being the same colour is the point rather than
              a limitation. A host's colour answers <i>which machine</i>; a
              local tab has no machine to name, so what is worth saying is{" "}
              <i>which language am I about to type in</i>, which is the thing
              that stops a Linux command going into a Command Prompt.
            </li>
            <li>
              The defaults are dark blues from the Windows console family,
              chosen to sit quietly behind text that still has to be readable in
              both themes; the loud reds and greens of the host palette are
              spoken for, and a local tab borrowing one would be saying
              something it does not mean. <Nav>Serial</Nav> starts with no
              colour at all, because a console cable is the one session that is
              a piece of hardware rather than a program and leaving it plain is
              what makes the coloured tabs read as the shells. Any of them can
              be changed, or set to <Nav>None</Nav>, and{" "}
              <Nav>Defaults</Nav> puts them all back.
            </li>
            <li>
              A <b>profile</b> can override its shell's colour, picked when you
              create it. A profile is a purpose rather than a language, which is
              the same kind of thing a host is, so two profiles on the same pwsh
              can be told apart the way two hosts can. Left alone, a profile
              follows its shell.
            </li>
          </Bullets>
          <H3>Shell profiles</H3>
          <Bullets>
            <li>
              A profile is a saved local shell that opens the way you want it: a
              chosen shell, a working directory, and an optional command that
              runs the moment the shell is ready. Open the{" "}
              <Nav>plus button</Nav> and use the <Nav>Profiles</Nav> section at
              the bottom of the menu to create, launch, edit or delete them.
            </li>
            <li>
              <Nav>New</Nav> opens a short form. Give the profile a name, pick
              the shell, choose the <Nav>Working directory</Nav> (type it, or
              use <Nav>Browse</Nav> to pick a folder), and optionally set a{" "}
              <Nav>Startup command</Nav>. The name becomes the tab label, so a
              profile tab is easy to tell apart from a plain shell tab. Leave the
              working directory empty to start in your home folder, the same as a
              plain shell. <Nav>Tab colour</Nav> is optional and defaults to{" "}
              <Nav>Shell&apos;s colour</Nav>, whose swatch shows you which colour
              that is.
            </li>
            <li>
              Launching a profile opens the shell in that folder and, a moment
              later, types the startup command for you and presses Enter, exactly
              as if you had typed it. The short pause lets the shell finish
              drawing its prompt first. As one example, a profile can open
              PowerShell 7 in a project folder and start a command-line tool
              there in a single click.
            </li>
            <li>
              Profiles honour the <Nav>How many</Nav> count, so you can open
              several copies of the same profile at once, and a large batch asks
              first. A profile with a startup command asks before opening more
              than one copy, because every copy runs that command again.
            </li>
            <li>
              Profiles are saved on this PC only and never store passwords or
              keys. A profile keeps working even if you hide its shell from the
              plain list. If a profile points at a shell that is no longer
              detected (for example a WSL distribution you removed), its name is
              shown struck through and it will not launch until that shell is
              back.
            </li>
          </Bullets>
          <H3>Working with tabs</H3>
          <Bullets>
            <li>Drag tabs to reorder them. Their identity stays stable, so reordering never disconnects a session.</li>
            <li>
              A remote tab whose connection is down (still connecting, dropped or
              failed) shows its label in <span className="font-medium text-red-600 dark:text-red-400">red</span>; use{" "}
              <Nav>Reconnect</Nav> to bring it back. Local shell tabs never show
              this.
            </li>
            <li>
              Switch tabs from the keyboard with <Nav>Alt+Right</Nav> (next tab)
              and <Nav>Alt+Left</Nav> (previous), even while a terminal is
              focused. The selection wraps around the ends, and plain arrow keys
              still do normal line-editing inside the shell.
            </li>
            <li>
              The tab strip itself is one stop in the tab order: <Nav>Tab</Nav>{" "}
              into it, then <Nav>Left</Nav> and <Nav>Right</Nav> walk along the
              tabs (<Nav>Home</Nav> and <Nav>End</Nav> jump to the ends) and{" "}
              <Nav>Enter</Nav> chooses the one you have reached. Walking is not
              choosing, deliberately: passing over four sessions on the way to
              the fifth is not four decisions, and in Grid it would point your
              typing at each of them in turn. Only the tab you have reached is
              in the tab order, along with its own rename, hide, maximize and
              close buttons, which <Nav>Tab</Nav> reaches next. So the strip
              costs you one stop and the tab you are on, however many sessions
              are open.
            </li>
            <li>
              Opening a second tab for the same host adds a small number to the
              tab so you can tell duplicates apart.
            </li>
            <li>
              Use the <Nav>find box</Nav> to search the visible output of the
              active terminal. The match count is shown, and clearing the search
              removes the highlight.
            </li>
            <li>
              Maximize a single terminal to fill the window (also <Nav>F11</Nav>),
              and close a single tab or use <Nav>Close all</Nav>, in the{" "}
              <Nav>Sessions</Nav> menu, to clear them with a confirmation.
            </li>
            <li>
              Switch the pane area between <Nav>Tabs</Nav> and <Nav>Grid</Nav>{" "}
              with the toggle above the tab strip. <Nav>Tabs</Nav> shows one
              terminal at a time; <Nav>Grid</Nav> tiles every open terminal at
              once so you can watch several together. One terminal fills the
              area, two split it, and three or more tile two-across, sharing the
              height between them until there are too many to fit, at which
              point they keep a readable size and the grid scrolls. Two-across
              needs the room for two readable columns, and the sidebar and the
              broadcast rail come out of the same space, so on a narrow window
              with either of those open the tiles stack in one column instead of
              being squeezed to a width nothing will fit in. Resize the
              window and they follow it, larger or smaller, unless you have
              pinned a tile size in <Nav>Settings</Nav> or dragged one out.
              Each grid tile has its own maximize and close buttons, and its
              header shows the same colour as the tab. Your choice is
              remembered between visits and restarts; maximizing a terminal
              always shows it on its own.
            </li>
            <li>
              <b>Grid wants room, and there is a point past which no window is
              big enough.</b>{" "}
              A tile is the pane divided by the number of terminals in it, so
              five tiles on a small window are the same size as twenty on a
              large one. Broadside will not shrink a tile past what you can read
              in: it holds the size and scrolls instead. When you find yourself
              scrolling, these are the four things that buy space back, roughly
              in order of how much. <Nav>Ctrl+Shift+G</Nav> gives the grid the
              whole screen and folds every bar away behind a tab at the top.{" "}
              <Nav>Grid Titles</Nav> (the eye) takes a title bar off every tile.
              The grid button on a tab drops that terminal out of the grid
              without closing it, so a session you only need occasionally stops
              claiming a tile. And <Nav>F11</Nav> gives one terminal the whole
              window when you want to stop watching and start working. The
              status bar shows the window size at the bottom left while you
              resize, if you want to see what you are working with.
            </li>
            <li>
              <b>In Grid, focus follows the mouse.</b> Whichever tile the
              pointer comes to rest on is the active one, outlined in that
              host's own colour, and it is where everything goes: what you type,
              what you paste, what <Nav>find</Nav> searches and what a shortcut
              command runs. Move the mouse to another tile, stop, and the outline
              moves with it. Nothing needs clicking first, and there is no
              setting for this: one tile is highlighted and it is the one that is
              listening.
            </li>
            <li>
              Tiles you only <i>cross</i> are left alone. It takes a moment of
              stillness to hand the grid over, so reaching from a tile at the
              bottom up to the toolbar does not give your typing, and the
              shortcut list, to whichever tile happened to be on the way.
              Clicking a tile takes it at once, without the wait.
            </li>
            <li>
              Choosing a tab, pressing <Nav>Alt+Left</Nav> / <Nav>Alt+Right</Nav>{" "}
              or picking from <Nav>Sessions</Nav> overrides the mouse, and keeps
              the tile it chose until you move the pointer off whatever tile it
              was resting on. So a terminal you selected deliberately does not
              get taken away by a stray nudge of the mouse. The pointer is also
              ignored while you are typing anywhere that is not a terminal (a
              search field, a tab rename, a dialog), while a tile is being
              drag-resized, and while you are dragging out a selection across a
              tile edge.
            </li>
            <li>
              <b>None of this happens while another window has the keyboard.</b>{" "}
              Windows goes on sending mouse movement to whatever sits under the
              pointer even when that window is not the one you are typing in, so
              passing over Broadside on the way somewhere else would otherwise
              move the outline and leave your next keystrokes aimed at a host
              you never chose. The grid stops following the mouse until
              Broadside is the active window, and stops looking active while it
              is not: the outline goes quiet and tiles no longer raise a scroll
              bar under the pointer. Scrolling a tile from another window still
              scrolls it, and does nothing else. One click in a tile brings the
              window back and selects that tile in the same movement.
            </li>
            <li>
              Anything you press in the toolbar leaves the keyboard there, which
              is right for a menu and wrong for <Nav>Go</Nav>: a shortcut command
              runs in a terminal, so the keyboard goes back to that terminal with
              it and you can answer what it prints. From anywhere else in the
              toolbar, rest the pointer over the tile you want and it takes the
              keyboard back.
            </li>
            <li>
              The <Nav>Grid Titles</Nav> button (the eye, next to{" "}
              <Nav>Broadcast</Nav>) hides every tile's title bar for a denser,
              chrome-free wall of terminals; a crossed-out eye marks the hidden
              state and clicking again brings the bars back. It appears only in
              Grid and the choice is remembered across restarts.
            </li>
            <li>
              The grid tiles follow the order of the tabs above them. Drag a tab
              to a new position and the grid rearranges to match straight away,
              without disturbing any running terminal.
            </li>
            <li>
              The <Nav>Broadcast</Nav> button opens a rail down the left side:
              pick a shell language, tick the sessions you want, type a command
              at the bottom, and it is typed into all of them at once. Because
              you never leave the page, the panes you are watching are the ones
              that answer, which is the whole point of pairing it with{" "}
              <Nav>Grid</Nav>. The button remembers whether it was open across
              restarts.
            </li>
            <li>
              One shell language at a time, deliberately, so a command is always
              valid for everything it reaches. The safety checks are the same as
              on the <Nav>PTY Broadcast</Nav> tab: a destructive command asks for
              confirmation before going to SSH hosts, and every local-shell send
              is confirmed. That tab is still there and unchanged; it keeps the
              saved history and the full per-run report, while the rail is the
              quick, in-place version.
            </li>
            <li>
              The rail's command box is the same composer as the one on{" "}
              <Nav>PTY Broadcast</Nav>, and it recalls the same commands:{" "}
              <Nav>Up</Nav> and <Nav>Down</Nav> walk one shared list, so
              something you sent from that tab is a keypress away here and the
              other way around. <Nav>Clear history</Nav>, under the send button,
              empties the recall here and only here: the list is shared for
              reading, not for tidying, so clearing the box in front of you is
              never an act on another tab. Nothing is deleted either, so the{" "}
              <SectionLink id="help-sec-logs">Logs</SectionLink> record of what
              was run is untouched.
            </li>
            <li>
              A session that has dropped its connection stays in the list and
              turns red, but its checkbox is disabled: a checked box on a
              terminal that cannot receive anything is a command going quietly
              nowhere. Reconnect the terminal and it can be checked again.{" "}
              <Nav>Select all</Nav> passes over anything disconnected.
            </li>
            <li>
              <Nav>Fullscreen</Nav> (also <Nav>Ctrl+Shift+G</Nav>) gives the
              grid the whole screen: the toolbar, the tab strip, the sidebar and
              the status bar all slide away, leaving one small tab in the middle
              of the top edge. Put the mouse on that tab and everything slides
              back down, so you can pick a tab, close one, or use the dropdown
              without leaving fullscreen. Clicking the tab does the same thing,
              for when the strip is being stubborn. The tab is the only place
              that does it, and deliberately so: the rest of the top edge is
              yours, so reaching for the top row of tiles does not keep pulling
              the controls down over what you are working in. It is somewhere to
              go and do one thing, so it hides again the moment you do it:
              clicking any button, choosing from any menu, or picking a tab sends
              it away without waiting for you to move the mouse off. Going back
              to the tab brings it down again, and so does{" "}
              <Nav>Ctrl+Shift+T</Nav>, which needs no aim at all. The one thing
              that does not send it away is clicking into a box you are about to
              type in, such as renaming a tab. Closing the last terminal ends
              fullscreen as well, whether one tab at a time or with{" "}
              <Nav>Close all</Nav>: there is nothing left to fill the screen
              with, and an empty screen with the chrome still hidden gives you
              nothing to work with.{" "}
              <Nav>Ctrl+Shift+G</Nav> or the button brings the chrome back. The
              shortcut is a Ctrl+Shift one on purpose: a terminal cannot tell
              Ctrl+Shift+G from Ctrl+G, so nothing is taken away from a program
              running in a tile, which a function key like F10 would have been.
              For the same reason <b>Esc does not leave fullscreen</b>: a wall
              of terminals is the worst possible place to claim the key{" "}
              <code>vi</code> is built around.
            </li>
            <li>
              <Nav>Ctrl+Shift+T</Nav> puts the keyboard into the controls, which
              slides the strip down as it goes, and puts a ring around the
              button that has the focus. <Nav>Tab</Nav> and <Nav>Shift+Tab</Nav>{" "}
              then move along the toolbar and into the tab strip, which is one
              stop for the strip and one for the tab you are on: that tab's own
              buttons show themselves as they take the focus instead of waiting
              for the mouse, and the other tabs stay out of the way until{" "}
              <Nav>Left</Nav> and <Nav>Right</Nav> take you to them. Tab wraps
              round at the last control rather
              than walking off into the grid, and <Nav>Esc</Nav> hands the
              keyboard back to the terminal you came from. That is the one thing
              Esc does here, and it is safe to claim precisely because the
              keyboard is in the toolbar rather than in a terminal at the time.
              Tab on its own cannot get you in here: a terminal has the focus in
              a grid, and Tab there belongs to the shell.
            </li>
            <li>
              Drag the right or bottom edge of any tile (or its bottom-right
              corner) to set the tile size. It sets the size for{" "}
              <strong className="font-semibold">every</strong> tile, not just
              that one, so the grid stays even; tiles that no longer fit scroll
              rather than shrink. A dragged size lasts as long as Broadside is
              running and is then forgotten, and it does not change the{" "}
              <Nav>Grid</Nav> settings described below, which stay the one place
              a size is set for good. <Nav>Reset grid</Nav> in the toolbar goes
              back to tiles that fit the window, clearing both.
            </li>
            <li>
              That last part is the <Nav>Strict</Nav> checkbox in{" "}
              <Nav>Settings → Grid</Nav>, and it is on to start with. Turn it
              off if you would rather a drag counted: the tile width and height
              you drag out are written into the settings as you go, Settings
              shows the new numbers straight away, and the size is still there
              after a restart. Nothing else follows the drag either way, the
              column count, the layout, the tile headers and the side-by-side
              flip are yours to set and are never written by dragging.
            </li>
            <li>
              To take one terminal out of the grid, click the small{" "}
              <Nav>grid button</Nav> on its tab (it appears in Grid only). The
              tile disappears and the remaining tiles fill the space, while the
              shell keeps running untouched; the button turns amber so you can
              see which tabs are hidden, and clicking it again puts the tile
              back. Hidden tabs still work normally in <Nav>Tabs</Nav>. A hidden
              session can still be selected in Grid, from <Nav>Sessions</Nav> or
              with <Nav>Alt+Left</Nav> / <Nav>Alt+Right</Nav>, and there is then
              no tile to type into: rather than leave your keystrokes going to
              the terminal you were last in, the keyboard is set down and typing
              goes nowhere until you put the tile back or switch to{" "}
              <Nav>Tabs</Nav>.
            </li>
            <li>
              To pin the grid, open <Nav>Settings</Nav> and the <Nav>Grid</Nav>{" "}
              section. Leave everything on <Nav>Auto</Nav> for the layout above,
              or set the <Nav>Columns across</Nav> and the tile{" "}
              <Nav>Item width</Nav> / <Nav>Item height</Nav> in characters
              (columns and rows). Fixed tile widths that add up to more than the
              window scroll sideways rather than shrinking, so panes keep the
              character size you asked for. Changing the terminal font resizes
              pinned tiles to keep those dimensions. The settings apply the next
              time you open the Terminals page. One and two terminals are the
              exception: a single terminal fills the whole area and two take the
              full window side by side or stacked, both ignoring the Grid
              settings entirely, because at those counts a pinned size can only
              waste screen you could have been using.
            </li>
            <li>
              A pinned <Nav>Columns across</Nav> is trimmed to the number of
              terminals actually open, so six columns with three terminals up
              lays out three across the window rather than using half of it and
              leaving the rest empty. It follows as you open and close them, and
              it only ever narrows the count, a tile's pinned width or height
              is untouched and stays exactly what you set.
            </li>
            <li>
              When the terminals do not divide evenly into columns, the last row
              is short and something has to fill the gap.{" "}
              <Nav>Short last row</Nav> in <Nav>Settings → Grid</Nav> decides
              what:{" "}
              <strong className="font-semibold">Stretch the row</strong> (the
              default) widens the tiles on it to take the whole width, so three
              tiles in two columns give two on top and one full-width
              underneath;{" "}
              <strong className="font-semibold">
                Tall tile in the last column
              </strong>{" "}
              instead grows the tile above the gap down into it, giving one top
              left, one full height on the right and one bottom left; and{" "}
              <strong className="font-semibold">Leave the gap</strong> keeps
              every tile the same shape and lets the empty cell stay empty. A
              size you pinned wins over all of this: a stretched tile is wider
              than the <Nav>Item width</Nav> and a tall one is taller than the{" "}
              <Nav>Item height</Nav>, so where you have set that dimension by
              hand the gap simply stays.
            </li>
          </Bullets>
          <H3>Copy, paste and jumping to a tab</H3>
          <Bullets>
            <li>
              <strong className="font-semibold">Copy</strong> by selecting text
              with the mouse, and the selection is copied to the clipboard as soon
              as you release the button (no menu, no shortcut needed). A brief{" "}
              <Nav>Copied to clipboard</Nav> toast confirms it. You can also press{" "}
              <Nav>Ctrl+Shift+C</Nav> to copy the current selection.
            </li>
            <li>
              <strong className="font-semibold">Paste</strong> with a{" "}
              <Nav>right-click</Nav> in the terminal, or with{" "}
              <Nav>Ctrl+Shift+V</Nav>. Plain <Nav>Ctrl+C</Nav> and{" "}
              <Nav>Ctrl+V</Nav> are left alone so the shell still receives them
              (for example Ctrl+C to interrupt a running command). In Grid, a
              paste lands in the tile the pointer is over, which is the tile
              outlined in the host's colour, because that is also the tile that
              is listening for the keyboard. Copy from one, move to another,
              paste, press <Nav>Enter</Nav>: it runs where you are looking.
            </li>
            <li>
              <strong className="font-semibold">Find</strong> in a terminal's
              scrollback with <Nav>Ctrl+F</Nav>, which opens a bar rather than
              sending the key to the shell. Every match is highlighted as you
              type and the bar counts them: <Nav>3 of 17</Nav> tells you which
              one you are standing on, so the up and down arrows (or{" "}
              <Nav>Enter</Nav> and <Nav>Shift+Enter</Nav>) are walking a list you
              can see the length of. The three toggles beside the box are a
              regular expression, match case and whole word; typing{" "}
              <code>/pattern/i</code> turns the first one on for you.{" "}
              <Nav>Esc</Nav> closes the bar and takes the highlighting with it.
              It searches the terminal that is listening, which in Grid is the
              tile the pointer is resting on, and moving to another one runs the
              same search there.
            </li>
            <li>
              <strong className="font-semibold">Text too small</strong> is fixed
              from where you are reading it: hold <Nav>Ctrl</Nav> and turn the
              mouse wheel over a terminal to zoom the text in or out. Every open
              terminal changes together,
              one step a notch, between 8 and 32 px, and the size you stop on is
              saved as the terminal font size in <Nav>Settings</Nav> under{" "}
              <Nav>Appearance</Nav>.
            </li>
            <li>
              <strong className="font-semibold">
                Giving Ctrl and the wheel back
              </strong>
              : while the zoom is on, that combination belongs to Broadside and
              the terminal never sees it. Two things go with it. The scrollback
              no longer scrolls faster when you hold <Nav>Ctrl</Nav>, and a
              full-screen program running with mouse reporting on (tmux with{" "}
              <code>mouse on</code>, vim with <code>set mouse=a</code>, htop) no
              longer receives the notch, so a mapping such as{" "}
              <code>&lt;C-ScrollWheelUp&gt;</code> stops firing. Little binds it
              by default, but if you rely on one, tick <Nav>Strict</Nav> beside
              the terminal font size in <Nav>Settings</Nav> under{" "}
              <Nav>Appearance</Nav>: the zoom stops, the size then only changes
              by being typed there, and Ctrl with the wheel goes back to the
              terminal exactly as it behaved before. The plain wheel, without
              Ctrl, is never taken either way.
            </li>
            <li>
              <strong className="font-semibold">How far you can scroll back</strong>{" "}
              is 5,000 lines a pane out of the box, set by{" "}
              <Nav>Terminal scrollback</Nav> in <Nav>Settings</Nav> under{" "}
              <Nav>Appearance</Nav>. Anything older than that is dropped as new
              output arrives, so a command that prints more lines than the limit
              cannot be scrolled back to in full, and neither <Nav>Ctrl+F</Nav>{" "}
              nor a save can reach what has already gone. Raise it if you work
              with long output; it costs roughly 2KB a line at 200 columns, and
              that is per open pane, so 5,000 lines is about 12MB each. Lowering
              it takes effect the moment you save, on every pane that is already
              open, and the lines above the new limit are gone.
            </li>
            <li>
              Every key Broadside takes, here and everywhere else, is listed in{" "}
              <SectionLink id="help-sec-shortcuts">
                Keyboard shortcuts
              </SectionLink>
              .
            </li>
            <li>
              With many tabs open, use the <Nav>Sessions</Nav> menu at the top
              right to jump to any terminal; it also holds{" "}
              <Nav>Close all</Nav>. If the tab you pick is scrolled out of view,
              the tab strip scrolls to bring it to the center so you do not have
              to hunt for it.
            </li>
            <li>
              The same menu is where you deal with a lot of tabs at once instead
              of one at a time. <Nav>Reconnect all</Nav> reconnects every pane
              sitting on a <Nav>Try again</Nav> or <Nav>Reconnect</Nav> button,
              and <Nav>Close failed</Nav> clears the same set away instead; both
              carry the count, and the count is the same number because the pane
              you would reconnect is the pane you would give up on. Past a
              handful it asks first, since a large batch means a burst of
              connections going out at once. Panes still connecting are left
              alone, and so is any pane waiting on a host key answer, since
              neither is waiting to be reconnected.{" "}
              <Nav>Unhide all</Nav> puts every terminal you have taken out of the
              grid back into it. Each of the three is in the menu only while
              there is something for it to do, so a menu with none of them in it
              is telling you nothing is wrong.
            </li>
            <li>
              <b>Ending one session without losing the tab.</b> Each row of the{" "}
              <Nav>Sessions</Nav> menu has a small unplug button at its right
              hand end. It hangs up on that host and leaves the tab exactly where
              it is, so everything the session printed stays on screen and the
              pane offers <Nav>Reconnect</Nav> when you want it back, the same as
              if you had typed <code>exit</code>. It is in the menu rather than
              on the tab on purpose: the tab already has an x, and a button a few
              pixels from it that also means "get rid of this" is how you close
              the wrong thing. The unplug goes pale when there is no shell behind
              that row to end.
            </li>
            <li>
              The controls above the tab strip are grouped so they fit whatever
              window you run Broadside in. <Nav>Tabs</Nav> / <Nav>Grid</Nav>,{" "}
              <Nav>Broadcast</Nav>, the fullscreen icon and, in Grid, the icon
              for tile title bars stay out in the open because they are the ones
              you reach for. Everything else that shapes the view lives under{" "}
              <Nav>View</Nav>: fullscreen again (with the key beside it),{" "}
              <Nav>Full tab labels</Nav>, flipping two terminals between
              side-by-side and top/bottom, <Nav>Reset grid</Nav> and{" "}
              <Nav>Reset display</Nav>.
            </li>
            <li>
              <b>Greyed does not mean gone.</b> An entry that has nothing to act
              on right now stays where it is and goes pale: fullscreen with no
              terminal open, <Nav>Reset grid</Nav> with nothing pinned,{" "}
              <Nav>Reset display</Nav> with no active tab. The point is that you
              can find out an action exists before the moment you need it, and
              that the menu keeps the same shape from one visit to the next.
              Hover a pale entry and the status bar says what it is waiting for.
              The one thing that still comes and goes is the two-terminal flip,
              which describes an arrangement rather than offering an action, and
              only exists when exactly two tiles are on screen.
            </li>
            <li>
              If the row still runs out of room, the buttons keep their icons
              and drop their words rather than letting one fall off the edge.
              Nothing moves and nothing is removed; each button is in the same
              place doing the same thing, and hovering one still names it in the
              status bar. This happens on a narrow window, and sooner if you
              have raised the app font size in <Nav>Settings</Nav>, since the
              controls are sized in that font. Widen the window (or collapse the
              sidebar) and the words come back. The same is true of the row of
              buttons at the top of <Nav>Hosts</Nav>.
            </li>
            <li>
              <b>Fullscreen means the layout you are in.</b> In Tabs it fills
              the window with the terminal you are looking at, which is what{" "}
              <Nav>F11</Nav> has always done; in Grid it fills the screen with
              the whole wall (<Nav>Ctrl+Shift+G</Nav>) and folds the chrome away
              behind a tab in the middle of the top edge, which you hover or
              click to bring it back and which hides again as soon as you click
              anything on it. The icon and the <Nav>View</Nav>{" "}
              entry both do whichever one applies, and each names its own key.
              Neither answers to <Nav>Esc</Nav>, which belongs to whatever is
              running in the terminal.
            </li>
          </Bullets>
          <H3>Full-screen prompts, and a stuck one</H3>
          <p>
            A tab is a real terminal, so the box-drawing prompts an upgrade puts
            up (a kernel restart notice, a config file question) work normally:
            arrow keys, <Nav>Tab</Nav> and <Nav>Enter</Nav> all reach them.
            Broadside claims no keys of its own beyond{" "}
            <Nav>Ctrl+F</Nav>, <Nav>Ctrl+Shift+C/V</Nav> and{" "}
            <Nav>Alt+Left/Right</Nav>.
          </p>
          <p>
            If one of those boxes ignores everything you press, and your
            keystrokes appear on screen as <code>^[[A</code> or <code>^[</code>{" "}
            instead of moving the selection, the prompt is not listening: it was
            drawn by a program whose input is not this terminal, which is what
            happens when a script runs the upgrade rather than you. The keys are
            reaching the host and its shell is echoing them, so there is nothing
            to answer at that end. Press <Nav>Ctrl+C</Nav> to get back to a
            prompt, then run the command yourself, or run it non-interactively:{" "}
            <code>DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a</code> in
            front of an <code>apt</code> command stops both the config prompt and
            the restart prompt appearing at all.
          </p>
          <p>
            <Nav>Reset display</Nav> in the toolbar redraws the active terminal
            from scratch, for a pane one of these left garbled. It clears that
            pane's screen and scrollback, then asks the shell to repaint its
            prompt (the same <code>Ctrl+L</code> you could press yourself), so
            you are not left looking at a blank pane wondering whether the
            session is still there. Nothing is run and nothing is interrupted:
            it deliberately does not send <code>Ctrl+C</code>, so a long upgrade
            working away in that tab is safe from it. If a program has genuinely
            wedged the terminal, <em>you</em> still have to decide whether to
            interrupt it. A <Nav>Command Prompt</Nav> tab is cleared without the
            redraw, as <code>cmd</code> has no such key: press <Nav>Enter</Nav>{" "}
            there for a fresh prompt.
          </p>
          <p>
            While a command is running in that tab there is no prompt to
            repaint, because the shell is not reading its keyboard until the
            command finishes. The pane simply clears and stays clear, and the
            prompt comes back on its own when the command is done, along with
            whatever the command printed while you were watching a blank pane.
            Broadside withdraws the redraw it asked for in that case, so it
            cannot arrive late and clear the screen a second time. If you had
            typed something ahead at that shell, it is left alone.
          </p>
          <H3>Shortcut commands</H3>
          <Bullets>
            <li>
              The <Nav>Shortcut command</Nav> dropdown runs a saved command in the
              active tab. Each shortcut has a scope:{" "}
              <Nav>SSH / WSL (Linux)</Nav>, <Nav>Command Prompt / PowerShell</Nav>,{" "}
              <Nav>Both</Nav> for commands that work in either (for example
              whoami), or <Nav>Serial console (COM port)</Nav>.
            </li>
            <li>
              The dropdown shows only the shortcuts that run in the current tab,
              so a Linux command is never offered in a Windows shell. The icon
              next to each one reflects the active tab: the host icon on SSH and
              WSL tabs, the terminal icon on Command Prompt and PowerShell tabs,
              a cable on a serial one.
            </li>
            <li>
              <Nav>Serial console</Nav> stands on its own, and <Nav>Both</Nav>{" "}
              does not reach it. Both means both shell <i>languages</i>, Linux
              and Windows, and the far end of a console cable speaks neither: a
              switch has no use for <code>whoami</code> and no more use for{" "}
              <code>dir</code>. Broadside ships no serial commands for the same
              reason, since a console port might be a switch, a firewall, a BIOS
              menu or a bootloader and nothing sensible is common to all of
              them. So on a serial tab the picker starts out reading{" "}
              <Nav>No serial shortcuts</Nav> and <Nav>Go</Nav> is greyed, until
              you have added commands of your own for your own hardware. The
              picker still opens: it says the same thing again, greyed, above{" "}
              <Nav>Manage shortcuts…</Nav>, which is where you add the first
              one.
            </li>
            <li>
              WSL tabs run Linux, so they use the SSH/Linux shortcuts (and show
              the host icon in the tab strip and the <Nav>plus button</Nav> menu).
              Add your own, with a scope, in <Nav>Settings</Nav> under Shortcut
              commands.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-broadcast",
    title: "Broadcast",
    keywords:
      "broadcast many hosts one command exec non-interactive output history autoscroll headers timeout guard destructive parallel concurrency rail filter tag label search find select all sort collapse",
    body: (
      <>
        <Lead>
          <Nav>Broadcast</Nav> sends one command to many hosts at the same time
          and gathers each host's output in one place. It is the fastest way to
          run the same one-shot command everywhere.
        </Lead>
        <Detail>
          <H3>How it runs</H3>
          <Bullets>
            <li>
              Pick the hosts, type a command, and send. Each host runs it over an{" "}
              <Term term="exec-channel" /> and returns its output, which is
              grouped per host.
            </li>
            <li>
              Because the exec channel is not interactive, <Nav>Broadcast</Nav>{" "}
              is best for commands that finish on their own and print a result.
              For anything that prompts you or needs a live screen, use a{" "}
              <Nav>Terminals</Nav> tab or <Nav>PTY Broadcast</Nav> instead.
            </li>
            <li>
              A per-command time limit stops hosts that take too long. The output
              area keeps your history and follows new output as it arrives, and
              you can hide the per-host headers if you prefer a compact view.
            </li>
          </Bullets>
          <H3>Choosing and filtering hosts</H3>
          <Bullets>
            <li>
              Pick targets in the host rail on the left. It collapses to color
              dots with the arrow button, has a <Nav>Sort</Nav> dropdown and a{" "}
              <Nav>Select all</Nav> box, and its collapse state is remembered. No
              hosts are selected by default; you choose the targets for each
              broadcast.
            </li>
            <li>
              Two filters narrow the rail: a <Nav>Find by label…</Nav> box that
              matches host labels as you type (like a find bar), and a{" "}
              <Nav>Filter tags</Nav> dropdown that works exactly like the tag
              filter on the <SectionLink id="help-sec-hosts">Hosts</SectionLink>{" "}
              table: uncheck tags (or the untagged bucket) to hide hosts, with{" "}
              <Nav>All</Nav> / <Nav>None</Nav> shortcuts. The two combine, and each
              filter lasts for the session and resets on restart.
            </li>
            <li>
              Filtering only ever narrows what you can act on:{" "}
              <strong className="font-semibold">a host the filter hides is
              unchecked automatically</strong>, and it comes back{" "}
              <em>unchecked</em> when you clear the filter, so a hidden host can
              never be swept into a broadcast. <Nav>Select all</Nav> and the
              counter apply to the visible hosts only. This same rail filter is on{" "}
              <SectionLink id="help-sec-ptybroadcast">PTY Broadcast</SectionLink>,{" "}
              <SectionLink id="help-sec-multiterminal">MultiTerminal</SectionLink>{" "}
              and <SectionLink id="help-sec-sftp">SFTP Broadcast</SectionLink>.
            </li>
          </Bullets>
          <H3>Safety</H3>
          <p>
            A destructive-command guard can warn you before sending commands that
            look dangerous, and ask you to confirm first. You configure which
            patterns count as destructive in <Nav>Settings</Nav>.
          </p>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-ptybroadcast",
    title: "PTY Broadcast",
    keywords:
      "pty broadcast type every open terminal interactive live shells mirror keystrokes difference rail filter tag label search select all tabs ssh powershell command prompt cmd wsl local fan out danger banner confirm carriage return serial console com port switches routers several consoles at once fifth tab",
    body: (
      <>
        <Lead>
          <Nav>PTY Broadcast</Nav> types one command into every open interactive
          terminal at once. Unlike plain <Nav>Broadcast</Nav>, it drives the live
          shells you already have running in the <Nav>Terminals</Nav> tab.
        </Lead>
        <Detail>
          <H3>When to use it</H3>
          <Bullets>
            <li>
              Use it when you want the same keystrokes delivered into several live
              sessions, for example to start the same interactive program on many
              hosts or local shells.
            </li>
            <li>
              Because it sends into a live <Term term="PTY" />, there is no
              completion signal and no per-command timer: you are typing into real
              shells, exactly as if you typed in each tab yourself.
            </li>
            <li>
              Plain <Nav>Broadcast</Nav> runs a command and waits for a result.{" "}
              <Nav>PTY Broadcast</Nav> just sends the text. Choose{" "}
              <Nav>Broadcast</Nav> for one-shot commands and{" "}
              <Nav>PTY Broadcast</Nav> for interactive ones.
            </li>
          </Bullets>
          <H3>One tab per shell language</H3>
          <Bullets>
            <li>
              The page is split into fixed tabs: <Nav>SSH</Nav>,{" "}
              <Nav>PowerShell</Nav>, <Nav>Command Prompt</Nav>, <Nav>WSL</Nav>{" "}
              and <Nav>Serial consoles</Nav>. Each open terminal shows up under
              its own tab, so a single command is always valid for the shells it
              reaches (PowerShell and Command Prompt stay separate because their
              syntax differs, and a serial console is talking to a device rather
              than a shell). A small count on each tab shows how many of that
              kind are open.
            </li>
            <li>
              The <Nav>Serial consoles</Nav> tab is the one to be most careful
              with, and it is the reason every send outside <Nav>SSH</Nav> asks
              first. A line typed here goes into several pieces of network
              hardware at once, and a switch has no undo.
            </li>
            <li>
              The <Nav>SSH</Nav> tab is the host-oriented view: it has the same{" "}
              <Nav>Find by label…</Nav> box and <Nav>Filter tags</Nav> dropdown as{" "}
              <SectionLink id="help-sec-broadcast">Broadcast</SectionLink>{" "}
              (filtering a session out unchecks it), applied to each session's
              host, plus the persisted dispatch history.
            </li>
            <li>
              A session whose connection has dropped keeps its place in the rail
              with a red dot, but it cannot be checked and <Nav>Select all</Nav>{" "}
              skips it. Nothing can be typed into a terminal that is not there,
              and a checked box that quietly does nothing is worse than a box
              that says it is out of action. The same is true of a local shell
              that has exited.
            </li>
            <li>
              There is one recall list for the whole app, shared with{" "}
              <Nav>Broadcast</Nav>, <Nav>MultiTerminal</Nav> and the broadcast
              rail on{" "}
              <SectionLink id="help-sec-terminals">Terminals</SectionLink>: a
              command sent from any of them is a press of <Nav>Up</Nav> away in
              the rest. <Nav>Clear command history</Nav> at the foot of the rail
              empties the recall on this page alone, though. Sharing is for
              reading; each page forgets on its own account, and nothing is
              deleted, so the{" "}
              <SectionLink id="help-sec-logs">Logs</SectionLink> record of what
              was run stays as it was.
            </li>
          </Bullets>
          <H3>Local shells (PowerShell, Command Prompt, WSL)</H3>
          <Bullets>
            <li>
              The three local tabs fan a command out to the shells running on{" "}
              <em>this machine</em>. A persistent yellow banner marks the danger:
              the command runs in every checked shell immediately, with no undo.
            </li>
            <li>
              Every local send asks you to confirm first, listing the exact
              command and the shells it will run in. Cancelling sends nothing.
            </li>
            <li>
              Local runs are session-only: the report clears when you close
              Broadside (local shells do not survive a restart anyway). Behind the
              scenes local shells receive a carriage return so PowerShell and
              Command Prompt actually execute the line rather than waiting at a
              continuation prompt.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-multiterminal",
    title: "MultiTerminal",
    keywords:
      "multiterminal aggregate combined output color tint per host block log delete two open compare rail select clear results command history close all headers collapse copy jump mirror show manual activity typed composer filter tag label search find selectable connected",
    body: (
      <>
        <Lead>
          <Nav>MultiTerminal</Nav> runs a command across the terminals you choose
          and shows every host's output together, each tinted with that host's
          color so you can compare results at a glance.
        </Lead>
        <Detail>
          <H3>How it works</H3>
          <Bullets>
            <li>
              Pick which open sessions to target in the host rail on the left, type
              a command in the composer, and send. You need at least two terminals
              open for the combined view to be meaningful. The rail collapses to
              color dots; its actions shrink to icons when collapsed.
            </li>
            <li>
              The rail carries the same <Nav>Find by label…</Nav> box and{" "}
              <Nav>Filter tags</Nav> dropdown as{" "}
              <SectionLink id="help-sec-broadcast">Broadcast</SectionLink>. Only{" "}
              connected, unfiltered sessions are selectable, and hiding a session
              with the filter unchecks it.
            </li>
            <li>
              Each command produces a block in the log, labeled with the command
              that ran. You can delete an individual block to keep the view tidy.
            </li>
            <li>
              Turn on <Nav>Show Manual Activity</Nav> to also capture commands you
              type by hand inside a <Nav>Terminals</Nav> tab; with it off, only
              commands sent from <Nav>MultiTerminal</Nav> appear here. It follows
              the hosts you have checked in the rail, so a host you deliberately
              left unchecked stays out of the log whether you type into it or not.
            </li>
          </Bullets>
          <H3>Block headers</H3>
          <Bullets>
            <li>
              With <Nav>Headers</Nav> on, each block has a header you can click to
              collapse or expand its output. Hover the header for a{" "}
              <Nav>copy</Nav> icon (copies that block's output) and, when the host
              still has an open terminal, a <Nav>terminal</Nav> icon that jumps to
              its tab.
            </li>
            <li>
              With <Nav>Headers</Nav> off, blocks show output only, with no header
              to collapse, copy or jump from.
            </li>
          </Bullets>
          <H3>Rail actions</H3>
          <Bullets>
            <li>
              <Nav>Clear results</Nav> empties the block log (and the saved
              history). <Nav>Clear command history</Nav> empties the Up/Down
              recall on this page; the list is read from the one every composer
              shares, but each page clears its own view of it.{" "}
              <Nav>Close all terminals</Nav> tears down every open terminal
              after a confirmation.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-skills",
    title: "Skills",
    keywords:
      "skill skills sequence step steps run expect send wait pattern regex branch ok fail match no match stop next start at renumber interactive timeout pause flow map diagram overview orphan loop transfer handoff to terminal root inputs parameters placeholder import export json reorder move up down builder editor pencil go to a step on timeout goto recovery retry jump timeout branch clone copy duplicate variant collapse expand fold steps step log narration progress which step of how many repeat cap runaway loop limit stop after runs times post to skill log log step note warning error message cancelled itself reason why self documenting rerun run again repeat run active step highlight tint selected scroll to new step infinite loop unlimited no cap forever never ends dangerous run until stopped jump go to step button follow branch scroll to target orange tint skill file version newer broadside cannot import older app unknown variant malformed take over takeover give me the keyboard type into a running host let me drive interrupt a skill mid run step in manually cannot type nothing happens when i type keyboard locked pause it now after this step waiting",
    body: (
      <>
        <Lead>
          A <Nav>skill</Nav> is a saved sequence of steps that Broadside runs
          against every host you check, in a real interactive shell it opens for
          each one. Because it is a real shell rather than a one-shot command, a
          skill can become root and stay root, answer questions a program asks,
          and drive things that repaint the screen, while you watch each host's
          terminal live.
        </Lead>
        <Detail>
          <H3>The five kinds of step</H3>
          <Bullets>
            <li>
              <Nav>run</Nav> sends a command and waits for it to finish, then
              branches on whether it succeeded.
            </li>
            <li>
              <Nav>wait for</Nav> watches the output for a pattern, optionally
              sending a reply the moment it appears. This is how you answer a
              prompt: wait for <code>Password:</code>, send the password.
            </li>
            <li>
              <Nav>send</Nav> types something with no waiting, for a keystroke a
              program is already sitting there expecting.
            </li>
            <li>
              <Nav>hold</Nav> pauses for a fixed number of seconds, sending
              nothing, so a status screen has time to settle.
            </li>
            <li>
              <Nav>post to the skill log</Nav> writes a line into that host's run
              log and carries on. It touches the host in no way at all; it is the
              skill explaining itself.
            </li>
          </Bullets>
          <H3>A skill that explains itself</H3>
          <p>
            <Nav>Post to the skill log</Nav> is for a skill that does different
            things depending on what it finds. The branch it took is obvious to
            the skill and invisible to whoever reads the run afterwards, so let
            it say so: <em>already on the current kernel, nothing to do</em>.
            Pick a <Nav>Log type</Nav> of <Nav>Note</Nav>, <Nav>Warning</Nav> or{" "}
            <Nav>Error</Nav>, write the message, and say where to go next. Inputs
            work in the message, so it can name what it found.
          </p>
          <p>
            One combination does more than log. An <Nav>Error</Nav> whose{" "}
            <Nav>Then</Nav> is <Nav>stop</Nav> ends that host as a{" "}
            <span className="font-medium">failure</span> carrying your message,
            which is how a skill refuses a host in its own words:{" "}
            <em>cancelled itself, this is not a web server</em> reads as a
            failure with a reason instead of a green tick for a skill that did
            nothing. An <Nav>Error</Nav> that goes anywhere else is just a loud
            log line, so a skill can complain and still clean up after itself.
          </p>
          <p>
            A log step's message is one line in the run log, tinted by its type,
            and that line is also the step's own entry: it is not announced and
            then repeated.
          </p>
          <H3>Patterns</H3>
          <p>
            A <Nav>wait for</Nav> pattern is a regular expression tested against
            the output with the colour codes stripped out. Its anchors are line
            anchors, so <code>^Ready$</code> means a line that says Ready, not the
            whole screen.
          </p>
          <H3>Interactive steps</H3>
          <p>
            Normally a <Nav>run</Nav> step knows the command finished because the
            shell comes back to a prompt. Some commands never do:{" "}
            <code>sudo -i</code> opens a nested shell, and an installer stops on a
            question. Tick <Nav>Interactive</Nav> on those, and the step moves on
            once the output goes quiet instead. You then drive the rest with{" "}
            <Nav>wait for</Nav> and <Nav>send</Nav>.
          </p>
          <H3>Branching</H3>
          <Bullets>
            <li>
              Every step says where to go next. <Nav>next</Nav> means the
              following step in the list, so a straight-through skill needs no
              wiring at all. <Nav>stop</Nav> finishes that host successfully.
            </li>
            <li>
              A <Nav>run</Nav> step branches on the command's exit code by
              default: one target if it worked, another if it did not.
            </li>
            <li>
              Tick <Nav>branch on the output</Nav> instead to decide on what the
              command printed. Give it a pattern and two targets, and the output
              test outranks the exit code entirely. Useful for a command that
              reports what it found without failing, such as{" "}
              <code>systemctl is-active</code>.
            </li>
          </Bullets>
          <H3>Timeouts</H3>
          <p>
            Each waiting step has a time budget. When it runs out the default is
            to <Nav>pause and wait for you</Nav>: that host goes yellow and you
            choose to wait again, treat the step as done and carry on, or stop the
            host. Nothing is ever quietly reported as finished because a timeout
            expired.
          </p>
          <p>
            The other two options are to fail (which ends the host for a{" "}
            <Nav>Wait for output</Nav> step, or takes the{" "}
            <Nav>if it fails</Nav> branch for a <Nav>Run a command</Nav> step),
            or <Nav>go to a step</Nav>, which carries the run on somewhere else
            of your choosing. Picking it shows the same target list the other
            branches use, so a step that times out can take a recovery path,
            retry an earlier step, or finish cleanly instead of stopping the
            host. It also lets you handle a slow command differently from one
            that failed, which the <Nav>if it fails</Nav> branch alone could not
            tell apart. The timeout branch is drawn on the flow map like any
            other, so a loop it creates shows up in the usual warnings.
          </p>
          <H3>Inputs</H3>
          <p>
            Declare inputs to avoid hard-coding values into commands. Write{" "}
            <code>{"{{service}}"}</code> in a step and Broadside asks you for{" "}
            <Nav>service</Nav> just before the run. Go templates such as{" "}
            <code>{"docker ps --format '{{.Names}}'"}</code> pass through
            untouched, so they are safe to use.
          </p>
          <H3>The flow map</H3>
          <Bullets>
            <li>
              Clicking a skill's name opens its <Nav>overview</Nav>: what it does,
              the inputs it asks for, and a diagram of how its steps connect.
              Clicking the pencil skips straight to the editor instead.
            </li>
            <li>
              Click any step in the diagram to see its settings. The zoom controls
              sit at the top right; clicking the percentage returns to 100%.
            </li>
            <li>
              The map catches two mistakes a list of steps cannot show you: a step
              nothing branches to, which will never run, and a loop with no way
              out, which will run into the repeat cap and fail the host. Both
              appear as amber warnings above the diagram. Neither blocks you, as a
              loop with an exit branch is a perfectly good pattern.
            </li>
            <li>
              A loop is drawn as a dashed amber arrow that runs back up the left
              of the diagram, so it reads as going backwards rather than being
              mistaken for another branch forward.
            </li>
          </Bullets>
          <H3>Runaway loops</H3>
          <p>
            A branch that loops is a legitimate way to poll until something is
            ready, so Broadside caps it rather than refusing it.{" "}
            <Nav>Stop a host after a step runs N times</Nav> in the editor sets
            the budget: any single step reaching it stops that host with a
            message naming the step. It counts per step, not per run, so it is
            the retry budget for the step that loops rather than a limit on how
            long a skill may be. The default is 100, which is also the ceiling.
          </p>
          <p>
            <Nav>Let steps repeat without limit</Nav> removes the cap
            altogether, and it is <span className="font-semibold">
            dangerous: use it only if you truly know what you are doing</span>.
            With no cap, a skill whose branches loop never finishes on its own.
            It keeps running steps against every host it is on until you stop
            it, and a loop that writes files, starts processes or installs
            things can fill a disk or exhaust memory on the far side while every
            host it touched holds an open shell. <Nav>Stop host</Nav> and the{" "}
            <Nav>Emergency stop</Nav> still work and are the only things that
            will end it. It is off by default, it is a switch of its own rather
            than a number you can mistype into, the flow map's loop warnings say
            so, and the run confirmation says so again before you dispatch. The
            legitimate use is polling something with no bound, watched.
          </p>
          <H3>Running one</H3>
          <Bullets>
            <li>
              Check hosts in the rail, then press play on the skill. Steps that
              match a <SectionLink id="help-sec-broadcast">guard rule</SectionLink>{" "}
              need the same typed confirmation a dangerous broadcast does.
            </li>
            <li>
              Each host gets its own live terminal pane. A host that pauses shows
              its options there. <Nav>Stop host</Nav> ends one host and leaves the
              rest running; the <Nav>Emergency stop</Nav> button at the foot of the
              rail ends all of them at once, which can leave a host mid-upgrade.
            </li>
            <li>
              <b>Taking a host over.</b> While the skill is driving a pane the
              keyboard is not yours, and typing into it does nothing; the pane
              says so rather than leaving you wondering.{" "}
              <Nav>Take over</Nav> in the pane's header is how you get it. It
              does not interrupt anything: the skill finishes the step it is on
              and stops in the gap before the next one, so a command that is
              still running is left to finish rather than being cut in half. The
              button says <Nav>After this step…</Nav> while it waits, which on a
              long step can be a while. The other hosts carry on throughout.
            </li>
            <li>
              Once it stops, the shell is yours to type in and the pane offers{" "}
              <Nav>Resume</Nav> to hand it back and carry on with the next step,
              or <Nav>Stop host</Nav> to end this one for good. A command you
              actually ran counts as the host talking, so the next step is
              entitled to match what it printed. A line you left half-typed does
              not: it is taken back off the shell and forgotten on the way out,
              so your own keystrokes cannot satisfy a step the skill is about to
              run.
            </li>
            <li>
              A host that pauses <em>on its own</em>, because a step waited for
              something that never arrived, offers the same shell plus{" "}
              <Nav>Skip step</Nav>, which declares the half-finished step
              satisfied and takes its success branch. That one is missing from a
              pause you asked for, because the step it would skip has not run
              yet.
            </li>
            <li>
              Each pane's header names the step it is on and where that sits in
              the skill, next to the countdown, so a long wait still tells you
              what is being waited for.
            </li>
            <li>
              <Nav>Log</Nav> in a pane's header shows what the skill decided for
              that host: each step it started, what matched, what it sent, what
              timed out and which branch it took, along with anything a{" "}
              <Nav>post to the skill log</Nav> step had to say. The terminal
              beside it shows what the host said; this is the half that explains
              why the run went where it did.
            </li>
            <li>
              When the run is over, <Nav>Rerun</Nav> beside <Nav>Close run</Nav>{" "}
              starts the same skill again. It closes this run first (shells and
              all) and takes you back to the confirmation, so the hosts and
              inputs are checked rather than silently reused. Panes you had the
              log open on open it again.
            </li>
          </Bullets>
          <H3>Keeping the shell afterwards</H3>
          <p>
            A skill normally closes each shell when it is done. Turn on{" "}
            <Nav>Allow transfer</Nav> and the shell stays open instead, so you can
            press <Nav>To terminal</Nav> and carry on by hand in a{" "}
            <Nav>Terminals</Nav> tab, with the run's scrollback intact. Broadside
            checks whether that shell is root and warns you before you leave a
            privileged one open. Closing the run closes any it still holds.
          </p>
          <H3>Building one</H3>
          <Bullets>
            <li>
              Steps in the editor are folded down to one line each, showing the
              id, the kind and what the step does. Click a step's header to open
              it, or use <Nav>Expand all</Nav> to open the lot. A step you add
              opens ready to fill in, and the editor scrolls down to it.
            </li>
            <li>
              The step you last clicked is tinted. That is mostly so it stays
              findable while you work, but it earns its keep with the up and down
              arrows: the tint travels with the card as it moves, so you can see
              what you just moved and where it went.
            </li>
            <li>
              <Nav>Renumber</Nav> renames the ids to s1, s2, s3 in their current
              order and rewrites every branch to match, so the flow is unchanged.
              Use it to tidy up after reordering.
            </li>
            <li>
              Amber notes below the steps are advice, not errors: they never stop
              you saving or running. Only the red list does that.
            </li>
          </Bullets>
          <H3>Organising them</H3>
          <Bullets>
            <li>
              The arrows on each skill in the rail move it up and down the list.
              The order is yours and it is remembered.
            </li>
            <li>
              <Nav>Clone</Nav> starts a new skill from a copy of an existing one,
              named <Nav>(clone)</Nav>, which is the way to build a variant of
              something that works. It opens in the editor unsaved, so nothing is
              written until you press <Nav>Create skill</Nav>, and the original is
              untouched whatever you do next.
            </li>
            <li>
              <Nav>Export</Nav> writes a skill to a <code>.json</code> file, and{" "}
              <Nav>Import</Nav> reads one back, showing you its steps before
              anything is saved. Files carry the definition only, never
              credentials.
            </li>
            <li>
              A skill file records which version of Broadside it needs, and only
              when it needs one: a plain skill still imports into an older copy
              of the app. One that uses something newer (a log step, a timeout
              that goes to a step, a removed repeat cap) is refused there with{" "}
              <em>made by a newer Broadside</em>, rather than a parse error that
              reads as a corrupt file. If you see that, the app doing the
              importing is the one to update.
            </li>
          </Bullets>
          <H3>What a skill needs from the host</H3>
          <p>
            Skills need a <Nav>bash</Nav>, <Nav>zsh</Nav> or <Nav>sh</Nav> login
            shell. A host on anything else is refused, by name, and carries an
            amber chip both on the{" "}
            <SectionLink id="help-sec-hosts">Hosts</SectionLink> tab and in the
            host list here. Such hosts are never hidden from the list: they stay
            selectable, and the refusal arrives as that host's own result when
            the run starts, so a skill aimed at forty machines still runs on the
            thirty-nine that can take it. Where the shell was already known at
            connect time the refusal is immediate rather than waiting out a
            probe.
          </p>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-sftp",
    title: "SFTP",
    keywords:
      "sftp file transfer browse upload download put get commander dual two pane local remote folder directory navigate drag drop delete recycle bin make folder clash mode overwrite all newer only skip existing broadcast multi-host per-host progress bar create path confirm host key tofu concurrency queue tab remember multi-select ctrl shift click range select many files group wildcard glob star pattern match asterisk",
    body: (
      <>
        <Lead>
          <Nav>SFTP</Nav> browses and moves files over the same secure{" "}
          <Term term="SSH" /> connection as the rest of the app (see{" "}
          <Term term="sftp" />). It has two tabs: <Nav>Commander</Nav>, a two-pane
          file manager for a single host, and <Nav>Broadcast</Nav>, which sends or
          pulls one path across many hosts at once.
        </Lead>
        <Detail>
          <H3>Commander (one host)</H3>
          <Bullets>
            <li>
              A two-pane view: your PC on the left, the remote host on the right.
              Open folders to navigate, and use the path bar to jump around; both
              sides show the same columns so they read alike.
            </li>
            <li>
              Transfer by dragging an item from one side to the other, or with the
              transfer buttons. Folders copy recursively, with a progress bar and a
              running byte count.
            </li>
            <li>
              Select several items to move at once, the same way Windows Explorer
              works: <Nav>Ctrl+click</Nav> to add or remove individual files, and{" "}
              <Nav>Shift+click</Nav> to select a whole range between two rows. A
              plain click selects a single file (or opens a folder). Dragging any
              selected item then transfers the whole selection in one go.
            </li>
            <li>
              You can make a new folder on either side and delete items. Local
              deletes go to the Windows <Nav>Recycle Bin</Nav> so they are
              recoverable; a non-empty remote folder is refused with a clear
              message rather than failing silently.
            </li>
          </Bullets>
          <H3>Broadcast (many hosts)</H3>
          <Bullets>
            <li>
              The <Nav>PUT / GET</Nav> toggle sets the direction: <Nav>PUT</Nav>{" "}
              sends one local file or folder to every selected host;{" "}
              <Nav>GET</Nav> pulls one remote path from every host into its own
              subfolder on your PC (one folder per host label, so files from
              different hosts never collide). Each host gets its own progress bar,
              and a few hosts transfer at a time so many targets are queued rather
              than opened all at once.
            </li>
            <li>
              On <Nav>GET</Nav>, the remote path may end in a wildcard (
              <Nav>*</Nav> or <Nav>?</Nav>) to pull several files at once, for
              example <Nav>/home/user/*.log</Nav> fetches every matching file from
              each host. Only the last part of the path is matched; the folders
              leading up to it are taken literally.
            </li>
            <li>
              Because a broadcast write can overwrite data on many machines at
              once, it is gated: an amber banner explains the risk and you must
              type <Nav>CONFIRM</Nav> before <em>every</em> run. By default no
              hosts are selected, and the rail has the same tag + label filter as{" "}
              <SectionLink id="help-sec-broadcast">Broadcast</SectionLink>.
            </li>
            <li>
              <Nav>Create path if it doesn't exist</Nav> (PUT only) makes the
              destination directory on each host when it is missing; it is a
              session-only toggle that resets on restart.
            </li>
            <li>
              First contact with a host is verified with <Term term="TOFU" /> just
              like elsewhere: unknown keys are gathered into one <Nav>trust</Nav>{" "}
              dialog after the run, and trusting them retries those hosts. A host
              whose key has <em>changed</em> is refused, never offered for trust.
            </li>
          </Bullets>
          <H3>When a file already exists</H3>
          <p>
            The selector on the tab row applies to <em>both</em> tabs:{" "}
            <Nav>Overwrite all</Nav> always replaces, <Nav>Newer only</Nav>{" "}
            replaces only when the source is newer, and <Nav>Skip existing</Nav>{" "}
            leaves same-named files untouched. It governs recursive folder
            transfers (a single file always overwrites), is remembered across
            restarts, and so is the tab (Commander or Broadcast) you last had
            open.
          </p>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-logs",
    title: "Logs",
    keywords:
      "logs saved sessions audit log command history search export json pretty print viewer",
    body: (
      <>
        <Lead>
          The <Nav>Logs</Nav> tab is your record of what happened: saved terminal
          sessions, an audit log of security-relevant actions, and your past
          commands.
        </Lead>
        <Detail>
          <H3>What you can find</H3>
          <Bullets>
            <li>
              Saved sessions let you reopen and read the captured output of an
              earlier terminal session.
            </li>
            <li>
              The audit log records important actions over time. You can switch it
              between compact and pretty-printed views, and turn audit logging on
              or off in <Nav>Settings</Nav>.
            </li>
            <li>Command history lists commands you have run, and every view has a search box.</li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-settings",
    title: "Settings",
    keywords:
      "settings performance network probe destructive guard shortcut commands appearance theme columns backup restore csv hosts audit security admin lock reset jump search danger zone delete wipe all hosts credentials terminal font family dropdown list monospace fixed width installed fonts my font is missing cannot find my font nerd font cascadia consolas jetbrains fira code hack typeface change the font picker preview restart to see a new font applies instantly no save needed save font sizes button which settings need saving why is there a save button font applies as you pick it",
    body: (
      <>
        <Lead>
          <Nav>Settings</Nav> is where you tune how Broadside behaves. Use the
          search box at the top to jump straight to a section.
        </Lead>
        <Detail>
          <H3>What you can change</H3>
          <Bullets>
            <li>
              <Nav>Performance</Nav>: how many hosts the app talks to at once.
            </li>
            <li>
              <Nav>Network probe</Nav>: how the app checks whether hosts are
              reachable for the <Nav>Status</Nav> column.
            </li>
            <li>
              <Nav>Destructive command guard</Nav>: the patterns that trigger a
              confirmation before a risky command is sent.
            </li>
            <li>
              <Nav>Shortcut commands</Nav>: reusable one-click commands for the
              dropdown on the Terminals and Broadcast pages. Each one is scoped
              when you add it: <Nav>SSH / WSL (Linux)</Nav> commands run on SSH
              hosts and WSL tabs, <Nav>Command Prompt / PowerShell</Nav> commands
              run on local Windows shells, <Nav>Both</Nav> commands run in either
              of those, and <Nav>Serial console (COM port)</Nav> commands run
              only on a console cable, which <Nav>Both</Nav> deliberately does
              not reach. See the Terminals section for how the dropdown uses the
              scope.
            </li>
            <li>
              <Nav>Appearance</Nav>: light or dark theme, the terminal font and
              its size, the size of the application text, which <Nav>Hosts</Nav>{" "}
              columns to show, and which detected local shells appear in the
              Terminals <Nav>plus button</Nav> menu. The{" "}
              <Nav>Terminal font</Nav> list holds only fonts that are installed
              on this machine and are fixed-width, each drawn in itself so you
              can see it before you choose it, so there is no way to land on a
              font that is not there. <b>Fixed-width is the reason a font you
              have is missing from the list.</b> A proportional font, Segoe UI
              or Arial, is left out even when it is installed, because a
              terminal needs every character to occupy the same cell: without
              that, columns do not line up, box drawing comes apart and the
              cursor lands somewhere other than where it belongs. Look for a
              variant with <i>Mono</i> in its name. A font you install while
              Broadside is running appears in the list once you restart it.{" "}
              <b>Picking a font applies it straight away</b>, so you can try one
              against your own terminals rather than commit to it unseen. The
              two size boxes are the only part of <Nav>Appearance</Nav> behind a{" "}
              <Nav>Save font sizes</Nav> button, and they are framed together
              with it: a half-typed number is not a size, and applying one on
              every keystroke would take the application text through 2 px on
              the way from 16 to 20. Everything outside that frame takes effect
              as you touch it. Holding{" "}
              <Nav>Ctrl</Nav> and
              turning the mouse wheel over any terminal changes the terminal
              font size from where you are reading and saves it here without the
              button, unless <Nav>Strict</Nav> beside that field is ticked,
              which leaves the wheel alone.
            </li>
            <li>
              <Nav>Backup &amp; Restore</Nav>: save a copy of your app data, or
              restore from one. Backups contain your host list and settings but
              never your passwords or key passphrases (those stay in the{" "}
              <SectionLink id="help-sec-security">Security section</SectionLink>{" "}
              vault), so a backup file cannot leak a secret. Tick{" "}
              <Nav>Also include hosts CSV</Nav> to additionally write a plain
              spreadsheet of your hosts alongside the backup.
            </li>
            <li>
              <Nav>Audit log</Nav>: turn audit recording on or off.
            </li>
            <li>
              <Nav>Security</Nav>: the sudo auto-fill switch and the admin lock,
              both described in the Security section below.
            </li>
            <li>
              <Nav>Reset</Nav>: return every setting to its default, behind a
              confirmation.
            </li>
            <li>
              <Nav>Danger Zone</Nav>: <Nav>Delete all hosts &amp; credentials</Nav>{" "}
              removes every host and its stored secrets in one step. It cannot be
              undone, so the dialog offers to back up first (optionally including
              the hosts CSV) before it wipes anything.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-security",
    title: "Security",
    keywords:
      "security credentials storage credential manager age encrypted file sqlite transmitted telemetry tofu host key sudo auto-fill admin lock argon2 recovery code isolation separate logins privacy why was my password not typed nothing filled in did not fill",
    body: (
      <>
        <Lead>
          Broadside handles passwords and connects to your machines, so it is
          worth understanding exactly what it stores, what it sends, and the
          controls you have.{" "}
          <strong className="font-semibold text-red-600 dark:text-red-400">
            There is no telemetry and the app never phones home.
          </strong>
        </Lead>
        <Detail>
          <H3>How your credentials are stored</H3>
          <Bullets>
            <li>
              Secrets (SSH passwords, key <Term term="passphrase">passphrases</Term>{" "}
              and <Term term="sudo" /> passwords) are stored in the{" "}
              <Term term="credential-manager" /> first, which ties them to your
              Windows login. If that is unavailable, the app falls back to a file
              named credentials.age that is encrypted at rest.
            </li>
            <li>
              Each secret is keyed to its host, so removing a host removes its
              secrets. Non-secret host details (label, address, port, username,
              color) live in a local database in plain text.
            </li>
            <li>
              Once saved, a secret is never shown again in the app. You can
              replace it, but the stored value is never displayed.
            </li>
          </Bullets>
          <H3>What is sent over the network</H3>
          <Bullets>
            <li>
              The app makes outbound <Term term="SSH" /> connections only to the
              hosts you configure. <Nav>Broadcast</Nav> uses an{" "}
              <Term term="exec-channel" />; <Nav>Terminals</Nav> use a full{" "}
              <Term term="PTY" />. Nothing else is sent anywhere.
            </li>
            <li>
              Host identity is verified with <Term term="TOFU" />: the app
              remembers each host's key on first connection and warns you if it
              changes.
            </li>
            <li>
              When the app fills a <Term term="sudo" /> prompt, the password is
              sent inside the encrypted SSH session in answer to the prompt. It is
              never placed on the command line or echoed back to the screen.
            </li>
          </Bullets>
          <H3>The sudo auto-fill switch and admin lock</H3>
          <Bullets>
            <li>
              Sudo auto-fill is a global switch in <Nav>Settings</Nav>. When on,
              the app answers a host's sudo password prompt using the password you
              stored for that host. Turn it off to always type sudo passwords
              yourself.
            </li>
            <li>
              It answers a <Nav>sudo</Nav> prompt and nothing else. A password
              prompt from <Nav>chsh</Nav>, <Nav>su</Nav>, an inner{" "}
              <Nav>ssh</Nav> or a database client looks much the same on screen,
              but it is a different program asking, sometimes on a different
              machine, and a stored password typed into it would have travelled
              somewhere you never chose to send it. Those prompts are yours to
              answer.
            </li>
            <li>
              The admin lock is an optional passcode that protects the credential
              and security controls. It is for authorization only: it uses{" "}
              <Term term="argon2" /> and encrypts nothing, so losing the passcode
              loses no data. Setting it gives you a one-time recovery code to
              regain access if you forget the passcode.
            </li>
            <li>
              The admin lock is not a wall between separate people on one Windows
              account. The real boundary for limiting a less-trusted operator is
              to give them their own Windows login and have them import hosts from
              a credential-free <Term term="csv" /> file, so they never receive
              your stored secrets.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-system",
    title: "System requirements",
    keywords:
      "system requirements specs spec minimum recommended hardware ram memory cpu processor cores disk space storage free windows 10 11 version 1809 64-bit x64 arm64 webview2 runtime edge resolution display screen monitor network latency conpty administrator admin rights install antivirus defender windows security false positive quarantine flagged virus trojan bearfoos ml detection code signing unsigned publisher unknown smartscreen sha256 checksum verify protection history restore exclusion",
    body: (
      <>
        <Lead>
          Broadside is a native Windows desktop app and runs comfortably on
          modest hardware. The table lists what it needs at a minimum, and what
          makes for a smoother ride when you are driving many hosts at once.
        </Lead>
        <Detail>
          <H3>Minimum and recommended</H3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-4 font-heading font-semibold">
                    Component
                  </th>
                  <th className="py-2 pr-4 font-heading font-semibold">
                    Minimum
                  </th>
                  <th className="py-2 font-heading font-semibold">
                    Recommended
                  </th>
                </tr>
              </thead>
              <tbody className="[&_td]:py-2 [&_td]:pr-4 [&_td]:align-top [&_tr]:border-b [&_tr]:border-border/50">
                <tr>
                  <td className="font-medium text-foreground">
                    Operating system
                  </td>
                  <td className="text-foreground/90">
                    Windows 10 (64-bit), version 1809 or later
                  </td>
                  <td className="text-foreground/90">
                    Windows 11 (64-bit), kept up to date
                  </td>
                </tr>
                <tr>
                  <td className="font-medium text-foreground">
                    WebView2 runtime
                  </td>
                  <td className="text-foreground/90">
                    Microsoft Edge WebView2 installed (the installer adds it if
                    missing)
                  </td>
                  <td className="text-foreground/90">
                    WebView2 kept current through Windows Update
                  </td>
                </tr>
                <tr>
                  <td className="font-medium text-foreground">Processor</td>
                  <td className="text-foreground/90">
                    64-bit dual-core (x64 or ARM64)
                  </td>
                  <td className="text-foreground/90">
                    Quad-core or better, 2.5 GHz and up
                  </td>
                </tr>
                <tr>
                  <td className="font-medium text-foreground">Memory (RAM)</td>
                  <td className="text-foreground/90">4 GB</td>
                  <td className="text-foreground/90">8 GB or more</td>
                </tr>
                <tr>
                  <td className="font-medium text-foreground">
                    Free disk space
                  </td>
                  <td className="text-foreground/90">300 MB</td>
                  <td className="text-foreground/90">
                    1 GB or more, for logs, saved sessions and backups
                  </td>
                </tr>
                <tr>
                  <td className="font-medium text-foreground">Display</td>
                  <td className="text-foreground/90">1280 × 720</td>
                  <td className="text-foreground/90">
                    1920 × 1080 or higher
                  </td>
                </tr>
                <tr>
                  <td className="font-medium text-foreground">Network</td>
                  <td className="text-foreground/90">
                    Any connection that can reach your <Term term="SSH" /> hosts
                  </td>
                  <td className="text-foreground/90">
                    A low-latency link when broadcasting to many hosts at once
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <H3>Worth knowing</H3>
          <Bullets>
            <li>
              Broadside is Windows only: it uses <Term term="ConPTY" /> for local
              shells and the <Term term="credential-manager" /> for your secrets,
              neither of which exists on macOS or Linux.
            </li>
            <li>
              No administrator rights are needed to run it. WebView2 ships with
              Windows 11 and recent Windows 10; on an older system the installer
              adds the Evergreen runtime, which is what draws the app's interface.
            </li>
            <li>
              Memory and processor use scale with how many terminals you keep open
              and the concurrency you set for <Nav>Broadcast</Nav> and{" "}
              <Nav>Skills</Nav> in <Nav>Settings</Nav>; each terminal also keeps
              its own scrollback in memory, which is the one you can set
              yourself (<Nav>Settings</Nav> &rarr; <Nav>Appearance</Nav> &rarr;{" "}
              <Nav>Terminal scrollback</Nav>).
            </li>
            <li>
              Disk use grows with saved sessions, the audit log and backups, all
              of which you control from the{" "}
              <SectionLink id="help-sec-logs">Logs</SectionLink> and{" "}
              <SectionLink id="help-sec-settings">Settings</SectionLink> tabs.
            </li>
          </Bullets>
          <H3>If Windows Security flags Broadside</H3>
          <Bullets>
            <li>
              It can happen, and it is a false alarm. An application that is not
              yet code-signed, is only days old, has few users, and opens shell
              sessions matches the pattern Windows Defender's automatic
              heuristics are built to be suspicious of. Opening terminals means
              starting processes, which is the behaviour being scored, and it is
              also the entire purpose of the app.
            </li>
            <li>
              A detection name ending in <code>!ml</code> means no known malware
              was matched at all: a model simply judged the file to look
              unusual. Broadside has been flagged this way once, as{" "}
              <code>Trojan:Win32/Bearfoos.A!ml</code>.
            </li>
            <li>
              If the app disappears, restore it from{" "}
              <Nav>Windows Security</Nav> under{" "}
              <Nav>Virus &amp; threat protection</Nav> and{" "}
              <Nav>Protection history</Nav>. Before you do, check the installer's
              SHA-256 against the one published with the release, so you know you
              are restoring the file that was actually built.
            </li>
            <li>
              Please report it if it happens, with the detection name and
              version. Each report goes to Microsoft as a false positive, which
              is what gets the detection corrected for everyone. Adding a
              Defender exclusion silences the warnings but also stops Defender
              watching that folder, so treat it as a temporary measure rather
              than a solution.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-shortcuts",
    title: "Keyboard shortcuts",
    keywords:
      "keyboard shortcuts keys shortcut matrix table list all hotkeys key bindings chord ctrl shift alt f11 f10 esc escape tab enter arrow alt left right ctrl shift g fullscreen ctrl shift t controls strip ctrl shift c copy ctrl shift v paste ctrl f find search right click paste select mouse copy on select composer history up down shift enter newline sftp commander ctrl click shift click multi select rename commit cancel what does key do reference",
    body: (
      <>
        <Lead>
          Every key Broadside takes for itself, and what it does. Anything not
          on this list belongs to whatever has the focus, in a terminal that
          means the shell, which is why the shortcuts here are nearly all{" "}
          <Nav>Ctrl+Shift</Nav> chords: a terminal cannot see the Shift, so{" "}
          <Nav>Ctrl+Shift+G</Nav> costs a program running in a tile nothing at
          all, while a function key would have taken <Nav>F10</Nav> away from{" "}
          <code className="font-mono text-xs">mc</code> and{" "}
          <code className="font-mono text-xs">nano</code>.
        </Lead>
        <ShortcutMatrix />
      </>
    ),
  },
  {
    id: "help-sec-warnings",
    title: "Warnings and messages",
    keywords:
      "warning warnings message messages error errors matrix table what does mean red test button red plug icon unreachable host down still red after restart os error 10054 forcibly closed connection reset maxstartups timed out timeout authentication failed no credentials stored host key changed refused unknown key tofu shell chip fish csh unsupported login shell amber chip disconnected banner reconnect every terminal hidden from the grid latency explain meaning troubleshooting no shell chip shell unread no integration console menu printed twice menu reprints pfsense rc.initial checked hosts report no blocks multiterminal silent no output got it dismiss amber line bottom of the pane strip keeps coming back said again",
    body: (
      <>
        <Lead>
          What Broadside can put in front of you, and what each one actually
          means. Warnings name the thing that went wrong rather than the thing
          you should do about it, so this is the other half.
        </Lead>
        <WarningMatrix />
        <p>
          Anything that reaches the{" "}
          <SectionLink id="help-sec-logs">Logs</SectionLink> tab is recorded
          with the host it happened on and the operation that was running, which
          is the place to look when a message went by too quickly to read.
        </p>
      </>
    ),
  },
  {
    id: "help-sec-glossary",
    title: "Glossary",
    keywords:
      "glossary definitions terms ssh sftp file transfer pty conptr conpty sudo tofu host key passphrase credential manager argon2 csv exec ansi xterm shell meaning",
    body: (
      <>
        <Lead>
          Plain-language definitions for the technical terms used above. Links
          throughout the documentation jump here.
        </Lead>
        <dl className="space-y-4">
          {GLOSSARY.map((g) => (
            <div key={g.term} id={glossaryId(g.term)}>
              <dt className="font-heading text-sm font-semibold text-foreground">
                {g.label}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-foreground/90">
                {g.def}
              </dd>
            </div>
          ))}
        </dl>
      </>
    ),
  },
];
