// cli.ts — Stage 3 entry point.
//
// Stage 2's cli.ts built a world and handed control to the loop, printing
// what happened as it played out. Stage 3 adds one more responsibility:
// once the run finishes, write its full plan+action+result trace to
// `runs/<timestamp>.json` so it can be read back later instead of only
// existing in scrollback. All the actual "agent" mechanics (plan -> tool_use
// -> execute -> tool_result -> repeat) live in agent.ts and tools.ts — read
// grid.ts, then tools.ts, then agent.ts, then this file, in that order, if
// you're using this repo to learn.

import "dotenv/config"; // loads .env into process.env — see .env.example
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createGrid, renderGrid, describePositions, isLayout, LAYOUT_NAMES, type Layout } from "./grid.js";
import type { RunResult } from "./agent.js";
import { loadLayoutMemory, recordRun, renderLongTerm } from "./memory.js";
import { agentLabel, buildRunner, missingKey, modelFor, parseAgentConfig, runCostUsd, type AgentConfig } from "./runners.js";
import { formatCost } from "./usage.js";

// Which brain drives the loop (see runners.ts for the full list):
//   jev (default)  TypeSafe Jev answering typed Choice questions
//   claude         the Stage 3/4 plan-then-act Anthropic loop
//   planner        Stage 6: a planner model steering an executor model
//   classic        no model at all: BFS, $0 (solver.ts) — the cost-effective baseline
// NAVIGATE=1 additionally gives claude/planner the navigate_to tool, which
// walks a BFS path in one call. AGENT=claude+nav is the same thing.
const agentText = (process.env.AGENT ?? "jev") + (process.env.NAVIGATE === "1" && !(process.env.AGENT ?? "").includes("+nav") ? "+nav" : "");
let CONFIG: AgentConfig;
try {
  CONFIG = parseAgentConfig(agentText);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const AGENT = CONFIG.brain;

const missing = missingKey(CONFIG);
if (missing) {
  console.error(`Missing ${missing}. Copy .env.example to .env and add your key (or try AGENT=classic, which needs none).`);
  process.exit(1);
}

const MODEL = modelFor(CONFIG);

// The move-limit end condition from the README ("move limit reached, e.g.
// 20 moves"). Only `move` tool calls count against this — `look` and
// `pickup` don't cost a move, so a cautious agent that checks before every
// step isn't punished for it.
const MAX_MOVES = Number(process.env.MAX_MOVES ?? 20);

// "easy" is Stage 2's original layout (trap off the direct path). "hard" is
// Stage 3's addition: the trap sits directly between player and treasure,
// so the plan text has to explain a detour — see grid.ts. Stage 5 added eight
// more fixtures (LAYOUT_NAMES). Defaults to "easy" to keep `pnpm start`
// matching Stage 2's behavior.
const layoutName = process.env.LAYOUT ?? "easy";
if (!isLayout(layoutName)) {
  console.error(`Unknown LAYOUT "${layoutName}". Choose one of: ${LAYOUT_NAMES.join(", ")}.`);
  process.exit(1);
}
const LAYOUT: Layout = layoutName;

// Stage 4 switches. HIDE_TRAP=1 keeps the trap out of what the agent sees, so
// it has to discover it — that's what gives long-term memory something to
// remember. MEMORY=off skips reading and writing memory.json (for A/B runs).
const HIDE_TRAP = process.env.HIDE_TRAP === "1";
const MEMORY_ENABLED = process.env.MEMORY !== "off";

if (HIDE_TRAP && AGENT === "jev") {
  // Jev's state and trap guard read the true trap position, so hiding it
  // here would only hide it from the printout, not from the decision.
  console.error("HIDE_TRAP=1 is only supported with AGENT=claude (Jev's guard reads the real trap position).");
  process.exit(1);
}

const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");

async function main() {
  const state = createGrid(LAYOUT);

  console.log("=== Starting grid ===");
  console.log(`Layout: ${LAYOUT}`);
  console.log(renderGrid(state));
  console.log();
  console.log(describePositions(state));
  console.log();
  // Long-term memory: everything except Jev reads it (Jev's state is fixed).
  const useMemory = MEMORY_ENABLED && AGENT !== "jev";
  const layoutMemory = useMemory ? loadLayoutMemory(LAYOUT) : null;
  const longTerm = useMemory ? renderLongTerm(layoutMemory) : null;
  console.log(`Long-term memory: ${longTerm ?? (useMemory ? "nothing remembered for this layout" : "off")}`);
  console.log(`Trap hidden from agent: ${HIDE_TRAP}`);
  console.log();
  console.log(`=== Running ${agentLabel(CONFIG)} (${MODEL}, max ${MAX_MOVES} moves) ===`);
  console.log();

  const startedAt = new Date();
  const result = await buildRunner(CONFIG)(state, MAX_MOVES, {
    hideTrap: HIDE_TRAP,
    longTerm,
    rememberedTrap: layoutMemory?.trap ?? null,
  });

  console.log("=== Run complete ===");
  console.log(`Outcome: ${result.outcome}`);
  console.log(`Moves used: ${result.moveCount}/${MAX_MOVES}`);
  const estimatedCostUsd = runCostUsd(result);
  if (result.usage) {
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = result.usage;
    console.log(
      `Tokens: ${inputTokens} in / ${outputTokens} out` +
        (cacheReadTokens + cacheWriteTokens > 0 ? ` (cache: ${cacheReadTokens} read, ${cacheWriteTokens} written)` : "")
    );
    console.log(`Estimated cost: ${formatCost(estimatedCostUsd)} (list prices)`);
  }

  if (useMemory) {
    recordRun(
      LAYOUT,
      {
        timestamp: startedAt.toISOString(),
        agent: agentLabel(CONFIG),
        outcome: result.outcome,
        moveCount: result.moveCount,
        usedMemory: longTerm !== null,
      },
      result.discoveredTrap
    );
    console.log(`Memory updated${result.discoveredTrap ? " (trap location learned)" : ""}.`);
  }

  const runFile = writeTrace(startedAt, result, longTerm !== null, estimatedCostUsd);
  console.log(`Trace written to ${runFile}`);
}

/**
 * Writes the run's plan+action+result trace to `runs/<timestamp>.json`.
 * This is Stage 3's acceptance criteria made literal: every step in the
 * trace carries plan text, the action taken, the tool result, and the
 * resulting state, so a run can be reviewed later without having to have
 * watched it live in the terminal.
 */
function writeTrace(
  startedAt: Date,
  result: RunResult,
  usedMemory: boolean,
  estimatedCostUsd: number | null
): string {
  mkdirSync(RUNS_DIR, { recursive: true });

  const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const runFile = join(RUNS_DIR, `${timestamp}.json`);

  const record = {
    timestamp: startedAt.toISOString(),
    agent: agentLabel(CONFIG),
    model: MODEL,
    layout: LAYOUT,
    maxMoves: MAX_MOVES,
    hideTrap: HIDE_TRAP,
    usedMemory,
    outcome: result.outcome,
    moveCount: result.moveCount,
    usage: result.usage ?? null,
    estimatedCostUsd,
    trace: result.trace,
  };

  writeFileSync(runFile, JSON.stringify(record, null, 2));
  return runFile;
}

// Handle rejection explicitly: a failed API call should print and exit
// non-zero, not surface as an unhandled promise rejection.
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
