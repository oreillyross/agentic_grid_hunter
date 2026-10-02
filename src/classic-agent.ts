// classic-agent.ts — the cost-effective baseline: no model at all.
//
// Everything else in this repo asks a model to decide the next move. This
// agent decides it with BFS (solver.ts), so a run costs $0, takes microseconds,
// gives the same answer every time, and never steps on the trap. It is the
// yardstick the LLM agents should be measured against in the Stage 5 eval:
// if an LLM agent can't beat this on cost AND match it on wins, the LLM is
// not earning its place on this task.
//
// It is also the proof of the "model decides WHAT, code does HOW" idea: the
// whole run is two tool calls — navigate_to(treasure), then pickup — through
// the same `executeTool` and `TraceStep` machinery the LLM agents use. That is
// roughly what a 12-turn Claude run collapses to when it is handed navigate_to.
//
// Select it with `AGENT=classic`.

import { type GridState, type Position, renderGrid } from "./grid.js";
import { executeTool } from "./tools.js";
import type { RunResult, TraceStep } from "./agent.js";
import { emptyUsage } from "./usage.js";

export interface ClassicOptions {
  hideTrap?: boolean;
  /** A trap position from long-term memory, if any. */
  rememberedTrap?: Position | null;
}

export function runClassicLoop(state: GridState, maxMoves: number, options: ClassicOptions = {}): RunResult {
  const hideTrap = options.hideTrap === true;
  const trace: TraceStep[] = [];
  const discovered: Position[] = [];
  let moveCount = 0;

  // Same rule as the LLM agents: only use the trap's position if it is drawn
  // on the grid or was remembered. Under fog of war the walker has to look.
  const baseHazards = hideTrap ? (options.rememberedTrap ? [options.rememberedTrap] : []) : [state.trap];

  const actions = [
    { tool: "navigate_to", input: { row: state.treasure.row, col: state.treasure.col }, plan: "BFS shortest path to the treasure, avoiding known hazards; look before each step if the trap is hidden." },
    { tool: "pickup", input: { item: "treasure" }, plan: "Standing on the treasure: pick it up." },
  ];

  for (const [index, action] of actions.entries()) {
    const { resultText, outcome, moves, discoveredHazards } = executeTool(state, action.tool, action.input, {
      knownHazards: [...baseHazards, ...discovered],
      hideTrap,
      movesLeft: maxMoves - moveCount,
    });
    moveCount += moves ?? 0;
    discovered.push(...(discoveredHazards ?? []));

    console.log(`[turn ${index + 1}, move ${moveCount}/${maxMoves}] classic: ${action.plan}`);
    console.log(`  ${action.tool}(${JSON.stringify(action.input)}) -> ${resultText}`);
    console.log(renderGrid(state));
    console.log();

    trace.push({
      turn: index + 1,
      plan: action.plan,
      action: { tool: action.tool, input: action.input },
      result: resultText,
      outcome,
      moveCount,
      gridAfter: renderGrid(state),
    });

    const discoveredTrap = discovered[0];
    if (outcome === "win") return { outcome: "win", moveCount, trace, discoveredTrap, usage: emptyUsage(), costUsd: 0 };
    if (outcome === "lose") return { outcome: "lose", moveCount, trace, discoveredTrap, usage: emptyUsage(), costUsd: 0 };
    // navigate_to stopping short (unreachable, or out of moves) means pickup can't succeed either.
    if (action.tool === "navigate_to" && outcome === "ok" && !(state.player.row === state.treasure.row && state.player.col === state.treasure.col)) break;
  }
  return { outcome: "move_limit", moveCount, trace, discoveredTrap: discovered[0], usage: emptyUsage(), costUsd: 0 };
}
