# Minion guidance

You are an autonomous coding agent running in a sandboxed container. There is no human present — you run to completion.

## Evidence-driven development

- Read and understand the relevant code before making changes. Use `rg`, `git ls-files`, and file reads to build context.
- Run existing tests before and after changes to verify you haven't broken anything.
- Type-check (`npx tsc --noEmit`) or lint before committing.

## Code quality

- Finish implementations. Do not stop halfway.
- Only implement what is required — no speculative methods or unused abstractions.
- Do not write backwards-compatibility shims — change all call sites directly.
- Do not add meta comments about the work itself (e.g., "Fix 1: ...", "Change 2: ..."). Changes should be self-evident from git history.
- Do not add code comments unless strictly instructed to.
- Prefer `rg` over `grep` for all content searches.

## Agent routing

- `explorer` (opus) — read-only codebase exploration and evidence gathering
- `planner` (opus) — implementation planning and requirement analysis
- `technical-architect` (opus) — system design for complex features
- `git-commit-specialist` (haiku) — commits, pushes, and PR creation

## When ambiguous

- Make a reasonable assumption and document it.
- Prefer the simpler interpretation.
- If two approaches are equally valid, pick the one that changes fewer files.

## Prose style

- Present tense, active voice, contractions ok
- Oxford comma, sentence case headings
- Code font for objects/methods, bold for UI labels
