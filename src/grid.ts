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
}

/** Two positions are equal if their row AND col both match. */
function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col;
}

/**
 * Builds a hand-placed, fixed grid layout.
 *
 * Stage 1's acceptance criteria just needs "a grid" — no randomness, no
 * config. Hardcoding a layout here keeps Stage 1 boring on purpose: the goal
 * is proving the round-trip (state -> text -> model -> text), not building a
 * level generator. A random/seeded generator is a natural thing to add once
 * Stage 5 needs a fixed set of eval fixtures — don't build it before you
 * need it.
 */
export function createGrid(): GridState {
  const size = 5;
  const player: Position = { row: 4, col: 0 }; // bottom-left corner
  const treasure: Position = { row: 0, col: 4 }; // top-right corner
  const trap: Position = { row: 2, col: 2 }; // dead center

  return { size, player, treasure, trap };
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
export function renderGrid(state: GridState): string {
  const rows: string[] = [];

  for (let row = 0; row < state.size; row++) {
    const cells: string[] = [];
    for (let col = 0; col < state.size; col++) {
      const pos: Position = { row, col };
      if (samePosition(pos, state.player)) {
        cells.push("P");
      } else if (samePosition(pos, state.treasure)) {
        cells.push("T");
      } else if (samePosition(pos, state.trap)) {
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
export function describePositions(state: GridState): string {
  const { player, treasure, trap } = state;
  return [
    `Grid size: ${state.size}x${state.size} (rows and cols are 0-indexed, row 0 is the top).`,
    `Player is at (row ${player.row}, col ${player.col}).`,
    `Treasure is at (row ${treasure.row}, col ${treasure.col}).`,
    `Trap is at (row ${trap.row}, col ${trap.col}).`,
  ].join("\n");
}
