# Agent instructions

This is a personal fork of getagentseal/codeburn. Upstream is a source of
features to pull in, not a merge target: no PRs go back to it.

## Commits and pull requests

Every commit subject and every PR title follows Conventional Commits:

    <type>(<optional scope>): <imperative summary>

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
`chore`, `revert`. Mark a breaking change with `!` after the type or scope and a
`BREAKING CHANGE:` footer.

This overrides the "Short imperative subject" format in CONTRIBUTING.md, which
describes upstream's convention, not this repo's.

## Python

Run Python through uv or rye, never the bare system interpreter. Declare
dependencies through the tool: PEP 723 inline metadata with `uv run --script`,
or a uv/rye project. This applies to packages normally installed with apt as
well, such as PyGObject (`gi`), which must be installed through uv or rye.
GObject typelibs such as AyatanaAppIndicator3 are still system files; a `gi`
installed this way loads them.
