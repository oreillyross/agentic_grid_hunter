# Copilot instructions for agentic-grid-hunter

## Repo overview

This repository is a small TypeScript learning project that builds an agentic AI loop from scratch in a deterministic 2D grid game. The goal is to understand the mechanics of tool-calling agents, not to ship a production framework.

The project is intentionally single-package and intentionally simple: plain Node/TypeScript, direct Anthropic and TypeSafe SDK usage, no app framework, no monorepo, and no abstraction layers beyond the game loop itself.

## Build, test, and validation commands

The repo currently defines only a minimal CLI workflow; there is no dedicated test runner or linter configuration.

Use the repo scripts from the package root:

```bash
# install dependencies
npm install
# or: pnpm install

# run the default agent loop
npm run start
# or: pnpm start

# TypeScript validation (the closest thing to a build/check step)
npm run typecheck
# or: pnpm typecheck
```

Common runtime variants used in this project:

```bash
# Anthropic / Stage 3 loop
AGENT=claude npm run start
# or: AGENT=claude pnpm start

# TypeSafe Jev loop (default in .env.example)
AGENT=jev npm run start
# or: AGENT=jev pnpm start

# Hard layout used for trap-detour behavior checks
LAYOUT=hard npm run start
# or: LAYOUT=hard pnpm start
```

Before running the AI-backed modes, create `.env` from `.env.example` and set the matching API key(s):

```bash
cp .env.example .env
```

There is no per-file or per-feature test command in this repo today. When validating a change, prefer `npm run typecheck` (or `pnpm typecheck`) and a focused CLI smoke run like `AGENT=claude npm run start` or `LAYOUT=hard npm run start`.

## High-level architecture

The repository follows a very small, explicit dependency chain that is worth preserving when touching code:

- `src/grid.ts`: the world model. Defines the grid, positions, layout fixtures, rendering, movement rules, and the deterministic state mutations.
- `src/tools.ts`: the tool contracts and executor. This is the boundary between model output and real game state changes. The API tool schemas are defined here, and the rules for `move`, `look`, and `pickup` live here.
- `src/agent.ts`: the Anthropic-driven ReAct loop. Sends state + prompt + tool definitions to the model, extracts a plan and tool call, executes the tool, feeds the result back, and keeps the trace.
- `src/jev-agent.ts`: alternate loop that swaps the generative model for TypeSafe Jev, which answers typed choice questions rather than emitting free-form text plus a tool call.
- `src/cli.ts`: entry point. Loads `.env`, chooses the active agent (`AGENT`), runs the loop, and writes a JSON trace to `runs/<timestamp>.json` when the run ends.

The repo is intentionally staged and explanatory: each file is designed to teach a stage of the agent loop rather than abstract it away. The README is the primary architectural guide; code comments in `src/*.ts` document the “why” behind the design.

## Key conventions specific to this repo

- Deterministic state: the world is intentionally fixed and seeded by layout, not generated randomly. This is important because the project is meant for evals and repeatability.
- Plain-data state objects: `GridState` is a simple object, not a class. The model never mutates state directly; it only gets a rendered text description and then triggers code-defined tool actions.
- Tool-based mutation boundary: every state-changing action goes through `executeTool(...)` in `src/tools.ts` rather than by directly editing `state` in the loop.
- In-place mutation is deliberate: `movePlayer()` mutates the shared `GridState` object because the CLI loop owns exactly one state instance for the run. Do not “improve” this into a complex immutable system unless the project explicitly moves to a broader multi-agent or multi-session design.
- Trace-first debugging: each run logs a trace of plan/action/result and writes it to `runs/*.json`; this is a core artifact, not optional logging.
- Explicit plan blocks for the Claude loop: the Anthropic loop expects a `<plan>...</plan>` block before each tool call. Missing plans are tolerated but logged as a reminder, and the loop asks for a correction in the next tool result.
- Move budget semantics: only `move` calls consume the move budget. `look()` and `pickup()` do not count as movement. This is part of the game’s rules and should be preserved when adjusting agent behavior.
- Read the README first when changing behavior: the repository is organized as learning stages (1–6), and the README describes exactly what each stage is trying to prove.

## Documentation to consult first

- `README.md` for the stage-by-stage intent and acceptance criteria.
- `.env.example` for environment variables and agent selection.
- `src/grid.ts` and `src/tools.ts` before changing agent behavior; these define the game rules and the action boundary.

## Agent-specific guidance

- The default CLI path is the TypeSafe Jev agent (`AGENT=jev`), but the anthropic loop (`AGENT=claude`) is the stage-3 explicit plan-then-act implementation.
- The repo expects the API keys to exist in `.env`; do not hardcode secrets or assume they are set globally.
- Prefer small, focused CLI smoke tests over broad changes. This project is meant to be observable and stage-oriented, so a targeted run is usually more informative than a large suite.
