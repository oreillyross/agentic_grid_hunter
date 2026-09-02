// cli.ts — Stage 1 entry point.
//
// FIRST PRINCIPLES: at its absolute simplest, "using an LLM" means sending
// it a sequence of messages and getting text back. That's it — no agent, no
// tools, no loop. Stage 1's whole job is to prove that round-trip works
// end-to-end: build a world (grid.ts), describe it in text, hand that text
// to Claude, and confirm the reply actually engages with what we described
// (e.g. it correctly says where the treasure is relative to the player).
//
// Everything "agentic" (Stage 2+) is this same call, just wrapped in a loop
// where the model's reply can also request that we *do* something before we
// call it again. You can't understand what the loop adds until you've seen
// the single call on its own — that's why Stage 1 explicitly forbids tool
// use and looping (see README).

import "dotenv/config"; // loads .env into process.env — see .env.example
import Anthropic from "@anthropic-ai/sdk";
import { createGrid, renderGrid, describePositions } from "./grid.js";

// The Anthropic SDK reads `ANTHROPIC_API_KEY` from process.env automatically
// if you don't pass `apiKey` explicitly — but we check it ourselves first so
// a missing key fails with a clear message instead of a confusing 401 from
// deep inside the SDK.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key."
  );
  process.exit(1);
}

// Identity-linked Anthropic API keys also require the workspace they should act
// in. Regular API keys do not, so only send this header when configured.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic({
  defaultHeaders: workspaceId
    ? { "anthropic-workspace-id": workspaceId }
    : undefined,
});

// Allow overriding the model via env var so you can experiment without
// editing code, but default to a sane, current model.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

async function main() {
  // 1. Build the world. Stage 1 uses one fixed hand-placed layout — see the
  // comment in grid.ts on why we're not randomizing yet.
  const state = createGrid();

  // 2. Turn the world into text. This is the only thing the model will ever
  // see of the game — from the model's point of view, this string *is* the
  // grid. Anything not captured here (rules, what "trap" means, what we
  // want back) has to be spelled out separately, in the system prompt.
  const asciiGrid = renderGrid(state);
  const positions = describePositions(state);

  console.log("=== Grid (ground truth, for you to compare against) ===");
  console.log(asciiGrid);
  console.log();
  console.log(positions);
  console.log();

  // 3. The SYSTEM PROMPT sets the model's role and the rules of the world —
  // things that are true for the whole conversation, not specific to this
  // one turn. It's kept separate from the USER message (below) because that
  // separation is how the API itself models the distinction: "system" is
  // persistent context/instructions, "user"/"assistant" is the actual
  // back-and-forth. In Stage 2+ this system prompt is also where tool-use
  // instructions and persona get layered in.
  const systemPrompt = `You are playing a simple grid-world treasure hunt.
The grid is ${state.size}x${state.size}. Rows and columns are 0-indexed; row 0 is the top, col 0 is the left.
P marks the player, T marks the treasure, X marks a trap, . marks an empty cell.

For this turn, just describe what you observe: where the player is, where the
treasure is, and how the player could get there (which directions, roughly
how many moves), relative to the player's current position. Do not invent
information not given to you. You are not being asked to move or use any
tools right now — this is a plain conversational reply, one message, no
follow-up.`;

  // 4. The USER message is the per-turn input — here, the rendered grid.
  // A "message" in this API is just `{ role: "user" | "assistant", content }`;
  // stacking these up across turns is literally what conversation history
  // (and later, the agent loop) *is*. Stage 1 sends exactly one.
  const userMessage = `${asciiGrid}\n\n${positions}\n\nWhat do you observe?`;

  console.log(`=== Sending to ${MODEL} ===`);
  console.log();

  // 5. The actual call. `messages.create` is the whole API surface Stage 1
  // needs: model to run, a token budget (max_tokens — required, since the
  // model doesn't know when to stop on its own without some ceiling), the
  // system prompt, and the message list.
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  // 6. The response's `content` is an array of *blocks*, not a single
  // string — a reply can mix text blocks with other block types (like
  // `tool_use` blocks, which is exactly what Stage 2 introduces). Stage 1
  // only ever produces text blocks, so we just concatenate them.
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  const replyText = textBlocks.map((block) => block.text).join("\n");

  console.log("=== Claude's response ===");
  console.log(replyText);
  console.log();

  // stop_reason tells you *why* the model stopped generating — useful even
  // here in Stage 1 as a preview of Stage 2, where "tool_use" as a stop
  // reason is the signal that tells the loop "the model wants to act, not
  // just talk."
  console.log(`(stop_reason: ${response.stop_reason}, model: ${response.model})`);
}

// No loop, no retry, no tool handling — a single call that either succeeds
// or throws. Letting it throw and crash the process is the correct amount
// of error handling for Stage 1: there's no partial state to clean up yet.
main();
