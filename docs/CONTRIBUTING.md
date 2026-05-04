# Contributing

## Prerequisites

- Node.js (version pinned in `.nvmrc`). Use `nvm use` to switch.
- Platform-specific build tools for native modules (see below).

### Native build tools

- **Windows:** Visual Studio Build Tools 2022 with the "Desktop development with C++" workload.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).

## Setup

```bash
git clone https://github.com/<YOUR-FORK>/sightflow-desktop-agent.git
cd sightflow-desktop-agent
nvm use
npm install
npm run dev
```

## Development workflow

1. Create a feature branch off `main`:
   `git checkout -b feat/your-feature`
2. Make changes. The pre-commit hook will run lint+format on staged files.
3. Add tests in `tests/` or co-located as `*.test.ts(x)` next to the file.
4. Run `npm test` to make sure everything passes.
5. Run `npm run typecheck` if you changed types.
6. Commit using **Conventional Commits** (commitlint will enforce):
   - `feat: add X`
   - `fix: correct Y`
   - `chore: update Z`
   - `docs: explain W`
   - `test: cover V`
   - `refactor: simplify U`
   - `ci: tweak T`
7. Push and open a PR against `main`.

## Tests

- `npm test` — run all tests once.
- `npm run test:watch` — watch mode.
- `npm run test:coverage` — generate coverage report.

## Code style

- ESLint + Prettier. Run `npm run lint` and `npm run format` if needed.
- TypeScript strict mode (do not weaken).
- No `any` unless commented with the reason.

## Architecture

See `docs/architecture.md` and `docs/adr/`.

## Manual smoke tests (RPA)

The following scripts run against a real machine (will move your mouse,
type into the focused window). Use a clean VM or be careful:

```bash
npm run dev:test-screenshot
npm run dev:test-reply
npm run dev:test-switch
```
