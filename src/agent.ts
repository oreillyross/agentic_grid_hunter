// agent.ts — Stage 3: explicit plan-then-act (ReAct-style).
//
// FIRST PRINCIPLES: Stage 2 proved the loop — model picks a tool, we run it,
// feed the result back. That loop is already "agentic" in the mechanical
// sense, but it's a black box: you can watch actions happen and infer intent,
// but you never see *why* the model chose one action over another. Stage 3
// makes that reasoning a first-class, logged artifact instead of something
// you guess at:
//
//   send state --> model writes a <plan> --> model picks a tool call --> we execute it
//        ^                                                                     |
//        \_________________________ append plan + result ______________________/
//
// Concretely: the system prompt now *requires* a short `<plan>` block of text
// before each tool call, and every turn's plan + action + result gets
// recorded into a `TraceStep` (see below), not just printed and discarded.
// The point isn't a smarter agent — it's visibility. That's also why the
// "no plan given" case below doesn't block the turn: forcing a strict
// re-ask would need a more complex retry protocol than this stage is about,
// so a missing plan is logged as a gap and nudged for next turn instead.

import type Anthropic from "@anthropic-ai/sdk";
import { type GridState, renderGrid } from "./grid.js";
import { TOOLS, executeTool } from "./tools.js";

export interface RunResult {
  outcome: "win" | "lose" | "move_limit";
  moveCount: number;
  trace: TraceStep[];
}

/**
 * One full turn of the loop, in the shape the README's Stage 3 acceptance
 * criteria asks for verbatim: "plan text, action taken, tool result,
 * resulting state." This is exactly what gets written to console and to
 * `runs/<timestamp>.json` — see cli.ts.
 */
export interface TraceStep {
  turn: number;
  plan: string;
  action: { tool: string; input: unknown };
  result: string;
  outcome: "ok" | "win" | "lose";
  moveCount: number;
  gridAfter: string;
}

const SYSTEM_PROMPT = `You are playing a grid-world treasure hunt by calling tools.
Rows and columns are 0-indexed; row 0 is the top, col 0 is the left.
P marks you (the player), T marks the treasure, X marks a trap, . marks an empty cell.

You have three tools: move(direction), look(), and pickup(item). Call exactly
ONE tool per turn. Reaching the treasure's cell does not win by itself — you
must pickup("treasure") while standing on it. Stepping onto the trap loses
immediately. Use look() if you're unsure what's next to you before moving.

Before every tool call, first write a short <plan>...</plan> block (one or
two sentences) explaining why you're choosing this action given the current
state — e.g. "<plan>Treasure is two cells right; nothing reported in that
direction yet, so I'll move right.</plan>". Always include the plan block,
even when the choice feels obvious. After the plan, call exactly one tool.
Keep any other text reply brief — the plan and the tool call are what
actually matter each turn.`;

const PLAN_TAG_PATTERN = /<plan>([\s\S]*?)<\/plan>/i;

/**
 * Pulls the plan text out of the model's text blocks for this turn.
 *
 * Prefers an explicit `<plan>...</plan>` tag (what the system prompt asks
 * for). If the model ignores the tag but still wrote *some* text, that text
 * is used as-is rather than thrown away — Stage 3 cares about capturing
 * whatever reasoning the model actually gave, not about punishing
 * formatting misses. Only truly empty text produces `null`, which the loop
 * below treats as a missing plan.
 */
function extractPlan(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const match = trimmed.match(PLAN_TAG_PATTERN);
  if (match) {
    const inner = match[1]?.trim() ?? "";
    return inner.length > 0 ? inner : null;
  }

  return trimmed;
}

/**
 * Runs the Stage 3 loop to completion: repeated plan-then-act turns against
 * `state` until the game is won, lost, or `maxMoves` `move` calls have been
 * spent. Mutates `state` in place as a side effect (see the comment on
 * `movePlayer` in grid.ts for why that's fine here). Returns the full trace
 * alongside the outcome so cli.ts can write it to a run file.
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
      content: `${renderGrid(state)}\n\nBegin. Write your <plan>, then call a tool.`,
    },
  ];

  let moveCount = 0;
  let turn = 0;
  const trace: TraceStep[] = [];

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
    const combinedText = textBlocks.map((block) => block.text).join("\n");
    const plan = extractPlan(combinedText);

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

    // Stage 3 keeps Stage 2's single-tool-call-per-turn rule (see README) —
    // we only ever *act* on the first tool_use block. But if the model
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
    turn++;

    const planText = plan ?? "(no plan given this turn)";
    console.log(`[turn ${turn}, move ${moveCount}/${maxMoves}] plan: ${planText}`);
    console.log(`  ${primary.name}(${JSON.stringify(primary.input)}) -> ${resultText}`);
    console.log(renderGrid(state));
    console.log();

    trace.push({
      turn,
      plan: planText,
      action: { tool: primary.name, input: primary.input },
      result: resultText,
      outcome,
      moveCount,
      gridAfter: renderGrid(state),
    });

    toolResultBlocks.push({ type: "tool_result", tool_use_id: primary.id, content: resultText });
    for (const extra of extras) {
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: extra.id,
        content: "Skipped: only one tool call is processed per turn.",
      });
    }

    if (plan === null) {
      // Missing plan doesn't block the turn (see the file header comment)
      // but it does get called out so the model course-corrects — a plain
      // string content block can't be mixed with tool_result blocks in the
      // same message, so the reminder rides along inside the tool_result
      // text instead of as a separate content block.
      toolResultBlocks[0] = {
        ...toolResultBlocks[0]!,
        content: `${resultText}\n\n(Reminder: include a <plan>...</plan> block before your next tool call.)`,
      };
    }

    messages.push({ role: "user", content: toolResultBlocks });

    if (outcome === "win") return { outcome: "win", moveCount, trace };
    if (outcome === "lose") return { outcome: "lose", moveCount, trace };
    if (moveCount >= maxMoves) return { outcome: "move_limit", moveCount, trace };
  }
}
