# Agent guidance

## Release notes — required shape

Write **only** these sections, in this order. Nothing else.

1. **Opening (no heading)**  
   1–3 sentences: what this release is and who it’s for. No product-name H1 (GitHub already has the title). Do not restate the repo name as a heading.

2. **`## Install`**  
   - Verify checksums (`sha256sum -c SHA256SUMS`)  
   - Unpack `release.tar` into the site static root  
   - One entry script tag  
   - One short line on default behavior after load (e.g. palette shortcut)  
   - Optional config: point to the README (`globalThis.AgentOSSearch`); do not paste the option table  

3. **`## What’s in release.tar`**  
   The package tree (or a short equivalent of what the tarball contains). Note that `SHA256SUMS` is attached to the release.

4. **`## Highlights`**  
   A short bullet list of **user- or integrator-visible** capabilities shipped in this version (runtime model, install story, UI surface, retrieval behavior, warm path if relevant, etc.). Concrete, present-tense “what you get.”

5. **`## License`**  
   This product’s license only (e.g. Apache-2.0, opyt.cloud).

## Release metadata

- **Title:** the version tag only (`v0.1.0`). Omit a custom `--name` unless there is an explicit reason.
- **Notes file:** outside the repo (e.g. `/tmp/NOTES-vX.Y.Z.md`) or `--notes` at cut time—do not commit notes into the tree.
- **When to cut:** after the target commit is on the remote; publish with `//tools/gh-release:publish` so assets are graph outputs + `SHA256SUMS`.
