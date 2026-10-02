// memory.ts — Stage 4: short-term vs long-term memory.
//
// FIRST PRINCIPLES: a model has no memory of its own. Every API call starts
// from nothing except the text we send. "Memory" is therefore never a model
// feature — it is *our code* deciding which facts to write down and which to
// paste back into the next prompt. Stage 4 builds both kinds:
//
//   short-term  Scratchpad: what happened *this run* (cells visited, hazards
//               found with look()). Lives in RAM, rebuilt into the system
//               prompt on every turn, gone when the process exits.
//   long-term   memory.json: what we learned in *earlier runs* of the same
//               layout. Read once at the start, written once at the end.
//
// Neither is clever. Both are strings in the prompt. The interesting lesson
// is when they help: only for facts the agent can't already see. That is why
// this stage pairs with `HIDE_TRAP=1` (see grid.ts `ViewOptions`) — with the
// trap drawn on the grid, there is nothing to remember.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GridState,
  type Layout,
  type Position,
  DIRECTION_OFFSETS,
  cellAt,
  inBounds,
  samePosition,
} from "./grid.js";
import type { RunResult } from "./agent.js";

const formatPosition = (pos: Position) => `(row ${pos.row}, col ${pos.col})`;

// ---------------------------------------------------------------------------
// Short-term memory: the per-run scratchpad.
// ---------------------------------------------------------------------------

export interface Scratchpad {
  visited: Position[];
  hazards: Position[];
}

export function createScratchpad(state: GridState): Scratchpad {
  return { visited: [{ ...state.player }], hazards: [] };
}

function addUnique(list: Position[], pos: Position): void {
  if (!list.some((existing) => samePosition(existing, pos))) list.push({ ...pos });
}

/**
 * Folds one executed tool call into the scratchpad. Built from what the
 * world reported, not from what the model said, so it can't be wrong about
 * where the agent has actually been.
 */
export function updateScratchpad(
  pad: Scratchpad,
  toolName: string,
  state: GridState,
  outcome: "ok" | "win" | "lose"
): void {
  if (toolName === "move") {
    // A losing move ended on the trap: that's a hazard, not a place we "visited".
    addUnique(outcome === "lose" ? pad.hazards : pad.visited, state.player);
    return;
  }
  if (toolName === "look") {
    for (const { dRow, dCol } of Object.values(DIRECTION_OFFSETS)) {
      const pos = { row: state.player.row + dRow, col: state.player.col + dCol };
      if (inBounds(state, pos) && cellAt(state, pos) === "trap") addUnique(pad.hazards, pos);
    }
  }
}

export function renderScratchpad(pad: Scratchpad): string {
  const visited = pad.visited.map(formatPosition).join(", ");
  const hazards = pad.hazards.length > 0 ? pad.hazards.map(formatPosition).join(", ") : "none found yet";
  return `Cells you have visited this game: ${visited}.\nHazards discovered this game: ${hazards}.`;
}

// ---------------------------------------------------------------------------
// Long-term memory: memory.json, keyed by layout.
// ---------------------------------------------------------------------------

export interface RunRecord {
  timestamp: string;
  agent: string;
  outcome: RunResult["outcome"];
  moveCount: number;
  /** Did this run start with a remembered trap in its prompt? (For before/after comparisons.) */
  usedMemory: boolean;
}

export interface LayoutMemory {
  trap?: Position;
  runs: RunRecord[];
}

type MemoryFile = Partial<Record<Layout, LayoutMemory>>;

// Repo root, next to package.json. Gitignored: it's local run history.
const MEMORY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "memory.json");

function readFile(): MemoryFile {
  if (!existsSync(MEMORY_PATH)) return {};
  // Corrupt JSON throws on purpose: silently starting over would erase history.
  return JSON.parse(readFileSync(MEMORY_PATH, "utf8")) as MemoryFile;
}

export function loadLayoutMemory(layout: Layout): LayoutMemory | null {
  return readFile()[layout] ?? null;
}

/** Appends this run to the layout's history and keeps any newly learned trap. */
export function recordRun(layout: Layout, record: RunRecord, learnedTrap: Position | undefined): void {
  const file = readFile();
  const entry: LayoutMemory = file[layout] ?? { runs: [] };
  entry.runs.push(record);
  if (learnedTrap) entry.trap = learnedTrap;
  file[layout] = entry;
  writeFileSync(MEMORY_PATH, JSON.stringify(file, null, 2));
}

/**
 * The text that goes into the prompt, or null when there is nothing worth
 * saying. Note what it does NOT contain: the layout's name or any "you lost
 * last time" story — just the fact that changes decisions.
 */
export function renderLongTerm(memory: LayoutMemory | null): string | null {
  if (!memory?.trap) return null;
  const games = memory.runs.length;
  return `From ${games} earlier game${games === 1 ? "" : "s"} on this layout, you know the trap is at ${formatPosition(memory.trap)}.`;
}
