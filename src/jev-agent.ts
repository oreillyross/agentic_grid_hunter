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
import {
  type GridState,
  type Direction,
  type Position,
  DIRECTION_OFFSETS,
  renderGrid,
  describePositions,
  samePosition,
  inBounds,
  cellAt,
} from "./grid.js";
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

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

function stepFrom(pos: Position, direction: Direction): Position {
  const { dRow, dCol } = DIRECTION_OFFSETS[direction];
  return { row: pos.row + dRow, col: pos.col + dCol };
}

/**
 * What a move in each direction would land on. Precomputed so Jev's
 * `direction` question is a lookup, not coordinate arithmetic it can get
 * wrong in a single forward pass.
 */
function nextCellByDirection(state: GridState): Record<Direction, string> {
  const result = {} as Record<Direction, string>;
  for (const direction of DIRECTIONS) {
    const next = stepFrom(state.player, direction);
    result[direction] = inBounds(state, next) ? cellAt(state, next) : "edge";
  }
  return result;
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
    next_cell_by_direction: nextCellByDirection(state),
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

/**
 * Deterministic safety net: probabilities can't catch a confidently-wrong
 * move, so code vetoes any step onto the trap. Picks the safe in-bounds
 * direction that ends closest to the treasure (Manhattan distance).
 */
function safeDirectionInstead(state: GridState): Direction | null {
  const distance = (p: Position) =>
    Math.abs(p.row - state.treasure.row) + Math.abs(p.col - state.treasure.col);
  const candidates = DIRECTIONS.map((direction) => ({ direction, next: stepFrom(state.player, direction) }))
    .filter(({ next }) => inBounds(state, next) && !samePosition(next, state.trap))
    .sort((a, b) => distance(a.next) - distance(b.next));
  return candidates[0]?.direction ?? null;
}

/** Turns a decision into the (tool, input) pair `executeTool` understands. */
function toAction(
  decision: JevDecision,
  state: GridState
): { tool: string; input: unknown; vetoed?: boolean } {
  if (decision.abstained) return { tool: "look", input: {} };
  switch (decision.tool.label) {
    case "move": {
      const next = stepFrom(state.player, decision.direction.label);
      if (!inBounds(state, next) || samePosition(next, state.trap)) {
        const safe = safeDirectionInstead(state);
        return safe
          ? { tool: "move", input: { direction: safe }, vetoed: true }
          : { tool: "look", input: {}, vetoed: true };
      }
      return { tool: "move", input: { direction: decision.direction.label } };
    }
    case "pickup":
      return { tool: "pickup", input: { item: "treasure" } };
    default:
      return { tool: "look", input: {} };
  }
}

/** Overrides an abstain/look with the action that makes progress: pickup if on the treasure, else a move. */
function forceAct(decision: JevDecision, state: GridState): JevDecision {
  const label = samePosition(state.player, state.treasure) ? "pickup" : "move";
  return { ...decision, tool: { ...decision.tool, label }, abstained: false };
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
    let step = toAction(decision, state);

    // `look` is deterministic: a second one in a row (abstained or chosen)
    // returns the identical answer and changes nothing, so Jev would just
    // repeat it until the turn cap. Break the loop with a guarded move.
    const stalled = step.tool === "look" && trace[trace.length - 1]?.action.tool === "look";
    if (stalled) step = toAction(forceAct(decision, state), state);

    const { vetoed, ...action } = step;

    const { resultText, outcome } = executeTool(state, action.tool, action.input);
    if (action.tool === "move") moveCount++;
    turn++;

    const notes: string[] = [];
    if (stalled) notes.push("STALLED: repeated look() adds no info, forcing a guarded move");
    if (vetoed) notes.push("VETOED: move would hit the trap or the edge, overridden by guard");
    const plan = [describeDecision(decision), ...notes].join(" -> ");
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
