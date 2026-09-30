// jev-agent.ts — the agent loop, driven by TypeSafe Jev instead of Claude.
//
// FIRST PRINCIPLES: Claude's loop (agent.ts) asks a *generative* model "what
// do you want to do?" and gets free text plus a tool_use block back. Jev is a
// different kind of model: it never generates text or calls tools. You hand it
// a state and typed questions, and it returns a probability over a fixed set
// of labels per question (a `Choice`). So "which tool next?" stops being a
// generation problem and becomes a classification problem:
//
//   state --> Choice(tool: move|look|pickup)        --> label + probabilities
//         \-> Choice(direction: up|down|left|right) -/
//
// Our code then does what it always did — validate, execute, feed the result
// back — but it now has something a chat model doesn't give you for free: a
// number saying how sure the decision was. We use it (see MIN_PROBABILITY)
// to abstain instead of acting on a coin-flip. Jev is stateless, so memory
// of earlier turns has to ride along inside `state` every call.

import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { type GridState, type Direction, renderGrid, describePositions, samePosition } from "./grid.js";
import { executeTool } from "./tools.js";
import type { RunResult, TraceStep } from "./agent.js";

/**
 * Below this top-label probability we don't trust the decision and fall back
 * to the safe, free action (`look`). This mirrors the 0.60 abstain rule from
 * TypeSafe's consistency cookbook: near a coin-flip the top label can change
 * between identical calls, so acting on it is acting on noise. It's an
 * illustrative policy, not a calibrated one — tune it with Stage 5 evals.
 */
export const MIN_PROBABILITY = 0.6;

/** How many past turns are replayed into `state` (Jev keeps no memory). */
const HISTORY_WINDOW = 6;

/** `look` is free (doesn't spend a move), so an abstaining agent could spin
 * forever; cap total turns at this multiple of the move budget. */
const TURN_CAP_FACTOR = 4;

const QUESTIONS = {
  tool: choice("Which tool should the agent call on this turn to win the game?", {
    move: "Step one cell. Choose when the next cell toward the treasure is known to be safe.",
    look: "Inspect the four adjacent cells without moving. Choose when unsure what is next to the player.",
    pickup: "Pick up the treasure. Choose ONLY when the player is standing on the treasure's cell.",
  }),
  direction: choice(
    "If the agent moves this turn, which direction gets it closer to the treasure without stepping on the trap or off the grid?",
    {
      up: "Toward row 0 (the top edge).",
      down: "Toward the last row (the bottom edge).",
      left: "Toward col 0 (the left edge).",
      right: "Toward the last col (the right edge).",
    }
  ),
} as const;

/** One decision: the labels Jev picked, and how sure it was of each. */
export interface JevDecision {
  tool: { label: "move" | "look" | "pickup"; probability: number };
  direction: { label: Direction; probability: number };
  abstained: boolean;
}

/**
 * Builds the state object Jev judges. Everything Jev should reason about
 * must be here — it sees nothing else. `history` is the stand-in for the
 * message array Claude's loop keeps.
 */
function buildState(state: GridState, trace: TraceStep[], maxMoves: number, moveCount: number) {
  return {
    legend: "P=player, T=treasure, X=trap, .=empty. Rows/cols 0-indexed; row 0 is the top.",
    grid: renderGrid(state),
    positions: describePositions(state),
    player_is_on_treasure: samePosition(state.player, state.treasure),
    moves_left: maxMoves - moveCount,
    recent_history: trace.slice(-HISTORY_WINDOW).map((step) => ({
      action: `${step.action.tool}(${JSON.stringify(step.action.input)})`,
      result: step.result,
    })),
  };
}

/** Asks Jev both questions in one round trip and applies the abstain rule. */
export async function decide(
  client: TypeSafeClient,
  state: GridState,
  trace: TraceStep[],
  maxMoves: number,
  moveCount: number
): Promise<JevDecision> {
  const { answers } = await client.systemOne({
    state: buildState(state, trace, maxMoves, moveCount),
    questions: QUESTIONS,
  });

  // Threshold on the probability of the picked label, NOT on the separate
  // `confidence` field — the cookbook measures and recommends probabilities.
  const toolProbability = answers.tool.probabilities[answers.tool.choice];
  const directionProbability = answers.direction.probabilities[answers.direction.choice];

  // The direction question only matters if we're moving, so only a shaky
  // direction abstains a `move`; a shaky tool abstains everything.
  const abstained =
    toolProbability < MIN_PROBABILITY ||
    (answers.tool.choice === "move" && directionProbability < MIN_PROBABILITY);

  return {
    tool: { label: answers.tool.choice, probability: toolProbability },
    direction: { label: answers.direction.choice, probability: directionProbability },
    abstained,
  };
}

/** Turns a decision into the (tool, input) pair `executeTool` understands. */
function toAction(decision: JevDecision): { tool: string; input: unknown } {
  if (decision.abstained) return { tool: "look", input: {} };
  switch (decision.tool.label) {
    case "move":
      return { tool: "move", input: { direction: decision.direction.label } };
    case "pickup":
      return { tool: "pickup", input: { item: "treasure" } };
    default:
      return { tool: "look", input: {} };
  }
}

/** One-line audit string for the trace; replaces Claude's `<plan>` text. */
function describeDecision(decision: JevDecision): string {
  const pct = (p: number) => p.toFixed(2);
  const base = `tool=${decision.tool.label} (${pct(decision.tool.probability)}), direction=${decision.direction.label} (${pct(decision.direction.probability)})`;
  return decision.abstained
    ? `${base} -> below ${MIN_PROBABILITY} threshold, abstained: falling back to look()`
    : base;
}

/**
 * Runs the loop to completion, same contract as `runAgentLoop`: mutates
 * `state`, returns outcome + trace. Differences: no conversation history to
 * maintain (Jev is stateless), and the per-turn "plan" is the decision's
 * probabilities rather than model-written prose.
 */
export async function runJevLoop(
  client: TypeSafeClient,
  state: GridState,
  maxMoves: number
): Promise<RunResult> {
  let moveCount = 0;
  let turn = 0;
  const trace: TraceStep[] = [];
  const turnCap = maxMoves * TURN_CAP_FACTOR;

  while (turn < turnCap) {
    const decision = await decide(client, state, trace, maxMoves, moveCount);
    const action = toAction(decision);

    const { resultText, outcome } = executeTool(state, action.tool, action.input);
    if (action.tool === "move") moveCount++;
    turn++;

    const plan = describeDecision(decision);
    console.log(`[turn ${turn}, move ${moveCount}/${maxMoves}] jev: ${plan}`);
    console.log(`  ${action.tool}(${JSON.stringify(action.input)}) -> ${resultText}`);
    console.log(renderGrid(state));
    console.log();

    trace.push({
      turn,
      plan,
      action,
      result: resultText,
      outcome,
      moveCount,
      gridAfter: renderGrid(state),
    });

    if (outcome === "win") return { outcome: "win", moveCount, trace };
    if (outcome === "lose") return { outcome: "lose", moveCount, trace };
    if (moveCount >= maxMoves) return { outcome: "move_limit", moveCount, trace };
  }

  // Turn cap hit (e.g. Jev kept abstaining): report it as a move-limit loss.
  return { outcome: "move_limit", moveCount, trace };
}
