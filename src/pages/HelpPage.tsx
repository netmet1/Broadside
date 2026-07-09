import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SearchIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Help scroll position, remembered while the app runs (sessionStorage clears on
 * restart). Mirrors the Settings tab's persistence pattern. */
const HELP_SCROLL_KEY = "help-scroll-top";
/** Sticky-offset to discount when picking the section nearest the top, matching
 * the `help-sec-` scroll-margin-top: 4rem rule in index.css. */
const STICKY_OFFSET_PX = 64;

/** Stable DOM id for a glossary entry, used by inline term links. */
function glossaryId(term: string): string {
  return "help-sec-glossary-" + term.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Smooth-scroll a section or glossary entry to the top of the scroll area.
 * The `help-sec-` scroll-margin rule in index.css keeps it clear of anything
 * pinned at the top. */
function scrollToId(id: string) {
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
      className="font-medium text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
      title="Jump to definition"
    >
      {children ?? term}
    </a>
  );
}

/** Accent for the names of app areas and named controls (tabs, buttons, key
 * settings), so they stand out from the surrounding prose. Distinct from the
 * dotted-underline glossary links above and from the emerald/amber/red status
 * colors used elsewhere in the app. */
function Nav({ children }: { children: ReactNode }) {
  return (
    <span className="font-medium text-sky-600 dark:text-sky-400">
      {children}
    </span>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id}>
      <h2 className="font-heading text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

/** A high-level lead paragraph, visually distinct from the detail that follows. */
function Lead({ children }: { children: ReactNode }) {
  return <p className="text-[0.95rem] text-foreground">{children}</p>;
}

function Detail({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-2 border-l-2 border-border/60 pl-4">{children}</div>
  );
}

function H3({ children }: { children: ReactNode }) {
  return (
    <h3 className="font-heading text-sm font-semibold text-foreground">
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
        An optional secret that unlocks an SSH private key file, so that simply
        copying the file is not enough to use it. Broadside can store the
        passphrase for you in the same protected place as your other secrets.
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

type HelpSection = {
  id: string;
  title: string;
  /** Extra words (beyond the title) the filter box matches against. */
  keywords: string;
  body: ReactNode;
};

const SECTIONS: HelpSection[] = [
  {
    id: "help-sec-overview",
    title: "Overview and getting started",
    keywords:
      "intro introduction start home rail sidebar navigation theme dark light maximize fullscreen status bar hint version",
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
            <Nav>PTY Broadcast</Nav>, <Nav>MultiTerminal</Nav>, <Nav>SFTP</Nav>,{" "}
            <Nav>Logs</Nav> and <Nav>Settings</Nav>. <Nav>Help</Nav> and{" "}
            <Nav>About</Nav> sit at
            the bottom. The rail collapses to icons only on narrow windows, or
            with the collapse button at the top. Drag its right edge to resize
            it, or double-click that edge to reset the width.
          </p>
          <H3>Finding your way</H3>
          <Bullets>
            <li>
              Hover almost any control and a short explanation appears in the
              status bar along the bottom of the window.
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
              again to return.
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
      "server add edit import csv credentials password key sudo color status online offline columns multi-select connect tags tag chip filter sort group untagged hidden missing fields resize column",
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
              For your safety, saved passwords and passphrases are never shown
              again after you save them. You can replace a secret, but the app
              will not display the stored value. See the{" "}
              <SectionLink id="help-sec-security">Security section</SectionLink>{" "}
              for where these are kept.
            </li>
          </Bullets>
          <H3>Importing many hosts</H3>
          <p>
            Use <Nav>Import</Nav> to load a list of hosts from a{" "}
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
      "terminal tab interactive shell local powershell pwsh wsl cmd command prompt drag reorder find search maximize close all conpty pty plus launcher path restart shortcut commands scope alt arrow switch next previous keyboard navigation copy paste clipboard right-click select ctrl shift c v go to session jump scroll center",
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
              and close a single tab or use <Nav>Close all</Nav> to clear them
              with a confirmation.
            </li>
          </Bullets>
          <H3>Copy, paste and jumping to a tab</H3>
          <Bullets>
            <li>
              <strong className="font-semibold">Copy</strong> by selecting text
              with the mouse — the selection is copied to the clipboard as soon
              as you release the button (no menu, no shortcut needed). You can
              also press <Nav>Ctrl+Shift+C</Nav> to copy the current selection.
            </li>
            <li>
              <strong className="font-semibold">Paste</strong> with a{" "}
              <Nav>right-click</Nav> in the terminal, or with{" "}
              <Nav>Ctrl+Shift+V</Nav>. Plain <Nav>Ctrl+C</Nav> and{" "}
              <Nav>Ctrl+V</Nav> are left alone so the shell still receives them
              (for example Ctrl+C to interrupt a running command).
            </li>
            <li>
              With many tabs open, use the <Nav>Go to session…</Nav> picker at
              the top right to jump to any terminal. If its tab is scrolled out
              of view, the tab strip scrolls to bring it to the center so you do
              not have to hunt for it.
            </li>
          </Bullets>
          <H3>Shortcut commands</H3>
          <Bullets>
            <li>
              The <Nav>Shortcut command</Nav> dropdown runs a saved command in the
              active tab. Each shortcut has a scope:{" "}
              <Nav>SSH / WSL (Linux)</Nav>, <Nav>Command Prompt / PowerShell</Nav>,
              or <Nav>Both</Nav> for commands that work everywhere (for example
              whoami).
            </li>
            <li>
              The dropdown shows only the shortcuts that run in the current tab,
              so a Linux command is never offered in a Windows shell. The icon
              next to each one reflects the active tab: the host icon on SSH and
              WSL tabs, the terminal icon on Command Prompt and PowerShell tabs.
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
              hosts are selected by default — you choose the targets for each
              broadcast.
            </li>
            <li>
              Two filters narrow the rail: a <Nav>Find by label…</Nav> box that
              matches host labels as you type (like a find bar), and a{" "}
              <Nav>Filter tags</Nav> dropdown that works exactly like the tag
              filter on the <SectionLink id="help-sec-hosts">Hosts</SectionLink>{" "}
              table — uncheck tags (or the untagged bucket) to hide hosts, with{" "}
              <Nav>All</Nav> / <Nav>None</Nav> shortcuts. The two combine, and each
              filter lasts for the session and resets on restart.
            </li>
            <li>
              Filtering only ever narrows what you can act on:{" "}
              <strong className="font-semibold">a host the filter hides is
              unchecked automatically</strong>, and it comes back{" "}
              <em>unchecked</em> when you clear the filter — so a hidden host can
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
      "pty broadcast type every open terminal interactive live shells mirror keystrokes difference rail filter tag label search select all",
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
              hosts.
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
            <li>
              The session rail has the same <Nav>Find by label…</Nav> box and{" "}
              <Nav>Filter tags</Nav> dropdown as{" "}
              <SectionLink id="help-sec-broadcast">Broadcast</SectionLink>{" "}
              (filtering a session out unchecks it), applied to each session'sShow Manual Activity
              host.
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
            <li>Show Manual Activity
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
              commands sent from <Nav>MultiTerminal</Nav> appear here.
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
              history). <Nav>Clear command history</Nav> clears the Up/Down recall
              shared with <Nav>Broadcast</Nav>. <Nav>Close all terminals</Nav>
              tears down every open terminal after a confirmation.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-sftp",
    title: "SFTP",
    keywords:
      "sftp file transfer browse upload download put get commander dual two pane local remote folder directory navigate drag drop delete recycle bin make folder clash mode overwrite all newer only skip existing broadcast multi-host per-host progress bar create path confirm host key tofu concurrency queue tab remember multi-select ctrl shift click range select many files group",
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
              A two-pane view — your PC on the left, the remote host on the right.
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
            restarts, and so is the tab — Commander or Broadcast — you last had
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
      "settings performance network probe destructive guard shortcut commands appearance theme columns backup restore csv hosts audit security admin lock reset jump search danger zone delete wipe all hosts credentials",
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
              run on local Windows shells, and <Nav>Both</Nav> commands run
              everywhere. See the Terminals section for how the dropdown uses the
              scope.
            </li>
            <li>
              <Nav>Appearance</Nav>: light or dark theme, which{" "}
              <Nav>Hosts</Nav> columns to show, and which detected local shells
              appear in the Terminals <Nav>plus button</Nav> menu.
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
      "security credentials storage credential manager age encrypted file sqlite transmitted telemetry tofu host key sudo auto-fill admin lock argon2 recovery code isolation separate logins privacy",
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

export function HelpPage() {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The id of the section nearest the top of the scroll area, for the live TOC
  // highlight.
  const [activeId, setActiveId] = useState<string | null>(null);

  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.keywords.toLowerCase().includes(q),
    );
  }, [query]);

  // Restore the last scroll position on mount, then track scrolling to (a) keep
  // the TOC highlight in sync and (b) remember the position for the next visit.
  // Saving is gated until after the restore so the shared <main> being clamped
  // on remount cannot overwrite the saved value with a wrong spot.
  const saveEnabled = useRef(false);
  useEffect(() => {
    const scroller = rootRef.current?.closest("main");
    if (!scroller) return;

    const computeActive = () => {
      const anchor = scroller.getBoundingClientRect().top + STICKY_OFFSET_PX;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (!el) continue;
        const dist = Math.abs(el.getBoundingClientRect().top - anchor);
        if (dist < bestDist) {
          bestDist = dist;
          best = s.id;
        }
      }
      setActiveId(best);
    };

    // Restore (next frame, so the content has laid out), then allow saving.
    // Always assign scrollTop (even 0) so we clear any position inherited from
    // the previously shown page sharing this <main>.
    const saved = Number(sessionStorage.getItem(HELP_SCROLL_KEY));
    requestAnimationFrame(() => {
      scroller.scrollTop = Number.isFinite(saved) && saved > 0 ? saved : 0;
      computeActive();
      saveEnabled.current = true;
    });

    let raf = 0;
    const onScroll = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        computeActive();
        if (saveEnabled.current) {
          sessionStorage.setItem(HELP_SCROLL_KEY, String(scroller.scrollTop));
        }
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={rootRef} className="mx-auto flex max-w-5xl gap-8 px-6 py-6">
      {/* Sticky table of contents (GitBook-style). Hidden on narrow widths,
          where the sections simply stack and scroll. */}
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-4 space-y-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter help"
              aria-label="Filter help sections"
              className="pl-8 pr-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            )}
          </div>
          <nav className="space-y-0.5">
            {visibleSections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => scrollToId(s.id)}
                aria-current={activeId === s.id ? "true" : undefined}
                className={cn(
                  "block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                  activeId === s.id
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground",
                )}
              >
                {s.title}
              </button>
            ))}
            {visibleSections.length === 0 && (
              <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                No sections match.
              </p>
            )}
          </nav>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="mb-6">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Help center
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            How Broadside works, tab by tab, with a glossary for the technical
            terms. Hover any control in the app to see a short explanation in the
            status bar.
          </p>
        </header>

        <div className="space-y-10">
          {visibleSections.map((s) => (
            <Section key={s.id} id={s.id} title={s.title}>
              {s.body}
            </Section>
          ))}
          {visibleSections.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No help sections match your filter.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
