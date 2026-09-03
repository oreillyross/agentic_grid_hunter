# Agentic Grid Hunter — Learning Project Spec

**Goal:** Grok agentic AI by building the core loop from scratch, no framework, in stages that each ship independently. Toy domain (grid-world treasure hunt) chosen specifically because it's deterministic — real ground truth for evals later, not vibes.

**Stack:** TypeScript, Node, Anthropic SDK direct (`@anthropic-ai/sdk`), no LangGraph/Mastra/Vercel AI SDK. Plain CLI. pnpm. Keep deps minimal — this is a from-scratch exercise, reach for a library only if it's not the thing you're trying to learn.

**Repo shape:** single package, not a monorepo — this doesn't need Faktor10's usual `apps/services/packages` split.

```
agentic-grid-hunter/
  src/
    grid.ts          # environment: state, rules, rendering
    agent.ts         # loop logic (grows per stage)
    tools.ts          # tool defs + executors
    memory.ts         # stage 4+
    eval.ts            # stage 5+
    cli.ts
  runs/                 # logged traces (gitignored except .gitkeep)
  README.md
```

---

## Getting started (Stages 1–3 are built)

```bash
pnpm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
pnpm start              # runs the agent loop: plan -> tool call -> result, per turn
LAYOUT=hard pnpm start   # Stage 3's trap-in-the-way layout (see Stage 3 below)
pnpm typecheck           # tsc --noEmit
```

Every run also writes its full trace — plan text, action, tool result, and
resulting state for each turn — to `runs/<timestamp>.json` (gitignored; see
Stage 3 below).

The source is heavily commented — read `src/grid.ts`, then `src/tools.ts`,
then `src/agent.ts`, then `src/cli.ts`, in that order, if you're using this
repo to learn the mechanics rather than just running it. That order follows
the dependency chain: the environment, then the actions available in it,
then the loop that ties actions to the model, then the entry point that
kicks it off.

---

## Stage 1 — Bare Loop

**Objective:** Prove the plumbing. One prompt in, one completion out, nothing agentic yet.

**Tasks:**
- Set up repo, `@anthropic-ai/sdk`, env var for API key
- `grid.ts`: minimal grid (say 5x5), player position, treasure position, trap position, walls optional (skip walls in v1)
- `cli.ts`: prints the grid as text, sends it to Claude with a system prompt describing the game, prints the raw text response
- No tool calls yet — just see that a description of the board round-trips into a sensible text reply

**Acceptance criteria:**
- `pnpm start` renders the grid and shows one model response referencing it correctly (e.g. correctly states where the treasure is relative to the player)
- No tool use, no loop — single call, exits

**Explicitly out of scope:** tool calling, multi-turn, memory.

---

## Stage 2 — Single Tool-Call Loop

**Objective:** The actual "agent" moment — model chooses actions, you execute them, feed results back, repeat.

**Tasks:**
- Define tools in `tools.ts`: `move(direction: "up"|"down"|"left"|"right")`, `look()` — returns what's adjacent, `pickup(item)`
- Wire Anthropic tool-use format (`tool_use` blocks in response → execute → `tool_result` back in next message)
- Loop: send state → model picks a tool call → execute against grid → append result → repeat
- Loop terminates on: treasure found (win), trap hit (lose), or move limit reached (e.g. 20 moves)
- Print each step to console: action taken, resulting state

**Acceptance criteria:**
- Agent can win a hand-placed easy layout (treasure 2 moves away, no trap in the way) most of the time
- Loop correctly terminates on all three end conditions
- You can watch the move-by-move transcript in the terminal and it makes sense

**Explicitly out of scope:** explicit reasoning/plan text, memory across runs, multiple tools per turn.

---

## Stage 3 — Explicit Plan-Then-Act (ReAct-style) — done

**Objective:** Make the reasoning visible, not just the actions. This is what separates "agent" from "function-calling chatbot."

**What's built:**
- The system prompt (`agent.ts`) now requires a `<plan>...</plan>` block (one or two sentences) before each tool call. A response with a tool call but no plan text isn't rejected — the turn still runs (the API requires a `tool_result` for every `tool_use` regardless), but the trace records `"(no plan given this turn)"` and the model gets a reminder folded into that turn's `tool_result` so it course-corrects next turn.
- Every turn is recorded as a `TraceStep` (`{ turn, plan, action, result, outcome, moveCount, gridAfter }`) — logged to the console as it happens, and the full run (plus `timestamp`, `model`, `layout`, `maxMoves`, final `outcome`/`moveCount`) is written to `runs/<timestamp>.json` by `cli.ts` once the run ends.
- `grid.ts` gained a `"hard"` layout alongside Stage 2's default `"easy"` one: trap at `(4,2)`, directly between the player at `(4,0)` and the treasure at `(4,4)` on the shortest path, so a straight-line plan runs the agent right into it. Select it with `LAYOUT=hard pnpm start`.

**Acceptance criteria:**
- Every step in the trace has: plan text, action taken, tool result, resulting state — see the `TraceStep` shape above and any `runs/*.json` file
- At least one run on a "trap in the way" layout where you can point to the plan text explaining the avoidance — run `LAYOUT=hard pnpm start` and read the `<plan>` text in the console output / trace file against the trap's position

**Explicitly out of scope:** the agent doesn't need to be *good* yet — the point is visibility, not performance. (In practice, watching a `LAYOUT=hard` run is exactly the exercise the README calls for: read the plan text at each step and check whether it actually names the trap and a detour, or just narrates the move it was going to make anyway.)

---

## Stage 4 — Memory

**Objective:** Distinguish short-term (within-run) from long-term (cross-run) memory, and see what each buys you.

**Tasks:**
- Short-term: a scratchpad string/array injected into every prompt this run — "cells explored," "known hazards this run" — built from the trace so far, no persistence needed
- Long-term: simple JSON file (`memory.json`) keyed by layout ID — "trap was at (3,2) last time you played this layout." Read at start of run, updated at end.
- Run the same layout twice: first run discovers the trap the hard way, second run should reference it in its plan text and avoid it

**Acceptance criteria:**
- Second run on a repeated layout is measurably better (fewer moves or no trap hit) than the first
- Can point to a plan text in run 2 that explicitly references stored memory

**Explicitly out of scope:** vector search / embeddings — a flat JSON keyed by layout is enough at this scale. Don't reach for a vector DB here, that's a different lesson.

---

## Stage 5 — Evals & Observability

**Objective:** This is where "production concerns" stops being abstract — you have ground truth (win/lose, move count) to score against.

**Tasks:**
- Fixed set of ~10 hand-designed layouts of varying difficulty, saved as fixtures
- `eval.ts`: runs the agent N times (e.g. 5) per layout, records win rate and average moves-to-win
- Output a simple table (layout, win rate, avg moves) — console table is fine, no dashboard needed
- Pick one thing to tighten based on what the evals show (e.g. system prompt tweak) and re-run to confirm it moved the numbers

**Acceptance criteria:**
- Eval script runs unattended and produces a scorecard
- You've made at least one change driven by eval results, not guesswork, and can show before/after numbers

**Explicitly out of scope:** full observability stack (Axiom/Better Stack) — that's real infra, not needed to learn the concept at toy scale. A JSON trace file + a console table is enough signal here.

---

## Stage 6 — Multi-Agent (planner / executor split)

**Objective:** Only start this once 1–5 feel solid — this is the stage most tutorials rush into too early, and it's much clearer once you've felt the single-agent loop firsthand.

**Tasks:**
- Split into two roles: **planner** (sees full state + memory, produces a short strategy — not per-move, more like "head toward treasure, trap is likely near the walls") and **executor** (sees the strategy + immediate surroundings, picks the actual tool call)
- Message-passing: planner's output becomes part of executor's system context; executor reports back after every N moves or on hazard encounter, planner can revise
- Reuse the eval harness from stage 5 to compare single-agent vs. planner/executor on the same layouts

**Acceptance criteria:**
- Two distinct prompts/roles with a defined handoff contract (what exactly planner passes to executor and vice versa)
- Eval scorecard comparing single-agent (stage 3/4) vs. two-agent performance on the same 10 layouts

---

## Notes for execution

- Each stage should be its own commit/PR, working end-to-end before moving on — same as Pantler slices
- Hand one stage at a time to Sonnet for execution; use this doc (or the relevant section) as the task file
- If a stage starts wanting a framework, that's a signal you've learned what that stage was teaching — note it in the README and move on, don't retrofit
