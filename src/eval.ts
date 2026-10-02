// eval.ts — Stage 5: score agents against ground truth instead of reading transcripts.
//
// FIRST PRINCIPLES: one run of an LLM agent tells you almost nothing. It varies
// from run to run, so reliability is a rate, and a rate needs a fixed task set
// and repeated trials. This file is that harness: every (layout, agent) pair
// is played N times on a fresh grid, each game ends in a ground-truth outcome
// (win / lose / move_limit — the world decides, not the model), and the results
// are folded into a scorecard.
//
//   npm run eval                                        # classic only: free, instant
//   EVAL_AGENTS=classic,claude,claude+nav,planner npm run eval
//   EVAL_RUNS=5 EVAL_LAYOUTS=hard,squeeze npm run eval     (layouts: see grid.ts)
//   HIDE_TRAP=1 EVAL_AGENTS=classic,claude npm run eval         (fog of war; Jev can't play)
//
// Variables: EVAL_AGENTS (comma list, see runners.ts), EVAL_RUNS (default 5),
// EVAL_LAYOUTS (default: all ten), MAX_MOVES (default 20), HIDE_TRAP, and
// MAX_COST_USD (default 2): the eval stops starting new games once the
// estimated spend passes it, because an unattended loop over a paid API needs a
// brake. Memory is deliberately off: N games on one layout must not teach each
// other, or run 5 would be graded against what run 1 learned.
//
// The comparison that matters is not "which agent wins" but cost per WIN and
// moves versus optimal. `classic` (BFS, $0) sets the floor on both; an LLM agent
// has to beat it on something else to justify itself. Every run's result is
// saved to runs/eval-<timestamp>.json so a before/after comparison after a
// prompt change is two files, not a memory.

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT_NAMES, createGrid, isLayout, type Layout } from "./grid.js";
import { optimalMoves } from "./solver.js";
import type { TraceStep } from "./agent.js";
import { plannerPromptVersion } from "./planner-agent.js";
import { agentLabel, buildRunner, missingKey, modelFor, parseAgentConfig, runCostUsd, type AgentConfig } from "./runners.js";
import { formatCost } from "./usage.js";

type Outcome = "win" | "lose" | "move_limit" | "error";

interface RunScore {
  outcome: Outcome;
  moves: number;
  turns: number;
  costUsd: number | null;
  error?: string;
  /** Full trace, kept only for games that didn't win: a score says THAT it failed, a trace says WHY. */
  trace?: TraceStep[];
}

interface Cell {
  layout: Layout;
  agent: string;
  runs: RunScore[];
}

const RUNS = Number(process.env.EVAL_RUNS ?? 5);
const MAX_MOVES = Number(process.env.MAX_MOVES ?? 20);
const HIDE_TRAP = process.env.HIDE_TRAP === "1";
const MAX_COST_USD = Number(process.env.MAX_COST_USD ?? 2);
const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseLayouts(text: string | undefined): Layout[] {
  if (!text) return LAYOUT_NAMES;
  return text.split(",").map((name) => {
    const trimmed = name.trim();
    return isLayout(trimmed) ? trimmed : fail(`Unknown layout "${trimmed}". Choose from: ${LAYOUT_NAMES.join(", ")}.`);
  });
}

/** Runs `task` with the per-turn console chatter of the agent loops muted. */
async function quietly<T>(task: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await task();
  } finally {
    console.log = original;
  }
}

async function playOnce(config: AgentConfig, layout: Layout): Promise<RunScore> {
  try {
    const result = await quietly(() => buildRunner(config)(createGrid(layout), MAX_MOVES, { hideTrap: HIDE_TRAP }));
    const score: RunScore = { outcome: result.outcome, moves: result.moveCount, turns: result.trace.length, costUsd: runCostUsd(result) };
    if (result.outcome !== "win") score.trace = result.trace;
    return score;
  } catch (error) {
    return { outcome: "error", moves: 0, turns: 0, costUsd: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: number[]) => (values.length === 0 ? null : sum(values) / values.length);
const fmt = (value: number | null, digits = 1) => (value === null ? "-" : value.toFixed(digits));
const pct = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`);

function summarise(runs: RunScore[]) {
  const wins = runs.filter((r) => r.outcome === "win");
  const costs = runs.map((r) => r.costUsd).filter((c): c is number => c !== null);
  return {
    games: runs.length,
    wins: wins.length,
    traps: runs.filter((r) => r.outcome === "lose").length,
    limits: runs.filter((r) => r.outcome === "move_limit").length,
    errors: runs.filter((r) => r.outcome === "error").length,
    avgWinMoves: mean(wins.map((r) => r.moves)),
    avgTurns: mean(runs.map((r) => r.turns)),
    totalCost: costs.length === runs.length ? sum(costs) : null,
  };
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

async function main(): Promise<void> {
  if (!Number.isInteger(RUNS) || RUNS < 1) fail("EVAL_RUNS must be a positive integer.");
  const configs = (process.env.EVAL_AGENTS ?? "classic").split(",").map((text) => {
    try {
      return parseAgentConfig(text);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });
  for (const config of configs) {
    const missing = missingKey(config);
    if (missing) fail(`${agentLabel(config)} needs ${missing} (see .env.example).`);
    if (HIDE_TRAP && config.brain === "jev") fail("jev can't play with HIDE_TRAP=1; drop it from EVAL_AGENTS.");
  }
  const layouts = parseLayouts(process.env.EVAL_LAYOUTS);
  const labels = configs.map(agentLabel);
  const paid = configs.some((c) => c.brain !== "classic");

  console.log(`Eval: ${layouts.length} layouts x ${labels.join(", ")} x ${RUNS} runs, max ${MAX_MOVES} moves, trap ${HIDE_TRAP ? "HIDDEN" : "visible"}, memory off.`);
  for (const config of configs) console.log(`  ${agentLabel(config).padEnd(12)} ${modelFor(config)}`);
  if (paid) console.log(`  Spend brake: stops starting new games past ~${formatCost(MAX_COST_USD)} (MAX_COST_USD).`);
  console.log();

  const cells: Cell[] = layouts.flatMap((layout) => labels.map((agent) => ({ layout, agent, runs: [] as RunScore[] })));
  const cellFor = (layout: Layout, agent: string) => cells.find((c) => c.layout === layout && c.agent === agent)!;
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  let spent = 0;
  let braked = false;

  // Written after EVERY game, so Ctrl+C, a crash or the spend brake never costs
  // the games already paid for. `finished` flips to true only at the end.
  const save = (finished: boolean) =>
    writeFileSync(
      file,
      JSON.stringify(
        { finished, runsPerCell: RUNS, maxMoves: MAX_MOVES, hideTrap: HIDE_TRAP, plannerPrompt: plannerPromptVersion(), agents: labels, models: Object.fromEntries(configs.map((c) => [agentLabel(c), modelFor(c)])), estimatedSpendUsd: spent, cells },
        null,
        2
      )
    );
  save(false);
  console.log(`Saving after every game to ${file}\n`);

  // Pass-major order: one game per (layout, agent) per pass. If the spend
  // brake trips, every layout has had the same number of games (give or take
  // one pass), instead of the last layouts being dropped entirely.
  passes: for (let pass = 1; pass <= RUNS; pass++) {
    for (const layout of layouts) {
      for (const config of configs) {
        if (spent > MAX_COST_USD) {
          braked = true;
          break passes;
        }
        const score = await playOnce(config, layout);
        spent += score.costUsd ?? 0;
        cellFor(layout, agentLabel(config)).runs.push(score);
        save(false);
      }
    }
    console.log(`  pass ${pass}/${RUNS} done, estimated spend so far ${formatCost(spent)}`);
  }
  save(true);
  console.log();

  // Table 1: per layout, one column per agent: "wins/games · avg moves when winning".
  const optimal = new Map(layouts.map((layout) => [layout, optimalMoves(createGrid(layout))]));
  console.log("Scorecard: wins/games, avg moves in won games (opt = shortest possible with the trap known)");
  printTable(
    ["layout", "opt", ...labels],
    layouts.map((layout) => [
      layout,
      String(optimal.get(layout) ?? "-"),
      ...labels.map((label) => {
        const s = summarise(cells.find((c) => c.layout === layout && c.agent === label)?.runs ?? []);
        return s.games === 0 ? "skipped" : `${s.wins}/${s.games} ${s.avgWinMoves === null ? "" : `${fmt(s.avgWinMoves)}mv`}`.trim();
      }),
    ])
  );
  console.log();

  // Table 2: per agent overall. Cost per WIN, not per run: a cheap agent that loses is not cheap.
  console.log("Totals per agent");
  const rows = labels.map((label) => {
    const runs = cells.filter((c) => c.agent === label).flatMap((c) => c.runs);
    const s = summarise(runs);
    const overOptimal = mean(
      cells.filter((c) => c.agent === label).flatMap((c) => c.runs.filter((r) => r.outcome === "win").map((r) => r.moves - (optimal.get(c.layout) ?? r.moves)))
    );
    return [
      label,
      pct(s.wins, s.games),
      pct(s.traps, s.games),
      pct(s.limits, s.games),
      String(s.errors),
      fmt(s.avgWinMoves),
      overOptimal === null ? "-" : `+${fmt(overOptimal)}`,
      fmt(s.avgTurns),
      s.totalCost === null ? "n/a" : formatCost(s.totalCost / Math.max(1, s.games)),
      s.totalCost === null ? "n/a" : s.wins === 0 ? "no wins" : formatCost(s.totalCost / s.wins),
    ];
  });
  printTable(["agent", "win", "trap", "limit", "err", "moves/win", "vs opt", "turns", "$/run", "$/win"], rows);
  if (braked) console.log(`\nStopped early: estimated spend passed ${formatCost(MAX_COST_USD)}. Games not played are not counted above.`);
  if (cells.some((c) => c.runs.some((r) => r.error))) {
    const first = cells.flatMap((c) => c.runs).find((r) => r.error);
    console.log(`\nSome runs errored (counted as "err"), e.g.: ${first?.error}`);
  }

  const failed = cells.flatMap((c) => c.runs.filter((r) => r.trace).map((r) => `${c.layout}/${c.agent}: ${r.outcome}`));
  if (failed.length > 0) console.log(`\nTraces kept for ${failed.length} non-winning game(s): ${failed.join(", ")}`);
  console.log(`\nResults written to ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
