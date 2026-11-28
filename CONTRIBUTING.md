# Contributing

Keep changes focused and explain the resulting behavior and its verification.
Check the working tree before editing so existing work is preserved.

## Repository layout

- `src/` contains extension source.
- `test/` contains unit tests and integration rigs.
- `dist/index.js` is the committed installation bundle.
- `docs/` contains operating guides, design references, and investigation records.
- `demo/` contains recording scripts and the terminal capture specification.
- `bench/` contains benchmark tools and results.

Generated test bundles, runtime state under `var/`, dependencies, and demo captures
are ignored. Keep credentials and personal runtime data out of commits.

## Documentation

Keep the root README focused on purpose, requirements, installation, first use,
and links to the guides. Update existing sections when behavior changes.

Put configuration defaults in `docs/CONFIGURATION.md`, commands and recovery in
`docs/OPERATIONS.md`, and build and test instructions in `docs/DEVELOPMENT.md`.
Use `docs/README.md` to make additional references discoverable.

Record commit-by-commit history in Git and explain individual changes in their
pull requests. Investigation records should carry the context and limitations
needed to interpret their evidence. Keep dated measurements in those records
and benchmark reports. Write current operating instructions without recounting
the incidents that produced them.

## Verification

Follow [the development guide](docs/DEVELOPMENT.md) and run checks appropriate to
the change. For documentation, check local links, command names, configuration
defaults, and Markdown rendering. For code, include regression coverage where it
helps verify changed behavior and regenerate the committed bundle.

Before submitting, review the complete diff for scope, generated files, and
accidental changes. Report checks that passed, skipped, or remain unresolved.
