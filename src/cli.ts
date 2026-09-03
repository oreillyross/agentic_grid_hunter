// cli.ts — Stage 2 entry point.
//
// Stage 1's cli.ts made one call and printed the reply (see git history /
// the Stage 1 PR for that version). Stage 2 wraps the same kind of call in
// the loop from agent.ts: build a world, hand control to the loop, print
// what happens as it plays out, report the final outcome. All the actual
// "agent" mechanics (tool_use -> execute -> tool_result -> repeat) live in
// agent.ts and tools.ts — read grid.ts, then tools.ts, then agent.ts, then
// this file, in that order, if you're using this repo to learn.

import "dotenv/config"; // loads .env into process.env — see .env.example
import Anthropic from "@anthropic-ai/sdk";
import { createGrid, renderGrid, describePositions } from "./grid.js";
import { runAgentLoop } from "./agent.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key."
  );
  process.exit(1);
}

const client = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

// The move-limit end condition from the README ("move limit reached, e.g.
// 20 moves"). Only `move` tool calls count against this — `look` and
// `pickup` don't cost a move, so a cautious agent that checks before every
// step isn't punished for it.
const MAX_MOVES = Number(process.env.MAX_MOVES ?? 20);

async function main() {
  const state = createGrid();

  console.log("=== Starting grid ===");
  console.log(renderGrid(state));
  console.log();
  console.log(describePositions(state));
  console.log();
  console.log(`=== Running agent loop (${MODEL}, max ${MAX_MOVES} moves) ===`);
  console.log();

  const result = await runAgentLoop(client, MODEL, state, MAX_MOVES);

  console.log("=== Run complete ===");
  console.log(`Outcome: ${result.outcome}`);
  console.log(`Moves used: ${result.moveCount}/${MAX_MOVES}`);
}

main();
