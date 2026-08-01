# Broadside: working rules

Rules that outlive a conversation. Anything here beats a default.

## The help PDF is built at release, and only at release

`src-tauri/resources/broadside-help.pdf` is the handbook the Help tab's
**Download PDF** button hands out. It is a committed binary, because the release
MSI is built by a cloud runner from what is in the repository, and it is a
snapshot of the help at one version.

- Build it with `npm run help:pdf` (see `scripts/help-pdf/`). Needs Edge or
  Chrome on the machine; nothing is installed and no package is added.
- Run it **only when preparing a release**, as part of the same push that takes
  the version bump to `main`. Then commit the PDF with that change.
- Do **not** rebuild it after an ordinary edit to a help section. A new
  megabyte-and-a-bit binary in every commit is noise, and a document stamped
  with a version that was never released is worse than one that is slightly
  behind. The app's own Help tab is always current; the PDF says which version
  it was printed from and tells the reader to check the tab.
- `scripts/release.ps1` refuses to cut a release when the help sources are
  newer than the PDF, which is the check that this rule is being followed.

The one thing that must move in step: if `scripts/help-pdf/` or the shape of
`src/pages/help/content.tsx` changes, build the PDF once in that same branch to
prove the generator still runs. Then decide whether the output belongs in the
commit (only if a release is being cut) or not.
