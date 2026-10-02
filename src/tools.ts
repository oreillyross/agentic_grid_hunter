// tools.ts — Stage 2: tool definitions + executors.
//
// FIRST PRINCIPLES: a "tool" in the Anthropic API is just a JSON Schema
// description of a function, sent alongside the prompt. The model can't
// actually call anything — it can only emit a `tool_use` content block
// saying "I'd like to call `move` with `{ direction: "up" }`". Nothing
// happens until *our* code reads that block, runs real TypeScript against
// the real `GridState`, and sends the result back as a `tool_result` block.
// That round trip — model proposes, code decides and executes, model finds
// out what happened — is the entire mechanism that makes something an
// "agent" instead of a chatbot. This file is both halves of it: the
// schemas the model sees (`TOOLS`), and the code that actually runs when
// it picks one (`executeTool`).

import type Anthropic from "@anthropic-ai/sdk";
import {
  type GridState,
  type Position,
  type Direction,
  type CellContent,
  DIRECTION_OFFSETS,
  movePlayer,
  cellAt,
  inBounds,
  samePosition,
} from "./grid.js";
import { walkTo } from "./solver.js";

/**
 * The schemas handed to the API via `messages.create({ tools: TOOLS, ... })`.
 * This is the *only* thing the model knows about what actions exist — it
 * never sees grid.ts. Get a description wrong here and the model will
 * misuse the tool no matter how correct your executor code is; the schema
 * is itself a prompt.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "move",
    description:
      "Move the player one cell in the given direction. Fails (player stays put) if that would go off the edge of the grid.",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Which way to move, one cell.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "look",
    description:
      "Look at the four cells adjacent to the player (up, down, left, right) without moving. Use this to check for the trap before stepping into a cell.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "pickup",
    description:
      "Pick up an item on the player's current cell. The only item in this game is \"treasure\" — picking it up wins the game. You must be standing on the treasure's cell for this to succeed.",
    input_schema: {
      type: "object",
      properties: {
        item: {
          type: "string",
          description: 'The item to pick up, e.g. "treasure".',
        },
      },
      required: ["item"],
    },
  },
];

/**
 * Optional tool: the deterministic "how" behind the model's "what". Instead of
 * issuing one `move` per turn (and paying for the whole history each time),
 * the model names a destination and BFS in solver.ts walks there. Not in
 * `TOOLS` on purpose: it changes the experiment, so it is opt-in (NAVIGATE=1).
 */
export const NAVIGATE_TOOL: Anthropic.Tool = {
  name: "navigate_to",
  description:
    "Walk the player along a shortest safe path to the given cell, in one call. Avoids every trap you know about and, if the trap is hidden, looks ahead and routes around it automatically. Counts one move per step. Much cheaper than calling move repeatedly. Stops early if the destination is unreachable or the move limit is hit.",
  input_schema: {
    type: "object",
    properties: {
      row: { type: "integer", description: "Destination row (0 is the top)." },
      col: { type: "integer", description: "Destination column (0 is the left)." },
    },
    required: ["row", "col"],
  },
};

/** What the executor needs to know about the run, beyond the grid itself. */
export interface ToolContext {
  /** Hazards the agent knows about (what it can see, remembers or has found). */
  knownHazards: readonly Position[];
  /** Fog of war is on: navigate_to must look before stepping. */
  hideTrap: boolean;
  /** Move budget left, so navigate_to can't overspend it. */
  movesLeft: number;
}

/**
 * What running a tool call means for the loop in agent.ts:
 * - "ok": the game continues, `resultText` is fed back as the tool_result.
 * - "win": treasure collected, the loop should stop and report a win.
 * - "lose": player stepped on the trap, the loop should stop and report a loss.
 *
 * Keeping this as data (rather than, say, agent.ts inspecting `state` after
 * every call to guess what happened) means the win/lose *rules* live in
 * exactly one place — here — instead of being re-derived by the loop.
 */
export interface ToolExecutionResult {
  resultText: string;
  outcome: "ok" | "win" | "lose";
  /** Set by multi-step tools (navigate_to). Plain `move` leaves it to the caller. */
  moves?: number;
  /** Cells entered / traps found by a multi-step tool, for the scratchpad. */
  visited?: Position[];
  discoveredHazards?: Position[];
}

function describeAdjacent(state: GridState): string {
  const directions: Direction[] = ["up", "down", "left", "right"];

  return directions
    .map((direction) => {
      const offset = DIRECTION_OFFSETS[direction];
      const pos = { row: state.player.row + offset.dRow, col: state.player.col + offset.dCol };
      const content: CellContent | "edge of grid" = inBounds(state, pos)
        ? cellAt(state, pos)
        : "edge of grid";
      return `${direction}: ${content}`;
    })
    .join(", ");
}

/**
 * Runs one tool call against `state` and reports what happened.
 *
 * `toolName`/`input` come straight off the API's `tool_use` block, which
 * means `input` is `unknown` as far as the type system is concerned — the
 * model produced it, we didn't. We only trust it after checking its shape,
 * same as we would with any other untrusted input crossing a boundary.
 */
export function executeTool(
  state: GridState,
  toolName: string,
  input: unknown,
  context?: ToolContext
): ToolExecutionResult {
  switch (toolName) {
    case "navigate_to": {
      const { row, col } = (input ?? {}) as { row?: unknown; col?: unknown };
      if (!context) return { resultText: "navigate_to is not available in this run.", outcome: "ok" };
      if (!Number.isInteger(row) || !Number.isInteger(col)) {
        return { resultText: `Invalid destination: ${JSON.stringify(input)}.`, outcome: "ok" };
      }
      const target: Position = { row: row as number, col: col as number };
      if (!inBounds(state, target)) {
        return { resultText: `(row ${target.row}, col ${target.col}) is off the grid.`, outcome: "ok" };
      }
      const walk = walkTo(state, target, {
        hazards: context.knownHazards,
        hideTrap: context.hideTrap,
        maxSteps: context.movesLeft,
      });
      const base = { moves: walk.steps, visited: walk.visited, discoveredHazards: walk.discoveredHazards };
      const found = walk.discoveredHazards.length > 0 ? " Found a trap on the way and routed around it." : "";
      switch (walk.status) {
        case "arrived":
          return { ...base, resultText: `Arrived at (row ${target.row}, col ${target.col}) in ${walk.steps} moves.${found}`, outcome: "ok" };
        case "lost":
          return { ...base, resultText: `Walked onto the trap after ${walk.steps} moves. Game over — you lose.`, outcome: "lose" };
        case "blocked":
          return { ...base, resultText: `No safe route to (row ${target.row}, col ${target.col}) from here. Stopped after ${walk.steps} moves.`, outcome: "ok" };
        case "out_of_moves":
          return { ...base, resultText: `Ran out of moves after ${walk.steps} steps, short of the destination.`, outcome: "ok" };
      }
    }

    case "move": {
      const direction = (input as { direction?: string } | null)?.direction;
      if (
        direction !== "up" &&
        direction !== "down" &&
        direction !== "left" &&
        direction !== "right"
      ) {
        return { resultText: `Invalid direction: ${JSON.stringify(direction)}.`, outcome: "ok" };
      }

      const { moved, landedOn } = movePlayer(state, direction);

      if (!moved) {
        return {
          resultText: `Can't move ${direction} — that's the edge of the grid. You stayed put.`,
          outcome: "ok",
        };
      }
      if (landedOn === "trap") {
        return { resultText: `You moved ${direction} onto the trap. Game over — you lose.`, outcome: "lose" };
      }
      if (landedOn === "treasure") {
        return {
          resultText: `You moved ${direction} onto the treasure's cell. Nothing happens automatically — use pickup("treasure") to actually collect it.`,
          outcome: "ok",
        };
      }
      return { resultText: `Moved ${direction} to an empty cell.`, outcome: "ok" };
    }

    case "look": {
      return { resultText: describeAdjacent(state), outcome: "ok" };
    }

    case "pickup": {
      const item = (input as { item?: string } | null)?.item;
      if (typeof item !== "string" || item.toLowerCase() !== "treasure") {
        return { resultText: `There's no "${item}" here to pick up.`, outcome: "ok" };
      }
      // Deliberately NOT `cellAt(state, state.player)` here — cellAt checks
      // "is this the player's position?" first, so run against the
      // player's own position it would always report "player", never
      // "treasure", even while standing on the treasure's cell. Comparing
      // the player's position directly against the treasure's sidesteps
      // that.
      if (!samePosition(state.player, state.treasure)) {
        return { resultText: "You're not standing on the treasure — nothing to pick up here.", outcome: "ok" };
      }
      state.treasureCollected = true;
      return { resultText: "You picked up the treasure. You win!", outcome: "win" };
    }

    default:
      // The model asked for a tool name we didn't define. This shouldn't
      // happen — the API constrains tool_use.name to the TOOLS list we
      // sent — but a text-in-JSON-out boundary is exactly the place to not
      // assume that "shouldn't happen" means "can't happen".
      return { resultText: `Unknown tool: ${toolName}.`, outcome: "ok" };
  }
}
