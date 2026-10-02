// planner-agent.ts — Stage 6: planner / executor split.
//
// FIRST PRINCIPLES: "multi-agent" is not a new mechanism. It is two prompts
// with two jobs and a message format between them. Here:
//
//   PLANNER   sees the whole picture (grid, memory, scratchpad), makes NO tool
//             calls, and writes a short strategy. Not per-move: "go around the
//             trap on the north side".
//   EXECUTOR  is the Stage 3/4 loop in agent.ts, unchanged except that the
//             planner's strategy is pasted into its system prompt. It picks
//             every actual tool call.
//
// THE HANDOFF CONTRACT (the part worth reading):
//
//   planner -> executor : one `<strategy>` text block, max ~3 sentences, naming
//                         the route, any hazard to avoid, and when to look().
//                         Lands in the executor's system prompt, and is re-read
//                         before every executor API call.
//   executor -> planner : an `ExecutorReport` (agent.ts) — reason, turn, move
//                         count, position, hazards found, last 3 turns — sent
//                         after every CHECKPOINT_EVERY turns and immediately
//                         when a NEW hazard is found. The planner replies with
//                         a revised `<strategy>` (or repeats the old one).
//
// Nothing else crosses the boundary. The planner never sees the executor's
// conversation, and the executor never sees the planner's reasoning.
//
// What to look for in the eval: this costs MORE than a single agent (two
// models, an extra call or two per run). It only pays off if the strategy
// measurably cuts wasted moves or trap hits. On a 5x5 grid it probably will not
// — a useful result in itself. Splitting roles buys you a cheaper executor
// (Haiku) steered by a smarter planner (Sonnet), not free intelligence.

import type Anthropic from "@anthropic-ai/sdk";
import { type GridState, renderGrid, describePositions } from "./grid.js";
import { runAgentLoop, type AgentMemoryOptions, type ExecutorReport, type RunResult } from "./agent.js";
import { createScratchpad, renderScratchpad } from "./memory.js";
import { addUsage, emptyUsage, estimateCostUsd, fromApiUsage, type Usage } from "./usage.js";

/** Executor reports back this often even when nothing went wrong. */
export const CHECKPOINT_EVERY = 4;

const PLANNER_SYSTEM_PROMPT = `You are the PLANNER in a two-agent team playing a grid-world treasure hunt. A separate EXECUTOR agent makes every actual move; you never act.
Rows and columns are 0-indexed; row 0 is the top. The executor can move(direction), look() at adjacent cells, and pickup("treasure"). Stepping on the trap loses. Reaching the treasure only wins after pickup.

Write a SHORT strategy for the executor: at most three sentences, no per-move instructions. Say which general route to take, which hazard to avoid and how, and when to look() before stepping. If a hazard is hidden, say where it is probably NOT, or tell the executor to look() when near unexplored cells.

Reply with only: <strategy>...</strategy>`;

const STRATEGY_PATTERN = /<strategy>([\s\S]*?)<\/strategy>/i;

interface PlannerCall {
  client: Anthropic;
  model: string;
  usage: Usage;
}

async function askPlanner(call: PlannerCall, userText: string, fallback: string): Promise<string> {
  const response = await call.client.messages.create({
    model: call.model,
    max_tokens: 400,
    system: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
  });
  addUsage(call.usage, fromApiUsage(response.usage));
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const inner = text.match(STRATEGY_PATTERN)?.[1]?.trim() ?? text.trim();
  return inner.length > 0 ? inner : fallback;
}

export interface PlannerExecutorModels {
  planner: string;
  executor: string;
}

/**
 * Runs one game with a planner steering an executor. Same contract as
 * `runAgentLoop`; the result's `usage` is the executor's, and `costUsd` adds
 * the planner's tokens at the planner model's price.
 */
export async function runPlannerExecutorLoop(
  client: Anthropic,
  models: PlannerExecutorModels,
  state: GridState,
  maxMoves: number,
  options: AgentMemoryOptions = {}
): Promise<RunResult> {
  const view = { hideTrap: options.hideTrap };
  const planner: PlannerCall = { client, model: models.planner, usage: emptyUsage() };
  const strategy = { text: "" };

  const initialContext = [
    renderGrid(state, view),
    describePositions(state, view),
    options.longTerm ? `Long-term memory: ${options.longTerm}` : null,
    `Move budget: ${maxMoves}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  strategy.text = await askPlanner(planner, `${initialContext}\n\nWrite the opening strategy.`, "Head for the treasure; look() before stepping near anything unknown.");
  console.log(`[planner] opening strategy: ${strategy.text}\n`);

  const checkpoint = async (report: ExecutorReport): Promise<void> => {
    const pad = createScratchpad(state);
    pad.hazards = report.hazards;
    const message = [
      renderGrid(state, view),
      `Current strategy: ${strategy.text}`,
      `The executor reports (${report.reason === "hazard" ? "it just found a hazard" : "periodic check-in"}): turn ${report.turn}, ${report.moveCount}/${maxMoves} moves used, now at (row ${report.player.row}, col ${report.player.col}).`,
      renderScratchpad(pad).split("\n")[1] ?? "",
      `Recent turns:\n${report.recent.join("\n")}`,
      "Revise the strategy if it needs to change, or repeat it.",
    ].join("\n\n");
    strategy.text = await askPlanner(planner, message, strategy.text);
    console.log(`[planner] revised after ${report.reason} (turn ${report.turn}): ${strategy.text}\n`);
  };

  const result = await runAgentLoop(client, models.executor, state, maxMoves, {
    ...options,
    strategy,
    checkpoint,
    checkpointEvery: CHECKPOINT_EVERY,
  });

  const executorCost = result.usage ? estimateCostUsd(models.executor, result.usage) : null;
  const plannerCost = estimateCostUsd(models.planner, planner.usage);
  const costUsd = executorCost === null || plannerCost === null ? null : executorCost + plannerCost;
  return { ...result, costUsd };
}
