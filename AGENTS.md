# AGENTS.md

## Repository Rules

- Use English for all source comments, UI copy, commit messages, and documentation.
- Develop test-first. Add or update the failing test before implementing the change.
- Aim for 100% meaningful test coverage. Do not add brittle or hacky tests only to force coverage when the behavior is impractical to test cleanly.
- Follow Conventional Commits for commit messages.

## Verification Before Commit

Run these checks before every commit and fix all errors and warnings:

- `pnpm format`
- `pnpm lint-fix`
- `pnpm type-check`
- `pnpm test`
- `pnpm android:check`
- `pnpm android:build`
- `pnpm android:emulator:verify`
- `git diff --check`

## Project-Specific Workflow

- When starting the app for manual verification, run both the web dev server and the agent:
  - `pnpm dev`
  - `node apps/agent/dist/main.js`
- Use `.tasks/docs/design/index.html` as the visual source of truth for UI changes.
- The web UI is not mobile-supported; target desktop and tablet-class viewports only.
- Verify Android-facing behavior with the emulator, not only unit tests or static inspection.
