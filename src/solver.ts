// solver.ts — the classic, zero-token way to play this game.
//
// FIRST PRINCIPLES: a grid with obstacles and a target is an implicit graph.
// Cells are nodes, legal moves are edges. If you can write the state as a type
// (`GridState`) and the transition as a pure function (`movePlayer`), the
// problem belongs in code: a few dozen lines of BFS solve it deterministically,
// in microseconds, for $0. Everything the LLM agents in this repo do — the
// plan, the scratchpad, the look() before every step — is a slow, expensive,
// lossy reimplementation of this file.
//
// Which search, when:
//   - BFS finds the shortest path, but only over a map you already know.
//   - DFS (visited set + backtracking) is the right tool when the map is
//     UNKNOWN and an embodied agent has to physically walk it, because it
//     never strays far from where it already is.
//   - Here the treasure's position is always given and the only unknown is the
//     (possibly hidden) trap, which `look()` reveals one step ahead. So there
//     is nothing to explore for: BFS toward the target, re-planned whenever a
//     hazard is discovered, is enough. If the target were also unknown you'd
//     explore with DFS first, then BFS (or A*) once you'd seen it.
//
// An LLM earns its place when the input is unstructured, the goal is
// ambiguous, or the action space can't be enumerated. None is true here, which
// is exactly why this is a *teaching* domain and a bad place to spend tokens.
// In real products the two combine: the model decides WHAT to do, deterministic
// tools do the HOW. `walkTo` below is that tool — see `navigate_to` in tools.ts.

import {
  type Direction,
  type GridState,
  type Position,
  DIRECTION_OFFSETS,
  cellAt,
  inBounds,
  movePlayer,
  samePosition,
} from "./grid.js";

const DIRECTIONS = Object.keys(DIRECTION_OFFSETS) as Direction[];

const key = (pos: Position) => `${pos.row},${pos.col}`;

/**
 * Breadth-first search from `from` to `to` over in-bounds cells, never
 * entering a cell in `avoid`. Returns the moves along a shortest path, `[]` if
 * already there, or `null` if the target can't be reached.
 *
 * Pure: reads `state.size` only, never mutates anything.
 */
export function shortestPath(
  state: GridState,
  from: Position,
  to: Position,
  avoid: readonly Position[] = []
): Direction[] | null {
  const blocked = new Set(avoid.map(key));
  if (blocked.has(key(to))) return null;

  // cameFrom remembers, for each visited cell, how we first reached it. That
  // doubles as the visited set and lets us rebuild the path backwards.
  const cameFrom = new Map<string, { prev: string; move: Direction } | null>([[key(from), null]]);
  const queue: Position[] = [from];

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    if (samePosition(cell, to)) {
      const moves: Direction[] = [];
      for (let step = cameFrom.get(key(cell)); step; step = cameFrom.get(step.prev)) moves.push(step.move);
      return moves.reverse();
    }
    for (const move of DIRECTIONS) {
      const { dRow, dCol } = DIRECTION_OFFSETS[move];
      const next = { row: cell.row + dRow, col: cell.col + dCol };
      if (!inBounds(state, next) || blocked.has(key(next)) || cameFrom.has(key(next))) continue;
      cameFrom.set(key(next), { prev: key(cell), move });
      queue.push(next);
    }
  }
  return null;
}

/** Length of the best possible route to the treasure with the trap known: the eval's ground truth. */
export function optimalMoves(state: GridState): number | null {
  return shortestPath(state, state.player, state.treasure, [state.trap])?.length ?? null;
}

export interface WalkOptions {
  /** Hazards the agent already knows about; never entered. */
  hazards: readonly Position[];
  /** Fog of war: the trap is only discovered by looking at adjacent cells. */
  hideTrap: boolean;
  /** Stop after this many steps even if not there yet. */
  maxSteps: number;
}

export interface WalkResult {
  status: "arrived" | "blocked" | "out_of_moves" | "lost";
  steps: number;
  /** Cells entered, in order. */
  visited: Position[];
  /** Hazards found by looking along the way. */
  discoveredHazards: Position[];
}

/**
 * Walks the player to `target` the way a robot would: plan with BFS, take one
 * step, and — under fog of war — look at the neighbours before every step,
 * re-planning around anything newly discovered. Mutates `state`.
 *
 * The look is free (it adds no move), so a hidden trap can't hurt a walker
 * that starts the step from a cell adjacent to it: it is seen before it is
 * entered. That is the property the LLM agents have to be *taught* by prompt.
 */
export function walkTo(state: GridState, target: Position, options: WalkOptions): WalkResult {
  const hazards = [...options.hazards];
  const result: WalkResult = { status: "arrived", steps: 0, visited: [], discoveredHazards: [] };

  while (!samePosition(state.player, target)) {
    if (options.hideTrap) {
      for (const move of DIRECTIONS) {
        const { dRow, dCol } = DIRECTION_OFFSETS[move];
        const neighbour = { row: state.player.row + dRow, col: state.player.col + dCol };
        if (inBounds(state, neighbour) && cellAt(state, neighbour) === "trap" && !hazards.some((h) => samePosition(h, neighbour))) {
          hazards.push(neighbour);
          result.discoveredHazards.push(neighbour);
        }
      }
    }

    if (result.steps >= options.maxSteps) return { ...result, status: "out_of_moves" };

    const path = shortestPath(state, state.player, target, hazards);
    if (!path || path.length === 0) return { ...result, status: "blocked" };

    const { landedOn } = movePlayer(state, path[0]!);
    result.steps++;
    result.visited.push({ ...state.player });
    if (landedOn === "trap") return { ...result, status: "lost" };
  }
  return result;
}
