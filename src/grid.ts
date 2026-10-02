// grid.ts — the environment.
//
// FIRST PRINCIPLES: an "agent" is just a loop that (1) perceives some state,
// (2) decides on an action, (3) has that action change the state, repeat.
// Before any of that can exist we need a *state* — something the agent can
// perceive and act on. That's all this file is: a tiny, fully deterministic
// world. Deterministic on purpose — later stages need ground truth (did the
// agent actually win? in how many moves?) and you can't score an agent
// against a world that behaves differently each time you ask it the same
// question.
//
// Stage 1 doesn't need any of the *acting* part yet (that's Stage 2's tool
// calls). All Stage 1 needs is: build a state, and turn it into text a model
// can read. Everything below is written with that ceiling in mind — no
// movement rules, no collision handling, just the world and its description.

/** A single cell coordinate. (0, 0) is the top-left corner of the grid. */
export interface Position {
  row: number;
  col: number;
}

/**
 * The entire game state. This is intentionally a plain data object (no
 * classes, no methods) — an LLM-driven agent never touches this object
 * directly. It only ever sees a *text description* of it (see `renderGrid`
 * below) and, from Stage 2 onward, changes it indirectly through tool
 * calls. Keeping state as plain data makes that boundary obvious: the model
 * can't reach in and mutate `player.row` itself, it can only ask a tool to
 * do it, and the tool is code we control.
 */
export interface GridState {
  size: number; // grid is `size` x `size`, e.g. 5 means a 5x5 board
  player: Position;
  treasure: Position;
  trap: Position;
  // Stage 2: the win condition is *picking up* the treasure via the
  // `pickup` tool, not merely walking onto its cell (see tools.ts) — so the
  // state needs to track whether that's happened yet.
  treasureCollected: boolean;
}

/**
 * What the *agent* is allowed to see. `hideTrap` models fog of war (Stage 4):
 * the world is unchanged, but the trap is left out of what we render, so the
 * agent can only learn where it is by `look()`ing or by stepping on it. That
 * hidden fact is what gives long-term memory something to remember.
 */
export interface ViewOptions {
  hideTrap?: boolean;
}

/** Two positions are equal if their row AND col both match. */
export function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col;
}

/**
 * The fixed layout set (Stage 5's eval fixtures). Each is hand-placed and
 * deterministic so a win rate means something: the same layout always poses
 * the same problem. Players start where they are listed; `size` defaults to 5.
 *
 * What each one tests, roughly in order of difficulty for a naive agent:
 *  - easy / adjacent / straight: trap is nowhere near the path.
 *  - diagonal / corridor: trap near the middle, plenty of ways around it.
 *  - hard: trap sits on the shortest straight-line path (Stage 3's layout).
 *  - trap_at_start: trap touches the player, so the first moves matter.
 *  - guarded_treasure: trap touches the treasure, one approach is fatal.
 *  - squeeze: trap and treasure share a corner region.
 *  - big_7x7: bigger board, more room to wander and run out of moves.
 */
export const LAYOUTS = {
  easy: { player: [4, 0], treasure: [0, 4], trap: [2, 2] },
  adjacent: { player: [2, 2], treasure: [2, 3], trap: [0, 0] },
  straight: { player: [0, 0], treasure: [0, 4], trap: [4, 4] },
  diagonal: { player: [0, 0], treasure: [4, 4], trap: [2, 2] },
  corridor: { player: [2, 0], treasure: [2, 4], trap: [2, 2] },
  hard: { player: [4, 0], treasure: [4, 4], trap: [4, 2] },
  trap_at_start: { player: [4, 0], treasure: [0, 4], trap: [3, 0] },
  guarded_treasure: { player: [4, 4], treasure: [0, 0], trap: [0, 1] },
  squeeze: { player: [0, 0], treasure: [2, 2], trap: [1, 2] },
  big_7x7: { player: [6, 0], treasure: [0, 6], trap: [3, 3], size: 7 },
} as const satisfies Record<
  string,
  { player: readonly [number, number]; treasure: readonly [number, number]; trap: readonly [number, number]; size?: number }
>;

/** Which hand-placed layout to build — see `LAYOUTS` and `createGrid`. */
export type Layout = keyof typeof LAYOUTS;

export const LAYOUT_NAMES = Object.keys(LAYOUTS) as Layout[];

export function isLayout(name: string): name is Layout {
  return Object.hasOwn(LAYOUTS, name);
}

const toPosition = ([row, col]: readonly [number, number]): Position => ({ row, col });

/**
 * Builds a fresh grid from a named fixture.
 *
 * Stage 1's acceptance criteria just needs "a grid" — no randomness, no
 * config. Hardcoding layouts keeps things boring on purpose: the goal is
 * proving the round-trip (state -> text -> model -> text), not building a
 * level generator. Stage 5 grew the table to ten fixtures so the eval harness
 * has a fixed set to score against.
 *
 * "easy" (the Stage 2 default) keeps the trap off the direct path so a
 * naive agent can stumble into a win. "hard" is Stage 3's layout: the trap
 * sits directly between player and treasure on the shortest path, so the
 * plan text actually has to explain a detour instead of just narrating a
 * straight line.
 */
export function createGrid(layout: Layout = "easy"): GridState {
  const fixture: { player: readonly [number, number]; treasure: readonly [number, number]; trap: readonly [number, number]; size?: number } = LAYOUTS[layout];
  return {
    size: fixture.size ?? 5,
    player: toPosition(fixture.player),
    treasure: toPosition(fixture.treasure),
    trap: toPosition(fixture.trap),
    treasureCollected: false,
  };
}

/**
 * Renders the grid as a text block, e.g. for a 5x5 board:
 *
 *   . . . . T
 *   . . . . .
 *   . . X . .
 *   . . . . .
 *   P . . . .
 *
 * Where P = player, T = treasure, X = trap, . = empty.
 *
 * WHY TEXT: a language model has no eyes and no access to our in-memory
 * `GridState` object — its only input is a sequence of tokens. If we want it
 * to reason about "is the treasure to my left or right," the grid has to be
 * serialized into something it can read, the same way you'd describe a
 * chessboard over the phone. This function is that serialization. Getting
 * this representation right (something the model can read *and* that
 * matches how you're about to explain the coordinate system in the system
 * prompt) is most of the work in a text-only agent — garbage-in-garbage-out
 * applies to the *rendering*, not just the prompt wording.
 */
export function renderGrid(state: GridState, options: ViewOptions = {}): string {
  const rows: string[] = [];

  for (let row = 0; row < state.size; row++) {
    const cells: string[] = [];
    for (let col = 0; col < state.size; col++) {
      const pos: Position = { row, col };
      if (samePosition(pos, state.player)) {
        cells.push("P");
      } else if (samePosition(pos, state.treasure)) {
        cells.push("T");
      } else if (!options.hideTrap && samePosition(pos, state.trap)) {
        cells.push("X");
      } else {
        cells.push(".");
      }
    }
    rows.push(cells.join(" "));
  }

  return rows.join("\n");
}

/**
 * Renders the same state as plain-English coordinates instead of an ASCII
 * grid, e.g. "Player is at (row 4, col 0). Treasure is at (row 0, col 4)."
 *
 * Why have both this and `renderGrid`? They're two different bets on how
 * the model reasons best: some models do better with a visual-ish grid they
 * can "look at" row by row, others do better with explicit coordinates they
 * can do arithmetic on directly (row 0 < row 4, so treasure is "up"). Stage
 * 1 sends both in the prompt so you can literally read the model's reply
 * and see which framing it actually leaned on.
 */
export function describePositions(state: GridState, options: ViewOptions = {}): string {
  const { player, treasure, trap } = state;
  const lines = [
    `Grid size: ${state.size}x${state.size} (rows and cols are 0-indexed, row 0 is the top).`,
    `Player is at (row ${player.row}, col ${player.col}).`,
    `Treasure is at (row ${treasure.row}, col ${treasure.col}).`,
  ];
  if (!options.hideTrap) lines.push(`Trap is at (row ${trap.row}, col ${trap.col}).`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stage 2 additions below. Stage 1 only ever needed to *describe* a state.
// Stage 2 needs to *change* it — the model picks a tool, we execute it
// against this state, and the result gets fed back. Everything below is the
// "rules of the world" half of that: what a move does, what's next to you.
// The "what does the model actually do" half lives in tools.ts and agent.ts.
// ---------------------------------------------------------------------------

/** The four directions the `move` tool accepts. Walls are out of scope for
 * Stage 2 (see README), so movement is unobstructed except by the grid's
 * own edge. */
export type Direction = "up" | "down" | "left" | "right";

export const DIRECTION_OFFSETS: Record<Direction, { dRow: number; dCol: number }> = {
  up: { dRow: -1, dCol: 0 },
  down: { dRow: 1, dCol: 0 },
  left: { dRow: 0, dCol: -1 },
  right: { dRow: 0, dCol: 1 },
};

/** True if `pos` falls within the grid's bounds. */
export function inBounds(state: GridState, pos: Position): boolean {
  return (
    pos.row >= 0 && pos.row < state.size && pos.col >= 0 && pos.col < state.size
  );
}

/** What's at a given cell — used by `look()` to describe a neighboring cell
 * without handing the model the raw `GridState` object (see the comment on
 * `GridState` above for why that boundary matters). */
export type CellContent = "player" | "treasure" | "trap" | "empty";

export function cellAt(state: GridState, pos: Position): CellContent {
  if (samePosition(pos, state.player)) return "player";
  if (samePosition(pos, state.treasure)) return "treasure";
  if (samePosition(pos, state.trap)) return "trap";
  return "empty";
}

export interface MoveOutcome {
  /** false if the move was blocked (only possible cause right now: the
   * grid's edge — there are no walls yet). */
  moved: boolean;
  /** What the player is standing on *after* the move (or still standing on,
   * if the move was blocked). Deliberately never "player" — that would be a
   * category error, this describes the ground under them, not them. */
  landedOn: Exclude<CellContent, "player">;
}

/**
 * Moves `state.player` one cell in `direction`, if that stays in bounds.
 *
 * This mutates `state` in place rather than returning a new `GridState`.
 * That's a deliberate simplification, not an oversight: the agent loop in
 * agent.ts owns exactly one `GridState` for the whole run and nothing else
 * touches it concurrently, so there's no shared-mutable-state hazard here
 * to design around. A React app or a multiplayer server would need
 * immutable updates; a single-threaded CLI loop doesn't.
 */
export function movePlayer(state: GridState, direction: Direction): MoveOutcome {
  const { dRow, dCol } = DIRECTION_OFFSETS[direction];
  const next: Position = { row: state.player.row + dRow, col: state.player.col + dCol };

  if (!inBounds(state, next)) {
    // Blocked by the edge: player doesn't move, so "what they're standing
    // on" is unchanged and is by definition not the treasure or trap
    // (those aren't co-located with the player already).
    return { moved: false, landedOn: "empty" };
  }

  // Figure out what's on the destination cell *before* moving the player
  // onto it — once `state.player` becomes `next`, samePosition(next,
  // state.player) would trivially be true and we'd lose the ability to
  // tell "empty" from "treasure" or "trap".
  const landedOn: Exclude<CellContent, "player"> = samePosition(next, state.treasure)
    ? "treasure"
    : samePosition(next, state.trap)
    ? "trap"
    : "empty";

  state.player = next;
  return { moved: true, landedOn };
}
