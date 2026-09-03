// agent.ts — Stage 2: the actual agent loop.
//
// FIRST PRINCIPLES: Stage 1 proved one call to Claude works. An "agent" is
// what you get when you put that call in a loop and let its output change
// what you send it next:
//
//   send state --> model picks a tool call --> we execute it for real
//        ^                                              |
//        \______________ append the result ____________/
//
// Each lap of that loop is one "turn": we call the API, the model's reply
// contains a `tool_use` block (its chosen action), we run the corresponding
// function in tools.ts against the real GridState, and we append a
// `tool_result` block with what actually happened. The model then sees that
// result on the *next* turn and decides its next move from there. Nothing
// here is smarter than Stage 1 — same single API call — the only new idea
// is that we now do it repeatedly, feeding each answer back in.

import type Anthropic from "@anthropic-ai/sdk";
import { type GridState, renderGrid } from "./grid.js";
import { TOOLS, executeTool } from "./tools.js";

export interface RunResult {
  outcome: "win" | "lose" | "move_limit";
  moveCount: number;
}

const SYSTEM_PROMPT = `You are playing a grid-world treasure hunt by calling tools.
Rows and columns are 0-indexed; row 0 is the top, col 0 is the left.
P marks you (the player), T marks the treasure, X marks a trap, . marks an empty cell.

You have three tools: move(direction), look(), and pickup(item). Call exactly
ONE tool per turn. Reaching the treasure's cell does not win by itself — you
must pickup("treasure") while standing on it. Stepping onto the trap loses
immediately. Use look() if you're unsure what's next to you before moving.

Keep any text reply brief — a tool call is what actually matters each turn.`;

/**
 * Runs the Stage 2 loop to completion: repeated tool-call turns against
 * `state` until the game is won, lost, or `maxMoves` `move` calls have been
 * spent. Mutates `state` in place as a side effect (see the comment on
 * `movePlayer` in grid.ts for why that's fine here).
 */
export async function runAgentLoop(
  client: Anthropic,
  model: string,
  state: GridState,
  maxMoves: number
): Promise<RunResult> {
  // `messages` is the growing conversation history — every turn's request
  // and response gets appended, so the model always sees the full run so
  // far (what it tried, what happened) when deciding its next move. This
  // is literally what "the loop" is made of: one array that both sides
  // keep adding to.
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${renderGrid(state)}\n\nBegin. Call a tool.`,
    },
  ];

  let moveCount = 0;

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // The assistant's full reply — including any text plus its tool_use
    // block(s) — goes back into history verbatim. The API requires this:
    // every tool_result we send next turn must answer a tool_use that
    // genuinely appeared in the message history, not one we paraphrased.
    messages.push({ role: "assistant", content: response.content });

    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    for (const block of textBlocks) {
      if (block.text.trim().length > 0) console.log(`  (model says: ${block.text.trim()})`);
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      // The model replied with only text — no action. Rather than silently
      // ending the run, nudge it and let the loop continue; a `while(true)`
      // loop needs *some* exit path other than a tool result, and this is
      // it if the model ever gets chatty instead of acting.
      messages.push({
        role: "user",
        content: "You must call exactly one tool (move, look, or pickup) each turn.",
      });
      continue;
    }

    // Stage 2 is explicitly single-tool-call-per-turn (see README) — we
    // only ever *act* on the first tool_use block. But if the model
    // returns more than one anyway, the API still requires a tool_result
    // for each tool_use in this turn before it will accept the next
    // request, so the rest get an inert "skipped" result rather than being
    // silently dropped (which would leave the conversation malformed).
    const primary = toolUseBlocks[0];
    if (!primary) continue; // unreachable — toolUseBlocks.length === 0 already handled above
    const extras = toolUseBlocks.slice(1);
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

    const { resultText, outcome } = executeTool(state, primary.name, primary.input);
    if (primary.name === "move") moveCount++;

    console.log(`[turn, move ${moveCount}/${maxMoves}] ${primary.name}(${JSON.stringify(primary.input)}) -> ${resultText}`);
    console.log(renderGrid(state));
    console.log();

    toolResultBlocks.push({ type: "tool_result", tool_use_id: primary.id, content: resultText });
    for (const extra of extras) {
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: extra.id,
        content: "Skipped: only one tool call is processed per turn in Stage 2.",
      });
    }

    messages.push({ role: "user", content: toolResultBlocks });

    if (outcome === "win") return { outcome: "win", moveCount };
    if (outcome === "lose") return { outcome: "lose", moveCount };
    if (moveCount >= maxMoves) return { outcome: "move_limit", moveCount };
  }
}
