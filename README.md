# Agentic Grid Hunter — Learning Project Spec

**Goal:** Grok agentic AI by building the core loop from scratch, no framework, in stages that each ship independently. Toy domain (grid-world treasure hunt) chosen specifically because it's deterministic — real ground truth for evals later, not vibes.

**Stack:** TypeScript, Node, Anthropic SDK direct (`@anthropic-ai/sdk`), no LangGraph/Mastra/Vercel AI SDK. Plain CLI. pnpm. Keep deps minimal — this is a from-scratch exercise, reach for a library only if it's not the thing you're trying to learn.

**Repo shape:** single package, not a monorepo — this doesn't need Faktor10's usual `apps/services/packages` split.

```
agentic-grid-hunter/
  src/
    grid.ts          # environment: state, rules, rendering
    agent.ts         # Claude loop: plan -> tool call (grows per stage)
    jev-agent.ts     # alternate brain: TypeSafe Jev classifier loop (see "Jev agent")
    tools.ts          # tool defs + executors (shared by all agents), incl. navigate_to
    memory.ts         # stage 4: per-run scratchpad + cross-run memory.json
    solver.ts         # BFS shortest path + walkTo: the classic, zero-token solution
    classic-agent.ts  # AGENT=classic: no model, just solver.ts
    planner-agent.ts  # stage 6: planner model steers an executor model
    runners.ts        # builds any agent from a config string ("claude+nav")
    eval.ts           # stage 5: scorecard over 10 layouts x N runs x agents
    cli.ts            # entry point: plays one game, writes the trace
  runs/                 # logged traces (gitignored except .gitkeep)
  memory.json           # stage 4 long-term memory (gitignored, created on first run)
  README.md
```

---

## Getting started (Stages 1–6 and the classic solver are built)

```bash
pnpm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
pnpm start              # runs the agent loop: plan -> tool call -> result, per turn
LAYOUT=hard pnpm start   # Stage 3's trap-in-the-way layout (see Stage 3 below)
pnpm typecheck           # tsc --noEmit

AGENT=classic pnpm start            # no model, no key, $0: BFS (see "The classic solution")
AGENT=claude+nav pnpm start         # Claude, plus the navigate_to tool
AGENT=planner pnpm start            # Stage 6: planner + executor
pnpm eval                           # Stage 5 scorecard (classic only by default: free)
EVAL_AGENTS=classic,claude,claude+nav,planner pnpm eval
```

`LAYOUT` takes any of ten fixtures: `easy`, `adjacent`, `straight`, `diagonal`,
`corridor`, `hard`, `trap_at_start`, `guarded_treasure`, `squeeze`, `big_7x7`
(what each tests is in `src/grid.ts`).

Every run also writes its full trace — plan text, action, tool result, and
resulting state for each turn — to `runs/<timestamp>.json` (gitignored; see
Stage 3 below). Claude runs also record token usage per turn and for the whole
run, plus an estimated cost (see "Cost per run" below).

The Claude loop defaults to `claude-haiku-4-5` (cheapest current model, plenty
for a 5x5 grid). Override with `ANTHROPIC_MODEL=...` in `.env`.

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

## Stage 4 — Memory — built (Claude agent only)

**Objective:** Distinguish short-term (within-run) from long-term (cross-run) memory, and see what each buys you.

**What's built:**
- **Hidden trap.** `HIDE_TRAP=1` keeps the trap out of the grid and the positions text the agent sees (`ViewOptions` in `grid.ts`). Without this there's nothing to remember: both agents were previously *told* where the trap is, so a second run could never beat a first. The agent can still find the trap with `look()` or by stepping on it.
- **Short-term memory** (`memory.ts` `Scratchpad`): cells visited and hazards found this run, built from what the world reported (not from the model's claims) and rewritten into the system prompt before every API call.
- **Long-term memory** (`memory.json`, gitignored): per-layout trap position and run history. Read at start, updated at the end, and told to the model as one line in the system prompt. The trap is learned from a `lose` or from a `look()` that sees it.
- **`MEMORY=off`** skips reading and writing, for before/after comparisons.
- Trace files now record `hideTrap` and `usedMemory`.

```bash
rm -f memory.json                                   # start with a blank memory
HIDE_TRAP=1 LAYOUT=hard AGENT=claude npm start      # run 1: likely hits the trap, learns it
HIDE_TRAP=1 LAYOUT=hard AGENT=claude npm start      # run 2: plan should cite the memory
```

**Scope limits:** only the Claude loop uses memory. `HIDE_TRAP=1` with `AGENT=jev` exits with an error, because Jev's state and trap guard read the real trap position.

**Status:** plumbing verified offline with a scripted stand-in client (run 1 loses and writes `memory.json`; run 2's prompt contains the remembered trap and its stand-in detours and wins; no trap coordinates leak into the hidden-mode prompt). **Not yet checked against real Claude**: whether run 2's actual plan cites the memory, and whether it really does better, are the acceptance criteria below and still need a real run.

**What it teaches:**
- Memory is never a model feature, only text our code chooses to put in the prompt. Short-term and long-term differ in *lifetime*, not in mechanism.
- Memory only helps for facts the agent can't already see. That is why the hidden trap exists.
- Stale memory is a real risk: it's keyed by layout *name*, so if a layout's trap is edited, the agent is told something false. Real systems need invalidation.
- A single remembered fact is easy. What to store, and when to forget, is the hard part once there is more than one fact.

**Tasks:**
- Short-term: a scratchpad string/array injected into every prompt this run — "cells explored," "known hazards this run" — built from the trace so far, no persistence needed
- Long-term: simple JSON file (`memory.json`) keyed by layout ID — "trap was at (3,2) last time you played this layout." Read at start of run, updated at end.
- Run the same layout twice: first run discovers the trap the hard way, second run should reference it in its plan text and avoid it

**Acceptance criteria:**
- Second run on a repeated layout is measurably better (fewer moves or no trap hit) than the first
- Can point to a plan text in run 2 that explicitly references stored memory

**Explicitly out of scope:** vector search / embeddings — a flat JSON keyed by layout is enough at this scale. Don't reach for a vector DB here, that's a different lesson.

---

## Cost per run (usage logging)

A single Claude run once cost about 7 cents, which prompted this. Each Claude run now prints, and writes to its trace file, the tokens used per turn and in total (`usage`), plus `estimatedCostUsd` from list prices in `src/usage.ts`. Jev runs don't report usage yet.

**Why a run costs more than it looks like:**
- The API is stateless, so turn N re-sends the system prompt, the tool schemas and all N−1 earlier turns. Input cost grows roughly with the *square* of the turn count, so a long run costs far more than a short one.
- Models with thinking on by default bill hidden thinking tokens as output even when the trace shows none. `claude-haiku-4-5` has no thinking by default, one reason it is the default here.
- No prompt caching is used, so none of the repeated prefix is discounted. Caching wouldn't help yet anyway: the prompt is shorter than the minimum cacheable prefix, and the Stage 4 scratchpad sits in the system prompt, so it changes the prefix every turn.

**Cost levers, in the order to try them:** measure first (this logging), then a cheaper model, then lower effort or thinking where the model supports it (not Haiku 4.5), then caching once the prompt is long enough (move per-turn volatile text such as the scratchpad to the end of the conversation), then fewer wasted turns.

**Caveats:** prices are a cached list-price table in `src/usage.ts`. Check Anthropic's pricing page; an unknown model reports `unknown` rather than a guess. The numbers have only been checked against a scripted stand-in client, not a real billed run, so compare the first real run against your Anthropic usage dashboard.

---

## Stage 5 — Evals & Observability — harness built, before/after still to run

**Objective:** This is where "production concerns" stops being abstract — you have ground truth (win/lose, move count) to score against.

**What's built:**
- **Ten fixtures** in `LAYOUTS` (`grid.ts`), from "treasure is next to you" to a 7x7 board and a trap guarding the treasure. `LAYOUT=<name>` selects one for a single game.
- **`eval.ts`** (`pnpm eval`): plays every layout x agent N times (`EVAL_RUNS`, default 5) on a fresh grid and prints two tables: wins/games and average moves per layout (next to the shortest possible, `opt`, computed by BFS), then per-agent totals: win %, trap-hit %, move-limit %, errors, moves per win, moves over optimal, turns, cost per run and **cost per win**.
- **A spend brake.** `MAX_COST_USD` (default 2) stops the eval starting new games once the estimated spend passes it; an unattended loop over a paid API needs one. Games are played one pass at a time (one game per layout and agent per pass), so if the brake trips every layout has the same number of games, give or take one pass. The first real eval ran layout-by-layout instead and the brake dropped the three hardest layouts entirely.
- **Saved after every game**, and the full trace is kept for every game that didn't win, so Ctrl+C or the brake never loses what was already paid for, and a loss can be read, not just counted. The file has `"finished": false` until the run completes. A real run is 10 layouts x 5 runs x agents, so check the arithmetic first: Haiku runs were roughly a cent each, Sonnet several times that.
- Memory is **off** during evals so run 5 isn't graded against what run 1 learned. Results are saved to `runs/eval-<timestamp>.json`, so before/after is two files.
- Agents are named by config strings (`runners.ts`): `classic`, `claude`, `claude+nav`, `planner`, `planner+nav`, `jev`. `HIDE_TRAP=1` turns on fog of war for all of them (Jev can't play it).

```bash
pnpm eval                                              # classic only: free, instant
EVAL_AGENTS=classic,claude,planner EVAL_RUNS=3 pnpm eval
HIDE_TRAP=1 EVAL_AGENTS=classic,claude pnpm eval       # trap only found by look()
```

**First real eval** (`HIDE_TRAP=1`, 3 runs, 7 of 10 layouts before the $2 brake, ~$2.04 spent; the three hardest layouts never ran):

| agent | win | avg turns | $/run | share of spend |
|---|---|---|---|---|
| classic | 100% (21/21) | 2.0 | $0 | 0% |
| claude | 95% (20/21) | 9.5 | $0.032 | 33% |
| claude+nav | 100% (21/21) | 2.2 | $0.005 | 5% |
| planner | 100% (20/20) | 11.8 | $0.063 | 62% |

What it showed: wins barely separate the agents on these layouts (the one loss was plain `claude` stepping on the hidden trap on `hard`, 1 game in 21, too few to conclude anything). Cost tracks turns, and turns are quadratic: 17 turns cost $0.082 and 8 turns $0.017 on near-identical games. The planner cost about 2x a lone Claude on every layout for no extra wins, and every planner game took `moves x 2 + 1` turns (17 for an 8-move game): the executor looked before every step, because the planner's strategy told it "when to look()". `look()` adds no move but costs a full paid turn.

**The change driven by that result:** the planner prompt (`planner-agent.ts`) now tells the planner what a look costs and not to prescribe one per step. `PLANNER_PROMPT=v1` reproduces the old wording. Before/after is `PLANNER_PROMPT=v1 EVAL_AGENTS=planner ...` against the default, same layouts. **The "after" numbers are not collected yet.**

**Harness status:** the harness runs end to end. `classic` scores 100% on all ten layouts at the optimal move count, $0. The first real-API eval is in the table above; the three hardest layouts (`guarded_treasure`, `squeeze`, `big_7x7`) still have no Claude numbers.

**Acceptance criteria:**
- Eval script runs unattended and produces a scorecard — **met** (`pnpm eval`).
- You've made at least one change driven by eval results, not guesswork, and can show before/after numbers — **change made (planner prompt v2); the "after" run is still open.** The cheapest informative run is `EVAL_AGENTS=planner EVAL_LAYOUTS=diagonal,hard HIDE_TRAP=1 EVAL_RUNS=3 npm run eval` with and without `PLANNER_PROMPT=v1` (watch turns and $/run: v1 should show moves x 2 + 1 turns).

**Explicitly out of scope:** full observability stack (Axiom/Better Stack) — that's real infra, not needed to learn the concept at toy scale. A JSON trace file + a console table is enough signal here.

---

## Stage 6 — Multi-Agent (planner / executor split) — built, comparison still to run

**Objective:** Only start this once 1–5 feel solid — this is the stage most tutorials rush into too early, and it's much clearer once you've felt the single-agent loop firsthand.

**What's built** (`planner-agent.ts`, `AGENT=planner`):
- **Planner** (`PLANNER_MODEL`, default `claude-sonnet-5-5`): one tool-less call that sees the grid, positions, long-term memory and move budget and writes a `<strategy>` of at most three sentences. Not per-move.
- **Executor** (`ANTHROPIC_MODEL`, default Haiku): the existing `runAgentLoop`, with the strategy added to its system prompt. It still picks every tool call.
- **Handoff contract.** Planner → executor: one strategy text, re-read before every executor API call, so a revision applies next turn. Executor → planner: an `ExecutorReport` (reason, turn, moves used, position, hazards found, last three turns), sent every 4 turns and immediately when a *new* hazard is found. The planner answers with a revised strategy or repeats it. Nothing else crosses: the planner never sees the executor's conversation, the executor never sees the planner's reasoning.
- Cost covers both models (`costUsd` on the result), so `pnpm eval` compares like for like.

Run the comparison with `EVAL_AGENTS=claude,planner pnpm eval` (add `HIDE_TRAP=1` for the case where a planner might help).

**Observed (first real eval, above):** the planner cost about 2x a lone `claude` with no extra wins, and made the executor look before every move. That is why the planner prompt now has a `v2` (see Stage 5); whether `v2` actually helps is the open question.

**Status:** the handoff was verified with a scripted stand-in client (strategy reaches the executor prompt, periodic and hazard checkpoints fire, planner tokens are billed at the planner's price). **No real-API scorecard yet**, so the "does it help?" question is open. My expectation, to be tested not assumed: on a 5x5 grid it costs more than a single agent for no gain, because the executor can already see the whole board. A planner earns its keep when the executor is much cheaper and the task is long enough that a strategy changes the outcome.

**Acceptance criteria:**
- Two distinct prompts/roles with a defined handoff contract — **met** (above, and the header comment of `planner-agent.ts`).
- Eval scorecard comparing single-agent vs two-agent on the same 10 layouts — **harness ready, needs your real run.**

**Deviation from the original task text:** the executor still sees the whole grid, not only its immediate surroundings. The grid is its only source of its own position; restricting it would need a second state view.

---

## The classic solution (the final example: no model at all)

A grid with a target is an implicit graph: cells are nodes, legal moves are edges. A few dozen lines of TypeScript (`src/solver.ts`) solve it deterministically, in microseconds, for $0, and never step on the trap. Run it: `AGENT=classic pnpm start`, or score it against the LLMs: `EVAL_AGENTS=classic,claude pnpm eval`.

**Which search, when.** DFS (visited set + backtracking) is the right fit when the map is *unknown* and the agent must physically walk it, because it never strays far from where it already is. BFS finds shortest paths, but only over a map you already know, since an embodied agent can't teleport between frontier cells. The classic recipe is to explore with DFS, then BFS or A\* over what you discovered. In this game the treasure is always given and only the trap can be hidden, so there is nothing to explore: `walkTo` plans with BFS, looks at the neighbours before every step under fog of war (`HIDE_TRAP=1`), and re-plans around anything it finds. Move the treasure into fog too and you'd need the DFS phase.

**What the LLM agents were doing, badly.** The scratchpad was a lossy visited set. The look before each move was neighbour expansion, billed at model prices. Every turn re-sent the whole history to re-derive what a queue and a hash set know.

**The lesson that carries over.** If you can write the state as a type and the transition as a pure function, it belongs in code. An LLM earns its place when the input is unstructured, the goal is ambiguous, or the action space can't be enumerated in advance. Grid navigation is none of those.

**In production the two combine:** the model decides *what* to do, deterministic tools do the *how*. That is `navigate_to(row, col)`: a tool that runs BFS internally, so the model names a destination instead of issuing single `move` calls. Turn it on with `NAVIGATE=1` or `AGENT=claude+nav`, then compare:

```bash
EVAL_AGENTS=classic,claude,claude+nav pnpm eval
```

Expected, not yet measured against real Claude: `claude` takes a dozen turns per game; `claude+nav` should take about two or three (navigate, then pickup), which cuts input tokens far more than prompt caching or prompt trimming would, because the cost is the turn count squared. `classic` is the same idea with the model removed entirely, and is the floor on cost and moves that any LLM agent must justify itself against.

---

## Jev agent (alternate brain)

`src/jev-agent.ts` swaps the generative model for [TypeSafe Jev](https://docs.typesafe.ai). Jev can't call tools or write a `<plan>`; it answers typed `Choice` questions with a probability per label. Each turn asks two (`tool: move|look|pickup`, `direction: up|down|left|right`) in one `systemOne` call, then executes through the same `executeTool` and `TraceStep` machinery.

```bash
cp .env.example .env     # set TYPESAFE_API_KEY
pnpm start               # AGENT=jev is the default
AGENT=claude pnpm start  # the Stage 3 Anthropic loop, unchanged
```

- **Abstain rule:** if the top label's probability is below `0.60` (`MIN_PROBABILITY`), the agent falls back to the free `look()` instead of acting. Illustrative threshold from TypeSafe's consistency cookbook; tune it with Stage 5 evals. Uses `probabilities`, not the `confidence` field.
- **Trap guard:** probabilities can't catch a confidently-wrong move, so `toAction` vetoes any `move` onto the trap and redirects to the safe direction closest to the treasure (the trace `plan` says `VETOED`). `state.next_cell_by_direction` also hands Jev what each move would land on, so the `direction` question is a lookup rather than arithmetic.
- **Stateless:** Jev keeps no conversation, so the last few turns ride along in `state` (`recent_history`) every call.
- **Trace:** the `plan` field holds the decision's probabilities instead of prose.
- **Stall breaker:** `look()` is deterministic, so a second consecutive `look` (abstained or chosen) is replaced by a guarded move (or `pickup` on the treasure). The trace `plan` says `STALLED`. The guard also vetoes moves off the grid edge.
- **Backstop:** a turn cap (4x the move budget) still ends a run as `move_limit`.

---

## Claude vs Jev: what we've learned so far

Everything below comes from a handful of hand-read runs on `LAYOUT=hard`, **not** from an eval. Treat it as hypotheses to test with `pnpm eval` (built, but not yet run against real Claude or Jev). No win rates exist yet.

### What we observed

| | Claude (`agent.ts`) | Jev (`jev-agent.ts`) |
|---|---|---|
| Output per turn | Free-text `<plan>` + one tool call | Probability per label for two `Choice` questions |
| "Plan" in the trace | Real reasoning, written *before* the action | The probabilities, printed *after* the decision. Not reasoning |
| Seen on `hard` | Plan named the trap at (4,2) and said it would `look` first | Run 1: walked into the trap without looking. Run 2 (after guards): got to (4,1), then spent every turn abstaining into `look()` until the turn cap |
| Failure style | Not observed yet (too few runs) | Confident-wrong (run 1), then indecisive (run 2) |

### Why they behave differently

- **Claude reasons in tokens before it acts.** The `<plan>` is generated first, so the tool call is conditioned on it. "Trap is in my path" can change what comes next.
- **Jev is one forward pass per question.** It classifies; it doesn't think step by step. `tool` and `direction` are two *independent* answers to the same state, so nothing forces them to agree. In run 2, `direction=right` stayed high (it points at the trap) while `tool` sat near 0.5 (torn between `move` and `look`).
- **`look()` wasn't the missing piece.** It only reports the four neighbours, and the trap's position was already in Jev's state (`grid` and `positions`). So "why didn't it look first?" was the wrong question: looking adds no information the agent didn't have. The real failure was acting on a bad answer.
- **A probability is not a correctness check.** The 0.60 abstain rule only catches *uncertainty*. Run 1 was confidently wrong, so the rule never fired. Run 2 was uncertain every turn, so the rule fired forever. Same rule, two opposite failures.
- **Claude's plan is not proof of reasoning either.** A fluent plan can be a story written to match the action. Whether the plan *causes* good behaviour is something to measure, not assume. See the eval ideas below.

### Learning points (agentic AI)

1. **The loop is the same; the brain is swappable.** Both agents share `executeTool`, `TraceStep` and the grid. Only "decide the next action" changed. That's the whole shape of an agent: perceive, decide, act, feed back.
2. **A generative model and a classifier want different harnesses.** Claude gets tools and history. Jev gets a typed question, and *you* supply the memory (`recent_history`) and the facts (`next_cell_by_direction`). Doing arithmetic for a one-shot classifier is part of the job.
3. **Every fallback must change the state, or it's a loop.** `look()` is deterministic and free, so "abstain and look" repeats forever. Any "safe" action has to either add information or move the world forward. This is why the stall breaker exists.
4. **Guard in code what must never happen.** Prompts and probabilities are soft. "Never step on the trap" is a hard rule, so it lives in `toAction`, not in the question wording.
5. **Fixing one failure can expose the next.** The trap guard fixed run 1 and then run 2 appeared, because abstain was checked before the guard. The first fix was tested only against confident stub answers. Tests need to cover each *decision path*, not just the happy one.
6. **Stubs prove plumbing, not quality.** The offline stubs showed the guard and stall breaker fire. They say nothing about how well real Jev plays. Don't read a stub win as a model win.
7. **Make failures visible in the trace.** `STALLED` and `VETOED` in the `plan` field turn invisible code interventions into something you can count. If the guard does the real work, that should show up as a number.

### Questions for Stage 5 (evals)

Counting beats reading single runs. `eval.ts` now records outcome, moves, turns and cost per run and layout; it does not yet record abstain rate or `VETOED`/`STALLED` counts for Jev. Per run, per layout, per agent:

- **Outcome:** win / trap hit / `move_limit`, plus moves-to-win. This is the ground truth.
- **Cost per run and cost per win** (from the `usage` / `estimatedCostUsd` trace fields). A cheaper model that wins less often can still be the better buy, so judge cost per *completed task*, not per run.
- **Trap-hit rate**, separate from the overall win rate.
- **Abstain rate** (Jev): share of turns below the threshold.
- **`VETOED` and `STALLED` counts** (Jev): how much the code guard is doing versus the model.
- **Wasted turns:** turns that were `look()` or an edge bump.

Experiments worth running once there's a harness (change one thing at a time):

1. **Guard on vs off.** Does Jev win because of the model or because of the veto? Needs a flag to disable `toAction`'s veto.
2. **`next_cell_by_direction` on vs off.** Did it help `direction`, or did it make `tool` more torn (run 2)?
3. **Threshold sweep** (0.5 / 0.6 / 0.7 / 0.8). Plot abstain rate against win rate to see whether 0.60 earns its keep.
4. **Claude with its plan vs without** (drop the `<plan>` requirement). Does writing a plan improve win rate, or just make it readable?
5. **Same layout, N runs.** Claude and Jev both vary between runs; one trace says nothing about reliability.

---

## Notes for execution

- Each stage should be its own commit/PR, working end-to-end before moving on — same as Pantler slices
- Hand one stage at a time to Sonnet for execution; use this doc (or the relevant section) as the task file
- If a stage starts wanting a framework, that's a signal you've learned what that stage was teaching — note it in the README and move on, don't retrofit
