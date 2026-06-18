import { useMemo, useRef, useState, type ReactNode } from "react";
import { SearchIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
        encrypted connection. OmniTerminal uses SSH to reach every host you add.
        All traffic between the app and a host travels inside this encrypted
        channel.
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
        Windows' built-in version of a <Term term="PTY" />. OmniTerminal uses it
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
        usually asks for your password first. OmniTerminal can fill that password
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
        copying the file is not enough to use it. OmniTerminal can store the
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
        OmniTerminal stores passwords and passphrases here first so they are
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
        is one record. OmniTerminal can import a list of hosts from a CSV file.
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
        terminal standard those codes follow. OmniTerminal renders them so remote
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
          OmniTerminal is an SSH console built around one idea: send one command
          to many machines at once, while still giving each machine its own full
          interactive terminal when you need it. It also opens local Windows
          shells in the same window.
        </Lead>
        <Detail>
          <H3>The left rail</H3>
          <p>
            The buttons down the left side switch between the main areas of the
            app: <Nav>Hosts</Nav>, <Nav>Terminals</Nav>, <Nav>Broadcast</Nav>,{" "}
            <Nav>PTY Broadcast</Nav>, <Nav>OmniTerminal</Nav>, <Nav>Logs</Nav>{" "}
            and <Nav>Settings</Nav>. <Nav>Help</Nav> and <Nav>About</Nav> sit at
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
              The current app version is shown next to the OmniTerminal name at
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
      "server add edit import csv credentials password key sudo color status online offline columns multi-select connect",
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
              will not display the stored value. See the Security section for
              where these are kept.
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
              <Nav>Appearance</Nav>.
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
      "terminal tab interactive shell local powershell pwsh wsl cmd command prompt drag reorder find search maximize close all conpty pty plus launcher path restart shortcut commands scope",
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
              OmniTerminal reads PATH when it starts. If you install a new shell
              while the app is already running, restart OmniTerminal for it to
              show up in the launcher.
            </li>
          </Bullets>
          <H3>Working with tabs</H3>
          <Bullets>
            <li>Drag tabs to reorder them. Their identity stays stable, so reordering never disconnects a session.</li>
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
      "broadcast many hosts one command exec non-interactive output history autoscroll headers timeout guard destructive parallel concurrency",
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
      "pty broadcast type every open terminal interactive live shells mirror keystrokes difference",
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
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-omniterminal",
    title: "OmniTerminal",
    keywords:
      "omniterminal aggregate combined output color tint per host block log delete two open compare",
    body: (
      <>
        <Lead>
          <Nav>OmniTerminal</Nav> runs a command across all of your open terminals
          and shows every host's output together, each tinted with that host's
          color so you can compare results at a glance.
        </Lead>
        <Detail>
          <H3>How it works</H3>
          <Bullets>
            <li>
              It collects the output from your open sessions into one combined,
              color-coded view. You need at least two terminals open for the
              combined view to be meaningful.
            </li>
            <li>
              Each command produces a block in the log, labeled with the command
              that ran. You can delete an individual block to keep the view tidy.
            </li>
          </Bullets>
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
      "settings performance network probe destructive guard shortcut commands appearance theme columns backup audit security admin lock reset jump search",
    body: (
      <>
        <Lead>
          <Nav>Settings</Nav> is where you tune how OmniTerminal behaves. Use the
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
              <Nav>Appearance</Nav>: light or dark theme, and which{" "}
              <Nav>Hosts</Nav> columns to show.
            </li>
            <li>
              <Nav>Backup</Nav>: save a copy of your app data.
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
          OmniTerminal handles passwords and connects to your machines, so it is
          worth understanding exactly what it stores, what it sends, and the
          controls you have. There is no telemetry and the app never phones home.
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
      "glossary definitions terms ssh pty conptr conpty sudo tofu host key passphrase credential manager argon2 csv exec ansi xterm shell meaning",
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

  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.keywords.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="mx-auto flex max-w-5xl gap-8 px-6 py-6">
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
                className={cn(
                  "block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
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
            How OmniTerminal works, tab by tab, with a glossary for the technical
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
