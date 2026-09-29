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
import {
  HELP_HOSTS,
  HELP_SKILLS,
  HELP_TEMPLATES,
  HELP_TERMINALS,
} from "@/pages/help/sections";

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

// Listed under its section in the Help rail. See ./help/subheadings.
H3.isSubheading = true as const;

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
        SFTP tab uses it to move files to and from your hosts.
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
        The standard that Unix-like systems follow, which is why a command
        written for Linux usually works on macOS or inside WSL. In Broadside,
        Bash-like terminals such as Git Bash, MSYS2 and Cygwin count as POSIX:
        they are tagged <code>posix</code> and join the{" "}
        <Nav>WSL / POSIX</Nav> tab in <Nav>PTY Broadcast</Nav>.
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
        A secret that unlocks an SSH private key file, so that a copy of the
        file alone is useless. It is only used on your own machine and never
        sent to the host. Broadside stores it with your other secrets.
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
      "intro introduction start home rail sidebar navigation theme dark light maximize fullscreen status bar hint version window size dimensions resolution pixels how big width height 1024x700 minimum smallest font size terminal app application point px live readout bottom left corner what are those numbers three numbers keep disappearing hint replaces them hint stuck on screen stays forever wont go away numbers gone idle timeout seven seconds mouse resting on button walked away esc escape key does not exit fullscreen why not restore f11 only vi vim insert mode editor keeps the key session timeout 30m reminder fourth item bottom bar timeout is on open on a different tab start page startup tab dialog closed when i clicked outside lost my work clicked off the dialog modal disappeared click outside does not close toast history help sub headers subheadings contents list indented spinner in the status bar what is it doing something still running background work other tab activity in progress sftp transfer keeps spinning",
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
            app: <Nav>Hosts</Nav>, <Nav>Templates</Nav>, <Nav>Terminals</Nav>,{" "}
            <Nav>Broadcast</Nav>, <Nav>PTY Broadcast</Nav>,{" "}
            <Nav>MultiTerminal</Nav>, <Nav>Skills</Nav> and <Nav>SFTP</Nav> at
            the top, and <Nav>Logs</Nav>, <Nav>Settings</Nav>, <Nav>Help</Nav>{" "}
            and <Nav>About</Nav> at the bottom. The rail shrinks to icons on
            narrow windows, or with the collapse button at the top. Drag its
            right edge to resize it, or double-click that edge to reset the
            width. Broadside opens on <Nav>Hosts</Nav>;{" "}
            <Nav>Settings → Startup</Nav> picks a different first tab.
          </p>
          <H3>Finding your way</H3>
          <Bullets>
            <li>
              Hover almost any control and a short explanation appears in the
              status bar along the bottom of the window. The right-hand end of
              the bar counts what the page is showing. On <Nav>Terminals</Nav>,{" "}
              <Nav>16/20 sessions connected</Nav> means 20 tabs are open and 4
              of them (the red ones) have no live connection.
            </li>
            <li>
              When nothing is hovered, the left-hand end shows the window size,
              the terminal font size and the app font size, and updates them as
              you resize or zoom. While the session timeout is on, it is shown
              there too (<Nav>Session timeout 30m</Nav>), so you always know it
              is set.
            </li>
            <li>
              Every message that pops up in the bottom corner (a toast) is also
              kept in <Nav>Logs</Nav> &rarr; <Nav>Toasts History</Nav>, so one
              that went by too fast can be read again.
            </li>
            <li>
              A spinner in the status bar with a short line such as{" "}
              <Nav>SFTP transfer in progress</Nav> means work is still running on
              another tab. It stays until that work finishes.
            </li>
            <li>
              The app version is shown next to the Broadside name at the top of
              the rail and in the About dialog.
            </li>
            <li>
              Switch between light and dark appearance in <Nav>Settings</Nav>,
              under <Nav>Appearance</Nav>.
            </li>
            <li>
              Press <Nav>F11</Nav> (or the maximize button on a terminal tab) to
              fill the whole window with a single terminal, and <Nav>F11</Nav>{" "}
              again to return. <Nav>Esc</Nav> does not come back out: it goes to
              the program in the terminal, because editors such as{" "}
              <code>vi</code> depend on it. <Nav>Alt+Left</Nav> /{" "}
              <Nav>Alt+Right</Nav> still change sessions while you are
              maximized.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: HELP_HOSTS,
    title: "Hosts",
    keywords:
      "server add edit import csv credentials password key sudo color status online offline columns multi-select connect tags tag chip filter sort group untagged hidden missing fields resize column find by label search box query narrow amber chip warning login shell unsupported what does it mean shell integration auto always never console menu pfsense rc.initial no shell shell unread override command block tracking import export menu reconnect check ping icmp is it back yet rebooted server reboot waiting for machine to come up probe interval seconds port 22 tcp check pill green red how often ask still answering back disable disabled turned off green too soon already back that was fast went green then amber why did the pill go green during a reboot sshd still listening shell killed first drag column header move reorder rearrange columns order of columns put hostname first swap columns remembered across restarts reset defaults columns box scoped chips in settings drag the chips header label truncated cut off ellipsis la userna long line flashes on connect blink flicker flash before the banner what was that line where did it come from omni_precmd bash_version prompt_command typed by itself not mine setup line visible on slow connection vpn wireless remote high latency laggy link appears then disappears wiped cleared line in my shell history up arrow recalls it bash_history histcontrol ignorespace ignoreboth hist_ignore_space histtimeformat delete the entry remove from history broadside typed it not the user zsh cannot delete hosts templates profiles switch three sides third position profiles side of the hosts tab where is the profiles list manage shell profiles from the hosts tab export a single profile launch a profile from the hosts tab open a profile from the profiles list multi-profile multi profile button open several profiles at once tick profiles and open them terminal button on a profile row profile row launch",
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
              When you pick a key file, Broadside checks straight away whether
              it is protected by a passphrase. If it is, the passphrase becomes
              required, and a wrong one is refused before you save. This is the
              only place a key passphrase is asked for: a terminal never prompts
              for it.
            </li>
            <li>
              For your safety, saved passwords and passphrases are never shown
              again after you save them. You can replace a secret, but the app
              will not display the stored value. See the{" "}
              <SectionLink id="help-sec-security">Security section</SectionLink>{" "}
              for where these are kept.
            </li>
            <li>
              A host row can carry a small amber chip, most often naming a login
              shell Broadside cannot fully work with (fish, for example). Other
              pages show the same mark as an amber triangle beside the host. The
              host is never hidden, and terminals and broadcasts to it still
              work.{" "}
              <SectionLink id="help-sec-warnings">
                Warnings and messages
              </SectionLink>{" "}
              explains every chip, banner and error.
            </li>
            <li>
              <b>Shell integration</b>, at the foot of the host's form, controls
              a short setup line Broadside sends when a terminal opens. It lets
              Broadside see where each command starts and ends, which{" "}
              <Nav>MultiTerminal</Nav> and <Nav>Skills</Nav> rely on.{" "}
              <Nav>Auto</Nav>, the default, decides from what the host reports.{" "}
              <Nav>Always</Nav> is for a bash or zsh host that will not say what
              its shell is (a restricted account, for example).{" "}
              <Nav>Never</Nav> sends nothing and leaves the login screen exactly
              as the host draws it. Devices that greet you with a menu instead
              of a shell are detected and left alone automatically. A change
              applies to the next terminal you open on that host.
            </li>
            <li>
              On some hosts that setup line is saved in the shell's history, so
              the <Nav>Up</Nav> arrow finds it instead of your last command.{" "}
              <Nav>Settings &gt; Security</Nav> can remove it for you; see the{" "}
              <SectionLink id="help-sec-security">Security section</SectionLink>.
            </li>
            <li>
              <b>Reconnect check</b> helps when you have just rebooted a
              machine. When a terminal on this host loses its connection, a pill
              on its <Nav>Reconnect</Nav> banner keeps checking whether the host
              is back: red while it is down, green once it answers, so you do
              not have to keep clicking <Nav>Reconnect</Nav> to find out.
              <br />
              Right after you type <code>reboot</code> the pill may read{" "}
              <Nav>SSH still answering</Nav>, because the machine has not gone
              down yet. Wait for <Nav>SSH back</Nav>: that is the one that means
              you can reconnect.
              <br />
              The setting picks how often it checks (every 1 to 10 seconds, 3 by
              default), or <Nav>Disable</Nav> turns it off for this host. The
              check only looks for the host's SSH port answering. It never logs
              in, and it stops when you reconnect or close the tab.
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
              answers on the network.
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
              to hosts whose label matches what you type. It works together with
              the tag filter and clears with the <Nav>x</Nav>.
            </li>
            <li>
              You can hide columns you do not use from <Nav>Settings</Nav>, under{" "}
              <Nav>Appearance</Nav>. When a column is hidden, each row gets a small
              tag/label icon in its <Nav>Actions</Nav>; click it to see that host's
              values for the hidden columns.
            </li>
            <li>
              Drag a column's name in the header to move the column, or drag the
              thin strip on the header's right edge to resize it. The order is
              remembered across restarts. You can also reorder the columns in{" "}
              <Nav>Settings → Appearance</Nav>, where <Nav>Reset defaults</Nav>{" "}
              puts them back. The checkbox, colour swatch and{" "}
              <Nav>Actions</Nav> columns stay where they are.
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
              them; a host stays visible while any of its tags is checked. The
              icon is highlighted while a filter is on, and the filter resets
              when you restart the app.
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
    id: HELP_TEMPLATES,
    title: "Templates",
    keywords:
      "template templates profile profiles saved arrangement layout set of sessions open several at once workspace preset scene morning routine daily check drag drop canvas grid preview boxes plus box reorder move a box remove a session placeholder unresolved host reference does not match no host here point it at a host export import json file another machine share send a template to a colleague startup launch at startup open at startup connect at startup autostart auto start run on launch only one template can open at startup radio button pick one open button add to the front add to the end cancel already open terminals arrangement will not match how many sessions eight too many slow name colour color chip badge edit pencil delete a template empty state create your first template where is the templates list hosts tab toggle switch between hosts and templates nothing launches from the templates tab why is there no open button preview does not match my grid columns row fill stretch tall gaps settings grid one more box than sessions plus box counted shell profiles group custom terminals group local shells hidden in settings sort inside each group grid settings popover change columns without leaving the page drag a session here strip band at the bottom duplicate name same name twice numbered 02 03 renamed automatically duplicate a template copy a template clone save as rename instead of copy make a variant swap sessions two templates called the same thing show all templates recent five import from the splash screen closed editor deleted somewhere else deleted while open create it again discard greyed button no tooltip why is the button grey status bar hint on a disabled button",
    body: (
      <>
        <Lead>
          A <Nav>template</Nav> is a saved arrangement of terminal sessions.
          Build it once, and one action opens the whole set: four servers and a
          local shell, in the order you want them, without opening five things
          by hand every morning.
        </Lead>
        <p>
          The <Nav>Templates</Nav> tab on the left rail is where you build and
          edit templates; nothing launches from it. You open them from the{" "}
          <Nav>Hosts</Nav> tab, using the <Nav>Hosts</Nav> |{" "}
          <Nav>Templates</Nav> | <Nav>Profiles</Nav> switch at the top.
        </p>
        <Detail>
          <H3>Building one</H3>
          <Bullets>
            <li>
              The rail on the left of the editor has four groups: your saved{" "}
              <Nav>hosts</Nav>, the <Nav>local shells</Nav> this machine has,
              your <Nav>custom terminals</Nav> (Git Bash and the like) and your
              saved <Nav>shell profiles</Nav>. Drag a row into a box, or click
              it to add it at the end.
            </li>
            <li>
              Sorting works within each group, so hosts, shells and profiles
              never get mixed together. A shell hidden in{" "}
              <Nav>Settings → Appearance</Nav> is hidden here too.
            </li>
            <li>
              Drag a box onto another to change the order, and use the small{" "}
              <Nav>x</Nav> on a box to take that session out. The number in the
              corner is the order it opens in.
            </li>
            <li>
              The same host can appear more than once.
            </li>
          </Bullets>
          <H3>The preview</H3>
          <p>
            The boxes are laid out with the same grid settings as the{" "}
            <SectionLink id="help-sec-terminals">Terminals</SectionLink> grid,
            so what you see is what launching will build.{" "}
            <Nav>Grid settings</Nav>, in the line under the canvas, changes them
            without leaving the page. There is one set of grid settings, so a
            change here changes Terminals too. Drop new sessions on the dashed{" "}
            <Nav>Drag a session here</Nav> strip.
          </p>
          <p>
            A template saves only the sessions and their order, not a layout, so
            the same template looks right on a laptop or a wall of monitors.
          </p>
          <H3>Names, and finding one again</H3>
          <Bullets>
            <li>
              Two templates cannot share a name. Save a second &ldquo;Morning
              check&rdquo; and it is stored as <Nav>Morning check 02</Nav>.
            </li>
            <li>
              Changing the name of a saved template and pressing{" "}
              <Nav>Save</Nav> renames it; it does not make a copy. To copy one,
              use the <Nav>Duplicate</Nav> button on its row in the Hosts tab's
              Templates list. The copy is numbered like a clashing name, is
              selected in the list, and never opens at startup.
            </li>
            <li>
              Closing the editor with the <Nav>x</Nav> shows{" "}
              <Nav>New template</Nav>, <Nav>Import</Nav> and the five templates
              you edited most recently. <Nav>Show all</Nav> goes to the full list
              on the Hosts tab.
            </li>
            <li>
              If you delete a template on the Hosts tab while it is open in the
              editor, nothing on the canvas is lost: <Nav>Create</Nav> saves it
              again as a new template, or <Nav>Discard</Nav> closes the editor.
            </li>
          </Bullets>
          <H3>Opening one</H3>
          <Bullets>
            <li>
              On the <Nav>Hosts</Nav> tab, switch to <Nav>Templates</Nav>, pick
              one with its radio button and press <Nav>Open</Nav>. It opens
              every session in the saved order and takes you to the Terminals
              tab.
            </li>
            <li>
              With terminals already open you are asked where the new tabs go:{" "}
              <Nav>add to the front</Nav>, <Nav>add to the end</Nav>, or{" "}
              <Nav>cancel</Nav>. Opening a template never closes anything.
            </li>
            <li>
              Anything the template names that this machine does not have (a
              deleted host, a removed WSL distro) is listed in that dialog and
              skipped. The rest still opens.
            </li>
          </Bullets>
          <H3>Opening at startup</H3>
          <p>
            One template, at most, can open itself when Broadside starts. The
            setting is in the editor's top bar and has two on positions:
          </p>
          <Bullets>
            <li>
              <Nav>Open the tabs at startup</Nav> opens the tabs without
              connecting. Each one waits on its <Nav>Reconnect</Nav> button.
            </li>
            <li>
              <Nav>Open and connect at startup</Nav> also connects them, so live
              sessions start as soon as Broadside does. Saving this asks you to
              confirm.
            </li>
          </Bullets>
          <p>
            Choosing it on one template takes it off whichever one had it.
            While a template opens at startup, Broadside starts on{" "}
            <Nav>Terminals</Nav> and <Nav>Settings → Startup</Nav> is greyed.
          </p>
          <H3>Export and import</H3>
          <Bullets>
            <li>
              An exported file lists each host by label, address, port and user
              name. It never contains credentials.
            </li>
            <li>
              Importing matches those against this PC's hosts. Anything that
              does not match arrives as a named box for you to point at a real
              host. Importing never creates or changes a host, and never sets a
              template to open at startup.
            </li>
            <li>
              Local shells and profiles belong to one PC. They travel by name,
              so a template made elsewhere still tells you what it wanted when
              this PC does not have it.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: HELP_TERMINALS,
    title: "Terminals",
    keywords:
      "terminal tab interactive shell profile profiles import export reorder grip survive reset backup restore startup command local powershell pwsh wsl cmd command prompt drag reorder find search maximize close all conpty pty plus launcher reconnect divider session disconnected scrollback stack clean screen mouse reporting stuck htop garbage path restart shortcut commands scope alt arrow switch next previous keyboard navigation copy paste clipboard right-click select ctrl shift c v go to session jump scroll center grid tiled layout split screen tabs toggle side by side watch several settings columns across item width height characters rows pin fixed size horizontal scroll auto profile profiles saved launch working directory folder browse startup command name label how many claude open in directory eye hide show title bar header chrome peek hover outline host colour selected active tile denser rename pencil tab name title exclude ignore hide from grid order rearrange match two terminals side by side full window fullscreen ctrl shift g keyboard shortcut not f10 mc nano function key strip reveal slide focus controls ctrl shift t toolbar keyboard reach tab key drag resize tile edge corner handle reset size temporary this session only not saved single terminal fills ignores grid settings custom terminal application git bash msys2 cygwin exe program arguments browse add your own posix family command language broadcast rail send to several at once composer targets in place reset display redraw garbled stuck full screen prompt dialog box debconf needrestart kernel upgrade escape sequences echoed arrow keys not working enter tab unresponsive noninteractive ctrl l redraw prompt blank pane after reset why no ctrl c interrupt stray ^l character while command running sleep long command still clears output disappeared missing after reset display screen wiped when command finished withdraw redraw type ahead kept reset grid strict checkbox drag saved written to settings lost on restart short last row stretch tall tile in the last column leave the gap fill hole uneven columns trimmed to terminals open auto fit fewer than columns try again retry failed connection unreachable close tab focus ring where is the keyboard esc leaves the strip back to the terminal tab wraps does not go into the grid hidden buttons appear when focused status bar count sessions connected red tab not connected magnify enlarge shrink squint hard to read focus follows mouse hover highlight which tile is active where does my typing go paste lands wrong terminal mouse over outline moves view menu sessions menu grouped controls toolbar crowded buttons missing where did the button go reset grid reset display side by side compact tab labels small window narrow 1024 rail fits tiles too small grid unusable ridiculous cramped one column stacked single column instead of two why did the grid stack minimum window size small screen laptop 16 inch large monitor app font size big text buttons lost their labels icons only sessions button cut off clipped edge horizontal scrollbar chrome too big too many terminals open at once how many can i watch greyed out ghosted dimmed pale disabled menu entry vanished where did reset grid go why cant i click it full tab labels checkbox tick empty box unchecked initials dot esc does nothing in fullscreen does not exit maximized terminal grid ctrl shift g only vi vim editor keeps escape empty grid nothing to show view menu disappears behind strip menu cut off top of screen dropdown clipped in fullscreen pull tab handle grabber top centre middle of the top edge how do i get the toolbar back controls gone cant find the toolbar in fullscreen top edge does not open the strip any more moving the mouse to the top does nothing click the tab tab does not open the strip nothing happens when i hover the tab strip blinks flickers bounces after closing a menu focus changes too fast moving to the toolbar sweeping across tiles crossing a tile on the way wrong tile became active settle pause delay before focus moves shortcut list changed to the wrong session go button keeps the keyboard stuck in the toolbar cannot type after pressing go have to click the tile again serial console com port baud rate line speed 9600 115200 8n1 console cable usb serial adapter router switch firewall rs232 db9 rj45 rollover port already in use access denied putty tera term blank pane press enter garbage characters wrong speed unplugged disconnected select a tab with the keyboard arrow keys along the tab strip cannot reach the tabs by tabbing home end enter choose session no mouse typing went into the other window wrong application typed in my browser by mistake keystrokes lost window not focused not the active window inactive background looks active but is not scroll bars appear on hover when unfocused alt tab back to broadside outline moved while i was away click to activate first click activates and selects hover does not focus the window focus follows mouse across applications how many matches find bar does not say how many no count number of results 3 of 17 which match am i on next previous match highlight all matches yellow search scrollback for a word ctrl f in a terminal search says nothing found when there are matches retry all close failed unhide all bulk repair reconnect everything red tabs at once clear away dead tabs remove failed connections tidy up serial shortcut scope greyed go button disabled no commands for com port no serial shortcuts empty picker list nothing to pick manage shortcuts add the first one console cable cisco ios show version tab colour color local shell tint powershell blue command prompt wsl which tab am i typing in profile colour my font is missing inter segoe ui arial proportional not in the list why cant i pick my favourite font variable width scrollback scroll back buffer history how far up can i scroll output cut off truncated lost older lines gone only 1000 lines 5000 lines memory per pane raise the limit end a session hang up disconnect without closing the tab unplug keep the pane keep the output stay on screen close the shell not the tab mangled garbled box drawing characters question marks accents emoji utf-8 unicode code page 437 chcp 65001 claude logo ascii art broken corners weird symbols in powershell local shell encoding disconnect all hang up every session at once keep all the tabs bulk unplug ask before acting on more than confirmation threshold are you sure stop asking me so often too many prompts guard limit 5 default 1 to 11 broadcast button greyed disabled one terminal only nothing to broadcast to rail hidden ssh pill is it back yet rebooted reconnect check icmp ping port check green red amber percentage last two minutes advanced grid settings collapsed section starting number seed default unchecking auto lands on your own numbers 80x24 classic terminal size reset defaults just the advanced section session timeout idle close automatically inactivity why did my terminal close by itself left it overnight closed while i was away keep alive keepalive nat firewall state table connection dropped silently hangs after a while disable the timeout never close sleep 120 long running command was closed while it was running foreground background job ampersand tmux screen vim editor full screen program never times out how does it know paste mode plain sh dash device cli no shell integration falls back spinner connecting forever stuck on connecting nothing happening is it frozen hung blank pane black screen after connecting no prompt taking ages slow to open which half is slow signed in waiting for the login screen wireless vpn latency why does it take ten seconds duplicate a profile copy clone make another one like this second profile same shell different folder profile copy numbered delete profile double click doubleclick two clicks confirm dialog ok cancel are you sure guard accidental deletion undo a deleted profile single click does nothing bin trash icon copy of a copy nested copy copy numbering collapses close others close other tabs keep only this one close everything except this tab close other ssh close other command prompts close other powershell right click a tab menu filter by kind show only ssh hide powershell hide local shells view filter all none tabs missing where did my tabs go hidden by filter select then right click to copy right click copies highlight does not copy any more clipboard overwritten by selecting import profile import profiles export profile export profiles importing profiles exporting profiles profile file profiles file json file of profiles share profiles copy profiles to another pc move profiles another machine carry my profiles back up profiles restore profiles profile import preview startup command shown before importing profile already taken numbered copy on import custom terminal matched by name struck through after import which shell did this profile use remembers the name of the missing shell hover a struck through profile tells you which terminal to re-add edit pre-picks the shell after you add it back profiles on the hosts tab third switch position profiles list table manage profiles somewhere bigger export a single profile export one profile export just this one tick boxes export selected profiles per profile export where do i see the folder and startup command without hovering launch a profile from the hosts tab open profiles from the profiles list multi-profile multi profile open several profiles at once open four shells in one go greyed multi-profile button nothing ticked opening the same profile twice does not ask second shell same folder ticked profile missing shell skipped hosts in the plus menu open a host from the terminals tab launcher hosts section saved hosts list in the launcher without leaving terminals collapse section roll up sections expand collapse twisty chevron fold sections away remembered across restarts persisted collapsed menu too long scrolling past hosts to reach profiles how many applies to hosts open three sessions to one host already open host second session to the same host does not ask why does the hosts tab ask and the plus menu not menu cut off at the bottom serial console cut off profiles cut off have to scroll the window to reach it menu taller than the window fits the window resize add a host from the plus menu new host from the terminals tab reorder profiles on the hosts tab drag a profile row grip move profile columns resize profile columns hide profile columns",
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
              Open a remote shell from the <Nav>Hosts</Nav> tab, or from the{" "}
              <Nav>Hosts</Nav> section of the <Nav>plus button</Nav> menu at the
              end of the tab strip. The connection runs over{" "}
              <Term term="SSH" />.
            </li>
            <li>
              The same <Nav>plus button</Nav> opens local Windows shells: Windows
              PowerShell, PowerShell 7 (pwsh), Command Prompt and any installed
              WSL distributions.
            </li>
            <li>
              The menu has four sections: <Nav>How many</Nav> with the local
              shells under it, then <Nav>Hosts</Nav>, <Nav>Profiles</Nav> and{" "}
              <Nav>Serial console</Nav>. Click the arrow beside a section's name
              to roll it up; it stays rolled up until you open it again. Long
              lists scroll inside the menu.
            </li>
            <li>
              <Nav>How many</Nav> applies to hosts as well: set it to three and
              one click opens three sessions. A host that already has a tab is
              marked <Nav>already open</Nav>, and picking it opens another.{" "}
              <Nav>New</Nav> beside the <Nav>Hosts</Nav> heading takes you to the
              form for adding a host.
            </li>
            <li>
              Rename a local shell tab with the <Nav>pencil</Nav> on the tab:
              type a name and press <Nav>Enter</Nav> (or <Nav>Esc</Nav> to
              cancel). An empty name puts the shell's own name back. The new
              name lasts until you close Broadside.
            </li>
            <li>
              A second tab on the same shell or host is numbered:{" "}
              <Nav>PowerShell</Nav>, then <Nav>PowerShell 02</Nav>,{" "}
              <Nav>PowerShell 03</Nav>. Moving tabs around never changes the
              numbers.
            </li>
          </Bullets>
          <H3>Serial consoles (COM ports)</H3>
          <Bullets>
            <li>
              The <Nav>plus button</Nav> menu lists this PC's COM ports under{" "}
              <Nav>Serial console</Nav>. Picking one opens the console cable as
              an ordinary terminal tab, beside your SSH sessions. Where Windows
              knows the adapter's product name, it is shown under the port.
            </li>
            <li>
              The box beside each port is the <Nav>line speed</Nav> (baud). It
              starts at <Nav>9600</Nav>, the usual console speed; if your device
              wants another, such as <Nav>115200</Nav>, its documentation will
              say. The speed you use is remembered for that port.
            </li>
            <li>
              A new serial tab stays empty until the device says something.
              Press <Nav>Enter</Nav> to bring up its prompt. If you get garbage
              instead of text, the speed is probably wrong; it is shown on the
              tab (<Nav>COM3 @ 9600</Nav>).
            </li>
            <li>
              A COM port can be open in only one program at a time. If another
              program (PuTTY, Tera Term) has it, close that one and press{" "}
              <Nav>Try again</Nav>.
            </li>
            <li>
              <Nav>How many</Nav> does not apply to serial ports, and resizing
              the pane does not tell the device its new size.
            </li>
            <li>
              Serial tabs can be broadcast to from{" "}
              <SectionLink id="help-sec-ptybroadcast">
                PTY Broadcast
              </SectionLink>{" "}
              and the <Nav>Broadcast</Nav> rail. Every serial send asks for
              confirmation first.
            </li>
          </Bullets>
          <H3>How local shells are detected (important)</H3>
          <Bullets>
            <li>
              Broadside finds shells through your Windows PATH, so it does not
              matter where they are installed as long as the installer added them
              to PATH. A shell that is not on PATH (an unzipped portable copy, for
              example) will not appear in the list.
            </li>
            <li>
              Broadside reads PATH when it starts. If you install a new shell
              while the app is already running, restart Broadside for it to
              show up in the launcher.
            </li>
            <li>
              Hide shells you do not use in <Nav>Settings</Nav> under{" "}
              <Nav>Appearance</Nav>.
            </li>
          </Bullets>
          <H3>Your own terminal applications</H3>
          <Bullets>
            <li>
              Detection only finds the shells Broadside knows how to look for.
              For anything else, such as <Nav>Git Bash</Nav>, MSYS2 or Cygwin,
              open <Nav>Settings</Nav> and the <Nav>Custom terminals</Nav>{" "}
              section and add it yourself. <Nav>Add Git Bash</Nav> fills in the
              usual path and options for you.
            </li>
            <li>
              Give it a name (used in the launcher and as the tab title), the
              full path to the program (<Nav>Browse</Nav> finds it), any
              arguments it needs, and which command language it speaks. For Git
              Bash, the arguments <code>--login -i</code> give you its familiar
              coloured prompt and the full set of Unix tools.
            </li>
            <li>
              The program must be a full path to a real <code>.exe</code>;
              Broadside checks this when you save.
            </li>
            <li>
              The command language decides which <Nav>PTY Broadcast</Nav> tab
              the terminal joins, so a broadcast command always suits every
              shell it reaches. A Bash-like (<Term term="posix" />) terminal
              joins the <Nav>WSL / POSIX</Nav> tab.
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
              A host's tabs and grid tiles wear the host's colour. Local tabs are
              coloured by the kind of shell (one colour each for PowerShell,
              Command Prompt, WSL, Bash-like terminals and serial), so you can
              see at a glance which command language you are about to type in.
              Change them, or set any to <Nav>None</Nav>, in{" "}
              <Nav>Settings</Nav> under <Nav>Custom terminals</Nav>;{" "}
              <Nav>Defaults</Nav> puts them all back.
            </li>
            <li>
              A <b>profile</b> can have its own colour, picked when you create
              it, so two profiles on the same shell can be told apart. Left
              alone, it uses its shell's colour.
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
              <Nav>New</Nav> opens a short form: a name (which becomes the tab
              label), the shell, a <Nav>Working directory</Nav> (type it or use{" "}
              <Nav>Browse</Nav>; leave it empty to start in your home folder), an
              optional <Nav>Startup command</Nav> and an optional{" "}
              <Nav>Tab colour</Nav>.
            </li>
            <li>
              Launching a profile opens the shell in that folder and, once the
              prompt appears, types the startup command and presses Enter for
              you. For example, a profile can open PowerShell 7 in a project
              folder and start a command-line tool there in one click.
            </li>
            <li>
              Profiles honour the <Nav>How many</Nav> count. A profile with a
              startup command asks before opening more than one copy, since each
              copy runs the command again.
            </li>
            <li>
              Hover a profile in the launcher for <Nav>edit</Nav>,{" "}
              <Nav>duplicate</Nav> and <Nav>delete</Nav>. <Nav>Duplicate</Nav>{" "}
              puts a <Nav>(copy)</Nav> just below the original, which is the
              quick way to make profiles that differ by one setting.{" "}
              <Nav>Delete</Nav> needs a double-click and then a confirmation, so
              a stray click cannot remove one. Terminals already opened from a
              deleted profile keep running.
            </li>
            <li>
              Drag a profile by the grip at the left of its row to change its
              place in the list.
            </li>
            <li>
              <b>The Hosts tab has a fuller list.</b> Set the{" "}
              <Nav>Hosts</Nav> | <Nav>Templates</Nav> | <Nav>Profiles</Nav>{" "}
              switch at the top of the <Nav>Hosts</Nav> tab to{" "}
              <Nav>Profiles</Nav> for a table that shows each profile's folder
              and startup command. Everything the launcher does works there too,
              and you can also export a single profile, or just the ones you
              tick. The terminal button on a row opens that profile, and{" "}
              <Nav>Multi-profile</Nav> opens every ticked one, each in its own
              tab. The columns can be moved, resized and hidden like the Hosts
              table's (hide them in <Nav>Settings</Nav> &rarr;{" "}
              <Nav>Appearance</Nav>).
            </li>
            <li>
              <Nav>Export</Nav> saves all your profiles to a file, to carry them
              to another PC. <Nav>Import</Nav> shows every profile in a file,
              including its startup command in full, before anything is saved.{" "}
              <b>Read those commands</b>: a startup command runs every time the
              profile opens, so only import a file you trust. A profile whose
              name you already use comes in as a numbered copy.
            </li>
            <li>
              A profile whose shell is not on this PC (a removed WSL
              distribution, or a custom terminal you do not have) is shown struck
              through and will not launch. Hover it to see which shell it wants.
              Once you add that shell, <Nav>Edit</Nav> on the profile has it
              already picked, and you just save.
            </li>
            <li>
              Profiles never store passwords or keys. They are kept by{" "}
              <Nav>Settings → Reset everything</Nav> and included in backups. A
              restore brings them back with their startup commands empty, so
              type those again afterwards.
            </li>
          </Bullets>
          <H3>How long a session stays open</H3>
          <Bullets>
            <li>
              <Nav>Settings → Sessions → Keep alive</Nav> stops a firewall or
              router quietly dropping a connection you have left idle. It is on
              by default and applies to connections opened after you change it.
            </li>
            <li>
              <Nav>Settings → Sessions → Session timeout</Nav> closes an SSH
              terminal that has been idle for the time you set. It is{" "}
              <strong className="font-semibold">off</strong> by default. Idle
              means nothing typed, nothing printed and no command running, so a
              long quiet command, an editor, <code>tmux</code> or{" "}
              <code>screen</code> keeps the session open; a job left running in
              the background does not. On a very basic shell (a plain{" "}
              <code>sh</code>, or a device's own menu) Broadside cannot tell
              whether a command is running, so only silence counts.
            </li>
            <li>
              A pane closed by the timeout keeps its output, says the timeout
              closed it, and offers <Nav>Reconnect</Nav>. Local shells and
              serial consoles are never timed out.
            </li>
          </Bullets>
          <H3>Working with tabs</H3>
          <Bullets>
            <li>Drag tabs to reorder them. Reordering never disconnects a session.</li>
            <li>
              A remote tab whose connection is down (still connecting, dropped or
              failed) shows its label in <span className="font-medium text-red-600 dark:text-red-400">red</span>; use{" "}
              <Nav>Reconnect</Nav> to bring it back. Local shell tabs never show
              this.
            </li>
            <li>
              A pane that is opening shows <Nav>Connecting</Nav>. If that takes
              more than a few seconds, a second line says whether the wait is on
              the network or on the host.
            </li>
            <li>
              <Nav>Alt+Right</Nav> and <Nav>Alt+Left</Nav> switch to the next
              and previous tab, even while you are typing in a terminal. To reach
              the tabs without a mouse, <Nav>Tab</Nav> into the tab strip, move
              along it with <Nav>Left</Nav> and <Nav>Right</Nav>, and press{" "}
              <Nav>Enter</Nav> to choose one.
            </li>
            <li>
              Maximize a single terminal to fill the window (also{" "}
              <Nav>F11</Nav>). Close one tab with its <Nav>x</Nav>, or all of
              them with <Nav>Close all</Nav> in the <Nav>Sessions</Nav> menu.
            </li>
          </Bullets>
          <H3>Grid view</H3>
          <Bullets>
            <li>
              The <Nav>Tabs</Nav> / <Nav>Grid</Nav> toggle above the tab strip
              switches between one terminal at a time and every terminal tiled
              at once. Tiles follow the order of the tabs and resize with the
              window. When there are too many to read comfortably, they keep a
              readable size and the grid scrolls. Each tile has its own maximize
              and close buttons.
            </li>
            <li>
              <b>In Grid, the tile under the mouse is the active one.</b> It is
              outlined in its host's colour, and it gets whatever you type,
              paste, search for or run from the shortcut menu. Passing over a
              tile does not select it; the pointer has to rest there for a
              moment (a click selects it straight away). Choosing a tab, using{" "}
              <Nav>Alt+Left</Nav> / <Nav>Alt+Right</Nav> or picking from{" "}
              <Nav>Sessions</Nav> selects a tile until you move the mouse onto a
              different one. While another app is in front, the mouse does not
              change the active tile; click a tile to come back to Broadside.
            </li>
            <li>
              <b>Short of room?</b> <Nav>Ctrl+Shift+G</Nav> gives the grid the
              whole screen (see below). <Nav>Grid Titles</Nav> (the eye) hides
              every tile's title bar. The grid button on a tab takes that
              terminal out of the grid without closing it (the button turns
              amber; click it again, or <Nav>Unhide all</Nav> in the{" "}
              <Nav>Sessions</Nav> menu, to bring it back). <Nav>F11</Nav> gives
              one terminal the whole window.
            </li>
            <li>
              <Nav>Fullscreen</Nav> (<Nav>Ctrl+Shift+G</Nav>) gives the grid the
              whole screen. The toolbar, tabs, sidebar and status bar slide away
              behind a small tab in the middle of the top edge; hover or click
              that tab to bring them back, and they hide again once you have used
              one. <Nav>Ctrl+Shift+T</Nav> also brings them down and moves the
              keyboard into them: <Nav>Tab</Nav> moves between controls and{" "}
              <Nav>Esc</Nav> goes back to the terminal. Press{" "}
              <Nav>Ctrl+Shift+G</Nav> again to leave (closing the last terminal
              also leaves). <Nav>Esc</Nav> does not leave fullscreen, so it
              still reaches programs such as <code>vi</code>.
            </li>
            <li>
              Drag the right or bottom edge of a tile (or its corner) to resize{" "}
              <strong className="font-semibold">every</strong> tile at once. A
              dragged size is forgotten when Broadside closes, unless you untick{" "}
              <Nav>Strict</Nav> in <Nav>Settings → Grid</Nav>, which saves it.{" "}
              <Nav>Reset grid</Nav> goes back to tiles that fit the window.
            </li>
            <li>
              To fix the layout, open <Nav>Settings → Grid</Nav>. Leave
              everything on <Nav>Auto</Nav>, or set <Nav>Columns across</Nav>{" "}
              and the tile <Nav>Item width</Nav> / <Nav>Item height</Nav> in
              characters. Tiles too wide for the window scroll sideways rather
              than shrink. One or two terminals always fill the space whatever
              these say, and a column count larger than the number of open
              terminals is reduced to fit. Changes apply the next time you open
              the Terminals page. The{" "}
              <SectionLink id="help-sec-templates">Templates</SectionLink>{" "}
              editor uses the same settings.
            </li>
            <li>
              The collapsed <Nav>Advanced</Nav> part of{" "}
              <Nav>Settings → Grid</Nav> sets the number a field starts at when
              you untick its <Nav>Auto</Nav> (3 columns and 80x24 unless you
              change it).
            </li>
            <li>
              <Nav>Short last row</Nav> in <Nav>Settings → Grid</Nav> decides
              what happens when the terminals do not fill the last row:{" "}
              <strong className="font-semibold">Stretch the row</strong> (the
              default) widens the tiles on it,{" "}
              <strong className="font-semibold">
                Tall tile in the last column
              </strong>{" "}
              grows the tile above the gap down into it, and{" "}
              <strong className="font-semibold">Leave the gap</strong> keeps
              every tile the same size. A width or height you have set yourself
              always wins, and the gap stays.
            </li>
          </Bullets>
          <H3>The broadcast rail</H3>
          <Bullets>
            <li>
              The <Nav>Broadcast</Nav> button opens a rail down the left side:
              pick a shell language, tick the sessions you want, type a command
              at the bottom, and it is typed into all of them at once. Pair it
              with <Nav>Grid</Nav> to watch them all answer.
            </li>
            <li>
              It works on one shell language at a time, so a command always
              suits every session it reaches. The safety checks are the same as
              on the <Nav>PTY Broadcast</Nav> tab: a destructive command asks
              before going to SSH hosts, and every local-shell send is
              confirmed.
            </li>
            <li>
              <Nav>Up</Nav> and <Nav>Down</Nav> recall commands sent from any of
              the broadcast pages. <Nav>Clear history</Nav> clears the recall on
              this rail only, and the{" "}
              <SectionLink id="help-sec-logs">Logs</SectionLink> record is left
              as it was.
            </li>
            <li>
              A disconnected session stays in the list in red, but cannot be
              ticked until you reconnect it.
            </li>
          </Bullets>
          <H3>Copy, paste and find</H3>
          <Bullets>
            <li>
              <strong className="font-semibold">Copy</strong> by selecting text
              and right-clicking, or with <Nav>Ctrl+Shift+C</Nav>. Selecting on
              its own copies nothing. Double-click selects a word and
              triple-click a line. In a program that uses the mouse itself (tmux
              or vim with the mouse on), hold <Nav>Shift</Nav> while you drag.
            </li>
            <li>
              <strong className="font-semibold">Paste</strong> with a{" "}
              <Nav>right-click</Nav> when nothing is selected, or with{" "}
              <Nav>Ctrl+Shift+V</Nav>. Plain <Nav>Ctrl+C</Nav> and{" "}
              <Nav>Ctrl+V</Nav> go to the shell as usual, so Ctrl+C still stops a
              running command. In Grid, a paste goes to the outlined tile. A
              toast confirms each copy and paste, and says how many lines a
              multi-line paste contained.
            </li>
            <li>
              <strong className="font-semibold">Find</strong> with{" "}
              <Nav>Ctrl+F</Nav>. Matches are highlighted and counted (
              <Nav>3 of 17</Nav>); the arrows, or <Nav>Enter</Nav> and{" "}
              <Nav>Shift+Enter</Nav>, move between them. The toggles beside the
              box are regular expression, match case and whole word.{" "}
              <Nav>Esc</Nav> closes the bar.
            </li>
            <li>
              <strong className="font-semibold">Text too small?</strong> Hold{" "}
              <Nav>Ctrl</Nav> and turn the mouse wheel over a terminal to zoom
              every terminal in or out. The size is saved in{" "}
              <Nav>Settings</Nav> under <Nav>Appearance</Nav>. If a program you
              use needs Ctrl and the wheel for itself, tick <Nav>Strict</Nav>{" "}
              beside the terminal font size there to turn the zoom off.
            </li>
            <li>
              <strong className="font-semibold">Scrollback</strong> is 5,000
              lines per pane by default, and older lines are dropped. Change it
              with <Nav>Terminal scrollback</Nav> in <Nav>Settings</Nav> under{" "}
              <Nav>Appearance</Nav>. More lines use more memory (5,000 is about
              12 MB per pane), and lowering it drops lines above the new limit
              straight away.
            </li>
            <li>
              Every key Broadside takes is listed in{" "}
              <SectionLink id="help-sec-shortcuts">
                Keyboard shortcuts
              </SectionLink>
              .
            </li>
          </Bullets>
          <H3>The Sessions and View menus</H3>
          <Bullets>
            <li>
              <Nav>Sessions</Nav>, at the top right, lists every terminal: pick
              one to jump to it. It also holds the bulk actions, each shown only
              when there is something for it to do: <Nav>Reconnect all</Nav> and{" "}
              <Nav>Close failed</Nav> for panes whose connection failed or
              dropped, <Nav>Disconnect all</Nav> to end every session but keep
              the tabs, <Nav>Unhide all</Nav>, <Nav>Close others</Nav> and{" "}
              <Nav>Close all</Nav>.
            </li>
            <li>
              The small unplug button on each row of the <Nav>Sessions</Nav>{" "}
              menu ends that one session but keeps its tab and output, as if you
              had typed <code>exit</code>. The pane then offers{" "}
              <Nav>Reconnect</Nav>.
            </li>
            <li>
              Right-click a tab for the same actions as its icons, plus{" "}
              <Nav>Open another session</Nav> (a new session on the same host or
              shell, placed next to it) and <Nav>Close others</Nav>. When the
              other tabs are of mixed kinds you also get entries such as{" "}
              <Nav>Close other SSH</Nav> or{" "}
              <Nav>Close other Command Prompts</Nav>. Tabs hidden by the{" "}
              <Nav>Filter</Nav> are never closed this way.
            </li>
            <li>
              <b>Confirmations.</b> Bulk actions ask first when they would
              affect more than five sessions. Change that number (1 to 11) with{" "}
              <Nav>Ask before acting on more than</Nav> in <Nav>Settings</Nav>{" "}
              under <Nav>Performance</Nav>. <Nav>Close all</Nav> always asks,{" "}
              <Nav>Close others</Nav> asks whenever it would close two or more,
              and a profile with a startup command asks before opening more than
              one copy.
            </li>
            <li>
              After a reconnect, the old session's output stays in the
              scrollback above a line showing when it ended, and the new session
              starts on a clean screen.
            </li>
            <li>
              The <Nav>View</Nav> menu holds the display options: fullscreen,{" "}
              <Nav>Full tab labels</Nav>, <Nav>Tab bar</Nav>, <Nav>Filter</Nav>,
              flipping two terminals between side by side and stacked,{" "}
              <Nav>Reset grid</Nav> and <Nav>Reset display</Nav>. An entry that
              cannot be used right now is greyed; hover it and the status bar
              says why.
            </li>
            <li>
              <Nav>View</Nav> &gt; <Nav>Filter</Nav> shows or hides whole kinds
              of session (SSH, each local shell, serial consoles). Hidden
              sessions keep running, <Nav>Alt+Left</Nav> / <Nav>Alt+Right</Nav>{" "}
              skip them, and the <Nav>View</Nav> button is marked while anything
              is hidden. A kind comes back by itself when you open or jump to one
              of its sessions, and every kind is shown again when Broadside
              restarts.
            </li>
            <li>
              <Nav>View</Nav> &gt; <Nav>Tab bar</Nav> (Grid only) hides the tab
              strip to give its row to the tiles. The strip always comes back
              in <Nav>Tabs</Nav> view.
            </li>
          </Bullets>
          <H3>Full-screen prompts, and a stuck one</H3>
          <p>
            Box-drawing prompts, such as the questions an upgrade asks, work as
            normal: arrow keys, <Nav>Tab</Nav> and <Nav>Enter</Nav> all reach
            them.
          </p>
          <p>
            If one ignores your keys and they show up as <code>^[[A</code> or{" "}
            <code>^[</code> instead, the prompt was started by a script rather
            than from your terminal and cannot hear you. Press{" "}
            <Nav>Ctrl+C</Nav>, then run the command yourself, or put{" "}
            <code>DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a</code> in
            front of an <code>apt</code> command so those prompts do not appear
            at all.
          </p>
          <p>
            <Nav>Reset display</Nav>, in the <Nav>View</Nav> menu, clears a
            garbled pane (including its scrollback) and redraws the prompt. It
            never interrupts a running command; if one is still going, the pane
            stays blank until it finishes. In a <Nav>Command Prompt</Nav> tab,
            press <Nav>Enter</Nav> afterwards for a fresh prompt.
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
              The dropdown only offers shortcuts that suit the current tab, so a
              Linux command is never offered in a Windows shell. WSL tabs use the
              Linux ones.
            </li>
            <li>
              Serial tabs only get <Nav>Serial console</Nav> shortcuts (
              <Nav>Both</Nav> does not include them), and none come built in,
              since every device is different. Add your own with{" "}
              <Nav>Manage shortcuts…</Nav> in the dropdown, or in{" "}
              <Nav>Settings</Nav> under Shortcut commands.
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
      "broadcast many hosts one command exec non-interactive output history autoscroll headers timeout guard destructive parallel concurrency rail filter tag label search find select all sort collapse go to terminal icon on every rail row end of the row past the connection dot open new connection tab always opens a new one even if already open not a jump no icon on the block header any more collapsed rail initials icon only on hover appears when pointer on the row hidden until hovered hover a result block lights highlights the host row in the rail two way link collapsed tooltip leads with the label name first then address and tags",
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
            <li>
              Hover a host in the rail for a <Nav>terminal</Nav> icon that opens
              a new terminal to that host. Hover a block of output and the host
              it came from lights up in the rail.
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
              matches host labels as you type, and a <Nav>Filter tags</Nav>{" "}
              dropdown that works like the tag filter on the{" "}
              <SectionLink id="help-sec-hosts">Hosts</SectionLink> table. The two
              combine, and both reset when you restart the app.
            </li>
            <li>
              A host the filter hides is also unticked, and stays unticked when
              you clear the filter, so a hidden host can never be swept into a
              broadcast. <Nav>Select all</Nav> only picks visible hosts. The same
              rail filter is on{" "}
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
      "pty broadcast type every open terminal interactive live shells mirror keystrokes difference rail filter tag label search select all tabs ssh powershell command prompt cmd wsl local fan out danger banner confirm carriage return serial console com port switches routers several consoles at once fifth tab go to terminal icon on every rail row end of the row past the connection dot jump switch select that exact tab per session not per host works on dropped and exited rows too no icon on the dispatch report rows any more collapsed rail initials icon only on hover appears when pointer on the row hidden until hovered hover a dispatch report row lights highlights that session in the rail reloaded run lights nothing collapsed tooltip leads with the label and the 02 number",
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
              It types into real shells exactly as if you typed in each tab, so
              there is no completion signal and no time limit. Use{" "}
              <Nav>Broadcast</Nav> for one-shot commands that return a result,
              and <Nav>PTY Broadcast</Nav> for interactive ones.
            </li>
          </Bullets>
          <H3>One tab per shell language</H3>
          <Bullets>
            <li>
              The page is split into fixed tabs: <Nav>SSH</Nav>,{" "}
              <Nav>PowerShell</Nav>, <Nav>Command Prompt</Nav>, <Nav>WSL</Nav>{" "}
              and <Nav>Serial consoles</Nav>. Each open terminal shows up under
              its own tab, so a single command is always valid for the shells it
              reaches. A small count on each tab shows how many of that kind are
              open.
            </li>
            <li>
              Take most care on <Nav>Serial consoles</Nav>: a line typed there
              goes into several pieces of network hardware at once, with no
              undo. Every send outside the <Nav>SSH</Nav> tab asks first.
            </li>
            <li>
              The <Nav>SSH</Nav> tab has the same <Nav>Find by label…</Nav> box
              and <Nav>Filter tags</Nav> dropdown as{" "}
              <SectionLink id="help-sec-broadcast">Broadcast</SectionLink>, and
              keeps a history of past runs.
            </li>
            <li>
              A session that has disconnected, or a local shell that has exited,
              stays in the rail with a red dot but cannot be ticked.
            </li>
            <li>
              Hover a row in the rail for a <Nav>terminal</Nav> icon that takes
              you to that exact tab on <Nav>Terminals</Nav>. Hover a row of the
              run report and its session lights up in the rail.
            </li>
            <li>
              <Nav>Up</Nav> and <Nav>Down</Nav> recall commands sent from any of
              the broadcast pages. <Nav>Clear command history</Nav> clears the
              recall on this page only; the{" "}
              <SectionLink id="help-sec-logs">Logs</SectionLink> record is left
              as it was.
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
              The report for local runs is cleared when you close Broadside.
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
      "multiterminal aggregate combined output color tint per host block log delete two open compare rail select clear results command history close all headers collapse copy jump mirror show manual activity typed layers icon indicator marker recorded composer filter tag label search find selectable connected go to terminal icon moved off the block header onto the rail row end of row past the connection dot per session not per host second session 02 which tab does it open icon only on hover appears when pointer on the row hidden until hovered hover a block lights highlights the session that produced it in the rail which of the two web-01 rows was that reloaded block lights nothing collapsed tooltip leads with the label and the 02 number",
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
              a command in the composer, and send. The rail collapses to color
              dots with the arrow button.
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
              Two sessions on the same host are listed separately and numbered
              the way their tabs are (<code>web-01</code>,{" "}
              <code>web-01 02</code>). A note above the composer tells you when
              two of the sessions you have ticked are on the same machine.
            </li>
            <li>
              Turn on <Nav>Show Manual Activity</Nav> to also capture commands you
              type by hand in a <Nav>Terminals</Nav> tab, for the hosts ticked in
              the rail. While it is on, those tabs show a small{" "}
              <Nav>layers</Nav> icon so you know they are being recorded.
            </li>
          </Bullets>
          <H3>Block headers</H3>
          <Bullets>
            <li>
              With <Nav>Headers</Nav> on, each block has a header you can click to
              collapse or expand its output. Hover the header for a{" "}
              <Nav>copy</Nav> icon, which copies that block's output.
            </li>
            <li>
              With <Nav>Headers</Nav> off, blocks show output only, with no header
              to collapse or copy from.
            </li>
            <li>
              Hover a block and the session that produced it lights up in the
              rail. Hover that row for a <Nav>terminal</Nav> icon that takes you
              to its tab.
            </li>
          </Bullets>
          <H3>Rail actions</H3>
          <Bullets>
            <li>
              <Nav>Clear results</Nav> empties the block log (and the saved
              history). <Nav>Clear command history</Nav> clears the Up/Down
              recall on this page only. <Nav>Close all terminals</Nav> closes
              every open terminal after a confirmation.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: HELP_SKILLS,
    title: "Skills",
    keywords:
      "skill skills sequence step steps run expect send wait pattern regex branch ok fail match no match stop next start at renumber interactive timeout pause flow map diagram overview orphan loop transfer handoff to terminal root inputs parameters placeholder import export json reorder move up down builder editor pencil go to a step on timeout goto recovery retry jump timeout branch clone copy duplicate variant collapse expand fold steps step log narration progress which step of how many repeat cap runaway loop limit stop after runs times post to skill log log step note warning error message cancelled itself reason why self documenting rerun run again repeat run active step highlight tint selected scroll to new step infinite loop unlimited no cap forever never ends dangerous run until stopped jump go to step button follow branch scroll to target orange tint skill file version newer broadside cannot import older app unknown variant malformed take over takeover give me the keyboard type into a running host let me drive interrupt a skill mid run step in manually cannot type nothing happens when i type keyboard locked pause it now after this step waiting printf bsdone marker junk after my command what is that ugly line completion marker hidden quiet shell integration echo off stty clean pane blink flicker flash stty -echo appears briefly narrow pane long prompt leftover fragment status dot colour legend key what do the colours mean green dark green amber red grey online offline reachable port check probe is this host up before i run sort online first collapse the rail hide the sidebar more room expand button pin a skill dropdown pinned card frozen top of the list favourite most used skill green tint highlight moved to another skill which one am i working on dropdown will not open first click does nothing two clicks to open the pinned list missing from the list disappeared from the list where did my skill go cannot move the pinned skill arrows greyed double click to pin double clicking a skill quicker way to pin pinning shows the flow flow does not follow the dropdown outline left behind highlight on the wrong skill ring stuck on a row nothing selected but still highlighted save and close save cancel discard unsaved changes stay in the editor keep editing first save creates it",
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
              log and carries on. It does nothing on the host.
            </li>
          </Bullets>
          <H3>A skill that explains itself</H3>
          <p>
            <Nav>Post to the skill log</Nav> lets a skill record which way it
            went, for example <em>already on the current kernel, nothing to
            do</em>. Pick a <Nav>Log type</Nav> (<Nav>Note</Nav>,{" "}
            <Nav>Warning</Nav> or <Nav>Error</Nav>), write the message (inputs
            work here), and say where to go next.
          </p>
          <p>
            An <Nav>Error</Nav> whose <Nav>Then</Nav> is <Nav>stop</Nav> ends
            that host as a <span className="font-medium">failure</span> with your
            message, which is how a skill turns a host away in its own words. An{" "}
            <Nav>Error</Nav> that goes anywhere else is only logged, and the
            skill carries on.
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
            You can instead choose to fail (which ends the host for a{" "}
            <Nav>Wait for output</Nav> step, or takes the{" "}
            <Nav>if it fails</Nav> branch for a <Nav>Run a command</Nav> step),
            or <Nav>go to a step</Nav> of your choosing, such as a retry or a
            recovery path.
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
              Amber warnings above the diagram point out a step nothing leads
              to, which will never run, and a loop with no way out, which will
              hit the repeat limit and fail the host. Loops are drawn as dashed
              amber arrows running back up the left. Warnings never stop you
              saving.
            </li>
          </Bullets>
          <H3>Runaway loops</H3>
          <p>
            A step that loops back is a fine way to wait until something is
            ready, so Broadside limits loops rather than forbidding them.{" "}
            <Nav>Stop a host after a step runs N times</Nav> in the editor sets
            how many times any one step may run on a host (100 by default, which
            is also the maximum).
          </p>
          <p>
            <Nav>Let steps repeat without limit</Nav> removes the limit, and it
            is{" "}
            <span className="font-semibold">
              dangerous: use it only if you truly know what you are doing
            </span>
            . A skill that loops then runs until you stop it with{" "}
            <Nav>Stop host</Nav> or <Nav>Emergency stop</Nav>, repeating
            whatever it does (writing files, installing things) on every pass.
            It is off by default, and the flow map and the run confirmation both
            warn you when it is on.
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
              <b>Taking a host over.</b> While a skill is running, typing into
              its pane does nothing. Press <Nav>Take over</Nav> in the pane's
              header: the skill finishes the step it is on (the button reads{" "}
              <Nav>After this step…</Nav> meanwhile) and then hands you the
              shell. The other hosts carry on.
            </li>
            <li>
              When you are done, <Nav>Resume</Nav> hands the host back to the
              skill at the next step, or <Nav>Stop host</Nav> ends it. Anything
              you left half-typed is cleared first.
            </li>
            <li>
              A host that pauses <em>on its own</em>, because a step timed out,
              offers the same choices plus <Nav>Skip step</Nav>, which treats
              that step as done and carries on.
            </li>
            <li>
              Each pane's header names the current step, with its countdown.{" "}
              <Nav>Log</Nav> in the header shows what the skill decided for that
              host: each step, what matched, what was sent, what timed out and
              which branch it took.
            </li>
            <li>
              <Nav>Rerun</Nav>, beside <Nav>Close run</Nav>, closes the finished
              run and takes you back to the confirmation to start it again.
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
              Steps in the editor fold down to one line each; click a step to
              open it, or use <Nav>Expand all</Nav>. The step you last clicked
              is tinted, so you can follow it as you move it with the arrows.
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
            <li>
              <Nav>Save</Nav> saves and keeps you in the editor;{" "}
              <Nav>Save and close</Nav> does both. <Nav>Cancel</Nav> leaves
              without saving, and asks first if there are unsaved changes.
            </li>
          </Bullets>
          <H3>The rail</H3>
          <Bullets>
            <li>
              Each host has a status dot, with a key to the colours under the
              list. <strong className="font-semibold">Green</strong>: a terminal
              is open to it. <strong className="font-semibold">Dark green</strong>
              : its SSH port answered the last check.{" "}
              <strong className="font-semibold">Amber</strong>: it did not.{" "}
              <strong className="font-semibold">Red</strong>: not being checked
              (no terminal open, and checking is turned off for it on the Hosts
              page). <strong className="font-semibold">Grey</strong>: no answer
              yet. Hosts are checked every 15 seconds while this page is open.
            </li>
            <li>
              <Nav>Sort: Online first</Nav> puts the hosts you can use right now
              at the top: those with a terminal open first, then those that
              answered.
            </li>
            <li>
              The panel icon at the top of the rail collapses it, to give the
              editor more room.
            </li>
          </Bullets>
          <H3>Organising them</H3>
          <Bullets>
            <li>
              The arrows on each skill in the rail move it up and down the list.
              The order is yours and it is remembered.
            </li>
            <li>
              The card above the list pins one skill to the top of the rail, so
              the one you use most is always in reach. Choose it from the
              dropdown in the card's title, or double-click a skill in the list.
              Pinning a skill opens its flow map, and the branching icon on the
              card brings the map back later. A pinned skill is not repeated in
              the list below.
            </li>
            <li>
              A faint green tint marks the skill shown on the right.
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
              A skill that uses newer features cannot be imported into an older
              version of Broadside; the message says it was{" "}
              <em>made by a newer Broadside</em>. Update the copy you are
              importing into.
            </li>
          </Bullets>
          <H3>What a skill needs from the host</H3>
          <p>
            Skills need a <Nav>bash</Nav>, <Nav>zsh</Nav> or <Nav>sh</Nav> login
            shell. A host with any other shell carries an amber chip on the{" "}
            <SectionLink id="help-sec-hosts">Hosts</SectionLink> tab and in the
            list here. It can still be ticked, but it reports a failure when the
            run starts, and the skill carries on with the other hosts.
          </p>
          <H3>What you see in the pane</H3>
          <p>
            The pane shows your commands as you wrote them and what the host
            printed. On some hosts you may also see a <code>printf</code> added
            to each command and a line like <code>__bsdone_0__</code> under it.
            That is harmless: it is how Broadside tells when a command has
            finished on a shell it cannot follow otherwise (one that is not bash
            or zsh, a host with shell integration set to <Nav>never</Nav>, or a
            nested shell).
          </p>
          <H3>What a run leaves behind</H3>
          <p>
            Out of the box, in <Nav>Logs</Nav> &rarr; <Nav>Skills</Nav>: one
            entry per host per run, with the exit codes and the timings, and as
            much of the step-by-step as you ask for. Your host's own shell
            history is left alone, because Broadside asks each shell it opens to
            stop recording for the duration.
          </p>
          <p>
            If you would rather the commands stayed in the host's history, where
            an <Nav>Up</Nav> arrow finds them, that is{" "}
            <Nav>Settings</Nav> &rarr; <Nav>Skills</Nav> &rarr;{" "}
            <Nav>Where to log</Nav>. You can have either or both.
          </p>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-sftp",
    title: "SFTP",
    keywords:
      "sftp file transfer browse upload download put get commander dual two pane local remote folder directory navigate drag drop delete recycle bin make folder clash mode overwrite all newer only skip existing broadcast multi-host per-host progress bar create path confirm host key tofu concurrency queue tab remember multi-select ctrl shift click range select many files group wildcard glob star pattern match asterisk parallel several at once simultaneous four cancel one cancel all stacked bars stack how many waiting queued slow download speed up faster distant host latency round trip partial file part written stopped mid transfer deleted removed cleaned up half file truncated corrupt incomplete leftover status bar still going other tab in progress spinner scanning scan cancel scan large transfer dialog 100 files 100 mb asks before summary one message toast covering cancel button empty folder left behind kept finished files rename f2 pencil double click open enter backspace up arrow keys single click select skipped single file still uploaded overwrote anyway skip existing ignored slow even though it exists already there not newer open terminal from sftp go to terminal ssh into this host shell button",
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
              Click an item to select it; double-click a folder, or press{" "}
              <Nav>Enter</Nav>, to open it. <Nav>Backspace</Nav> goes up a folder
              and the arrow keys move the selection.
            </li>
            <li>
              Transfer by dragging an item from one side to the other. Folders copy
              recursively, with a progress bar and a running byte count.
            </li>
            <li>
              Select several items as in Windows Explorer (<Nav>Ctrl+click</Nav>{" "}
              for individual files, <Nav>Shift+click</Nav> for a range), then drag
              any of them to transfer the whole selection.
            </li>
            <li>
              Up to four transfer at a time and the rest wait. Each running
              transfer, and each folder still being scanned, gets a row in the bar
              along the bottom with its own <Nav>Cancel</Nav>;{" "}
              <Nav>Cancel all</Nav> also clears whatever is waiting.
            </li>
            <li>
              A folder over 100 files or 100 MB asks before it starts. Dragging
              several large folders asks about each one in turn.
            </li>
            <li>
              When everything in one drag has finished, a single message sums it
              up. Anything that failed or was cancelled gets its own message.
            </li>
            <li>
              Cancelling keeps the files that had already finished and deletes the
              one that was part-way through, along with any folder it left empty. A
              failed transfer does the same. A file that was being overwritten is
              not restored: cancelling leaves neither the old copy nor the new one.
              To keep files that are already there, set{" "}
              <Nav>When a file already exists</Nav> to <Nav>Skip existing</Nav>{" "}
              before you drag.
            </li>
            <li>
              Several at once helps most on a distant host; on your own network it
              is barely faster.
            </li>
            <li>
              You can make a new folder on either side, and rename or delete
              items. Local deletes go to the Windows <Nav>Recycle Bin</Nav> so
              they are recoverable. A remote folder must be empty before it can be
              deleted.
            </li>
            <li>
              Rename with the pencil on a row, or select it and press{" "}
              <Nav>F2</Nav>. A rename never replaces an item that already has the
              new name. On the host side, rename and delete are unavailable while
              a transfer is running.
            </li>
            <li>
              The terminal button beside <Nav>Disconnect</Nav> opens a new
              terminal to the connected host and takes you to the Terminals tab.
              The SFTP session stays open.
            </li>
          </Bullets>
          <H3>Broadcast (many hosts)</H3>
          <Bullets>
            <li>
              The <Nav>PUT / GET</Nav> toggle sets the direction: <Nav>PUT</Nav>{" "}
              sends one local file or folder to every selected host;{" "}
              <Nav>GET</Nav> pulls one remote path from every host into its own
              subfolder on your PC (one folder per host label, so files from
              different hosts never collide). Each host gets its own progress
              bar, and a few hosts transfer at a time while the rest wait their
              turn.
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
              Point at a host in the rail and a terminal button appears at the
              end of its row: it opens a new terminal to that host and takes you
              to the Terminals tab.
            </li>
            <li>
              <Nav>Create path if it doesn't exist</Nav> (PUT only) makes the
              destination directory on each host when it is missing; it is a
              session-only toggle that resets on restart.
            </li>
            <li>
              Hosts you have not connected to before are gathered into one{" "}
              <Nav>trust</Nav> dialog after the run (see <Term term="TOFU" />),
              and trusting them retries those hosts. A host whose key has{" "}
              <em>changed</em> is refused.
            </li>
          </Bullets>
          <H3>When a file already exists</H3>
          <p>
            The selector on the tab row applies to <em>both</em> tabs:{" "}
            <Nav>Overwrite all</Nav> always replaces, <Nav>Newer only</Nav>{" "}
            replaces only when the source is newer, and <Nav>Skip existing</Nav>{" "}
            leaves same-named files untouched. It applies to every transfer, a
            single file as well as each file in a folder, and is remembered
            across restarts. A file it leaves alone is not sent at all, and the
            summary message says it was skipped.
          </p>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-logs",
    title: "Logs",
    keywords:
      "logs saved sessions audit log command history search export json pretty print viewer skills skill log skill runs what did the skill do exit codes step log run panel toast history toasts history notification popup message disappeared too fast vanished what did that message say read it again missed the toast corner message restore warning after reload",
    body: (
      <>
        <Lead>
          The <Nav>Logs</Nav> tab is your record of what happened: saved terminal
          sessions, an audit log of security-relevant actions, your past
          commands, what your skill runs did, every toast the app has shown, and
          the errors.
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
            <li>
              <Nav>Skills</Nav> holds one entry per host per skill run: what ran,
              how it ended, and how long it took. How much detail each entry
              carries, whether entries are written at all, and whether they are
              shown as readable text or raw JSON are set in <Nav>Settings</Nav>{" "}
              &rarr; <Nav>Skills</Nav>. <Nav>Export</Nav> always writes JSON.
            </li>
            <li>
              <Nav>Toasts History</Nav> lists the last 500 toasts (the messages
              that pop up in the bottom corner), newest first, with the time and
              whether each was a success, a warning or an error. It is not
              affected by a restore and is not part of a backup.{" "}
              <Nav>Clear history</Nav> empties it and <Nav>Export</Nav> saves it
              to a file.
            </li>
          </Bullets>
        </Detail>
      </>
    ),
  },
  {
    id: "help-sec-settings",
    title: "Settings",
    keywords:
      "settings performance network probe destructive guard shortcut commands appearance theme columns column order drag reorder reset defaults chips drag a chip reorder from settings sessions session timeout idle keep alive keepalive backup restore csv hosts audit security admin lock reset jump search danger zone delete wipe all hosts credentials terminal font family dropdown list monospace fixed width installed fonts my font is missing cannot find my font nerd font cascadia consolas jetbrains fira code hack typeface change the font picker preview restart to see a new font applies instantly no save needed save font sizes button which settings need saving why is there a save button font applies as you pick it skills skill log where to log logging type output style remote history bash_history up arrow recall keep my history clean summary itemized run panel debug restore only a backup you made yourself trusted host keys not restored custom local shells not restored profile struck through after a restore profile lost its custom shell profile points at nothing which custom shell did it use name of the wanted shell remembered re-add the shell then edit has it chosen already backup from someone else untrusted backup file startup start page open on which tab first tab home greyed template holds startup panel table of contents left side section list highlight follows scroll jump to hidden narrow window profile table columns profiles columns hide shell folder startup command column restore warning disappeared too fast",
    body: (
      <>
        <Lead>
          <Nav>Settings</Nav> is where you tune how Broadside behaves. The list
          on the left jumps to each section, and the search box above it
          narrows the page to what you type.
        </Lead>
        <Detail>
          <H3>What you can change</H3>
          <Bullets>
            <li>
              <Nav>Startup</Nav>: which tab Broadside opens on (<Nav>Hosts</Nav>{" "}
              by default). It is greyed while a template is set to open at
              startup, because that always opens on <Nav>Terminals</Nav>.
            </li>
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
              <Nav>Shortcut commands</Nav>: reusable commands for the dropdown on
              the Terminals and Broadcast pages, each for Linux, Windows, both,
              or serial consoles. See{" "}
              <SectionLink id="help-sec-terminals">Terminals</SectionLink>.
            </li>
            <li>
              <Nav>Sessions</Nav>: the idle session timeout (off by default) and
              keep alive (on by default). See{" "}
              <SectionLink id="help-sec-terminals">Terminals</SectionLink>.
            </li>
            <li>
              <Nav>Appearance</Nav>: light or dark theme, the terminal font and
              its size, the size of the app's text, which columns the{" "}
              <Nav>Hosts</Nav> and <Nav>Profiles</Nav> tables show and in what
              order, and which local shells appear in the{" "}
              <Nav>plus button</Nav> menu. Changes apply as you make them,
              except the two font sizes, which need <Nav>Save font sizes</Nav>.
              <br />
              <b>A font missing from the list?</b> <Nav>Terminal font</Nav>{" "}
              only lists installed fixed-width fonts, because a terminal needs
              every character to be the same width. Look for a version with{" "}
              <i>Mono</i> in its name. A font installed while Broadside is
              running appears after a restart.
            </li>
            <li>
              <Nav>Skills</Nav>: what a skill run records, and where.
              <br />
              <b>Where to log</b>: <Nav>Skill log only</Nav> (recommended)
              records runs in <Nav>Logs</Nav> &rarr; <Nav>Skills</Nav> and keeps
              the commands out of each host's shell history.{" "}
              <Nav>Remote history only</Nav> leaves them in the host's history,
              where <Nav>Up</Nav> finds them, and records nothing here.{" "}
              <Nav>Both</Nav> does both.
              <br />
              <b>Logging type</b>: <Nav>Skill summary</Nav> (one entry per host
              per run), <Nav>Itemized</Nav> (adds a line per step with its exit
              code), <Nav>Run panel log</Nav> (the full step log as the run
              panel showed it) or <Nav>Debug</Nav> (adds exactly what was sent
              and what the host replied).
              <br />
              <b>Output style</b> only changes how entries are displayed, and
              applies to entries already recorded too.
            </li>
            <li>
              <Nav>Backup &amp; Restore</Nav>: save a copy of your app data, or
              restore from one. Backups contain your host list, settings, saved
              shell profiles, templates and skills but never your passwords or
              key passphrases (those stay in the{" "}
              <SectionLink id="help-sec-security">Security section</SectionLink>{" "}
              vault), so a backup file cannot leak a secret. Tick{" "}
              <Nav>Also include hosts CSV</Nav> to additionally write a plain
              spreadsheet of your hosts alongside the backup.
              <br />
              <b>Restore only a backup you made yourself.</b> A restore replaces
              all your data. To keep you safe, a few things are not restored:
              custom local shells, trusted host keys, profile startup commands,
              and the sudo auto-fill switch. Afterwards, re-add your custom
              shells (then open <Nav>Edit</Nav> on each struck-through profile
              and save it), retype your startup commands, expect each host to
              ask you to confirm its key on the first connect, and turn
              auto-fill back on if you use it. A list of what changed is shown
              once the app reloads, and kept in <Nav>Logs</Nav> &rarr;{" "}
              <Nav>Toasts History</Nav>.
            </li>
            <li>
              <Nav>Audit log</Nav>: turn audit recording on or off.
            </li>
            <li>
              <Nav>Security</Nav>: the sudo auto-fill switch, whether a connect
              deletes its own setup line from the host's shell history, and the
              admin lock. All three are described in the Security section below.
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
      "security credentials storage credential manager age encrypted file sqlite transmitted telemetry tofu host key sudo auto-fill admin lock argon2 recovery code isolation separate logins privacy why was my password not typed nothing filled in did not fill shell history bash_history history -d delete entry up arrow long line setup line keep my history clean stop broadside writing to my host histcontrol ignorespace ignoreboth ignoredups hist_ignore_space echo $histcontrol how do i tell if my host records it switch does nothing no difference on or off cannot tell what it does audit record of what happened on the box",
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
              Once saved, a secret is never shown again. You can replace it.
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
              It only answers <Nav>sudo</Nav>. Password prompts from other
              programs (<Nav>su</Nav>, <Nav>ssh</Nav>, a database client) are left
              for you, so a stored password is never sent somewhere you did not
              intend.
            </li>
            <li>
              <Nav>Keep the connect line out of the host's shell history</Nav>{" "}
              is <b>off</b> by default. When a terminal opens, Broadside sends
              the host a short setup line. Debian and Ubuntu keep that line out
              of the shell history by default, but many other systems do not, so
              the <Nav>Up</Nav> arrow finds it instead of your last command.
              Turn this on and Broadside deletes that one entry for you; it never
              touches your own commands. It has no effect on <code>zsh</code>,
              and applies to terminals opened after you turn it on. To see
              whether a host needs it, run <code>{'echo "$HISTCONTROL"'}</code>{" "}
              there: if the answer includes <code>ignorespace</code> or{" "}
              <code>ignoreboth</code>, it does not.
            </li>
            <li>
              The admin lock is an optional passcode that protects the credential
              and security controls. It is for authorization only: it uses{" "}
              <Term term="argon2" /> and encrypts nothing, so losing the passcode
              loses no data. Setting it gives you a one-time recovery code to
              regain access if you forget the passcode.
            </li>
            <li>
              The admin lock does not keep people who share one Windows account
              apart. To limit a less-trusted colleague, give them their own
              Windows login and a <Term term="csv" /> of hosts (which never
              contains passwords), so they never receive your stored secrets.
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
          Broadside is a Windows desktop app and runs comfortably on modest
          hardware.
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
              No administrator rights are needed to run it. WebView2 comes with
              Windows 11 and recent Windows 10; on an older system the installer
              adds it.
            </li>
            <li>
              Memory use grows with the number of open terminals and how much
              scrollback each keeps (<Nav>Settings</Nav> &rarr;{" "}
              <Nav>Appearance</Nav> &rarr; <Nav>Terminal scrollback</Nav>).
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
              It can happen, and it is a false alarm: a new, unsigned app that
              starts shell processes is exactly what Windows Defender's automatic
              checks are wary of.
            </li>
            <li>
              A detection name ending in <code>!ml</code> (Broadside has been
              flagged once as <code>Trojan:Win32/Bearfoos.A!ml</code>) means no
              known malware was found; the file just looked unusual.
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
              Please report it, with the detection name and version, so it can
              be sent to Microsoft as a false positive. A Defender exclusion
              stops the warnings but also stops Defender checking that folder,
              so use one only as a stopgap.
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
      "keyboard shortcuts keys shortcut matrix table list all hotkeys key bindings chord ctrl shift alt f11 f10 esc escape tab enter arrow alt left right ctrl shift g fullscreen ctrl shift t controls strip ctrl shift c copy ctrl shift v paste ctrl f find search right click copy paste select then right click highlight mouse copy on select gone composer history up down shift enter newline sftp commander ctrl click shift click multi select rename commit cancel what does key do reference",
    body: (
      <>
        <Lead>
          Every key Broadside takes for itself, and what it does. Any other key
          goes to whatever has the focus; in a terminal, that is the shell.
        </Lead>
        <ShortcutMatrix />
      </>
    ),
  },
  {
    id: "help-sec-warnings",
    title: "Warnings and messages",
    keywords:
      "warning warnings message messages error errors matrix table what does mean red test button red plug icon unreachable host down still red after restart os error 10054 forcibly closed connection reset maxstartups timed out timeout authentication failed no credentials stored host key changed refused unknown key tofu shell chip fish csh unsupported login shell amber chip disconnected banner reconnect every terminal hidden from the grid latency explain meaning troubleshooting no shell chip shell unread no integration console menu printed twice menu reprints pfsense rc.initial checked hosts report no blocks multiterminal silent no output got it dismiss amber line bottom of the pane strip keeps coming back said again could not read this host's login shell so it sent nothing slow rc file bashrc zshenv nvm conda pyenv rvm startup script above the interactive guard nfs home directory slow mount probe timeout eight seconds connect takes ages then no blocks host was fine yesterday",
    body: (
      <>
        <Lead>
          What each message Broadside can show you means, and what to do about
          it.
        </Lead>
        <WarningMatrix />
        <p>
          Anything that reaches the{" "}
          <SectionLink id="help-sec-logs">Logs</SectionLink> tab is recorded
          with the host and what was running, so look there for a message that
          went by too quickly.
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
