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
import { type GridState, type Position, renderGrid } from "./grid.js";
import { TOOLS, NAVIGATE_TOOL, executeTool, type ToolContext } from "./tools.js";
import { createScratchpad, recordNavigation, renderScratchpad, updateScratchpad, type Scratchpad } from "./memory.js";
import { addUsage, emptyUsage, fromApiUsage, type Usage } from "./usage.js";

export interface RunResult {
  outcome: "win" | "lose" | "move_limit";
  moveCount: number;
  trace: TraceStep[];
  /** Summed token usage over every API call this run (Claude loop only). */
  usage?: Usage;
  /** Set when more than one model was billed (planner + executor): overrides cost-from-`usage`. */
  costUsd?: number | null;
  /** A trap position the agent found this run (via look() or by hitting it), for long-term memory. */
  discoveredTrap?: Position;
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
  /** Tokens spent on the API call that produced this turn (Claude loop only). */
  usage?: Usage;
}

const LEGEND_VISIBLE =
  "P marks you (the player), T marks the treasure, X marks a trap, . marks an empty cell.";
const LEGEND_HIDDEN =
  "P marks you (the player), T marks the treasure, . marks an empty cell. There is a trap somewhere on the grid but it is NOT drawn: look() reports it when it is next to you.";

const NAVIGATE_NOTE = `
You also have navigate_to(row, col): it walks a shortest safe path to that cell
in a single call, avoiding known traps and, if the trap is hidden, looking
ahead and routing around it. Prefer it to repeated move calls.`;

const SYSTEM_PROMPT_TEMPLATE = (legend: string, navigate: boolean) => `You are playing a grid-world treasure hunt by calling tools.
Rows and columns are 0-indexed; row 0 is the top, col 0 is the left.
${legend}

You have ${navigate ? "four tools: move(direction), look(), pickup(item), and navigate_to(row, col)" : "three tools: move(direction), look(), and pickup(item)"}. Call exactly
ONE tool per turn.${navigate ? NAVIGATE_NOTE : ""} Reaching the treasure's cell does not win by itself — you
must pickup("treasure") while standing on it. Stepping onto the trap loses
immediately. Use look() if you're unsure what's next to you before moving.

Before every tool call, first write a short <plan>...</plan> block (one or
two sentences) explaining why you're choosing this action given the current
state — e.g. "<plan>Treasure is two cells right; nothing reported in that
direction yet, so I'll move right.</plan>". Always include the plan block,
even when the choice feels obvious. After the plan, call exactly one tool.
Keep any other text reply brief — the plan and the tool call are what
actually matter each turn.`;

export interface AgentMemoryOptions {
  /** Fog of war: don't show the trap in the grid or positions (see grid.ts `ViewOptions`). */
  hideTrap?: boolean;
  /** Long-term memory text from earlier runs (memory.ts `renderLongTerm`), if any. */
  longTerm?: string | null;
  /** The trap position long-term memory holds, as data (navigate_to needs it, the prompt only has text). */
  rememberedTrap?: Position | null;
  /** Offer the deterministic navigate_to tool (see tools.ts). Off by default: it changes the experiment. */
  navigate?: boolean;
  /**
   * Stage 6 handoff, planner -> executor: the planner's current strategy.
   * Read fresh before every API call, so a revision takes effect next turn.
   */
  strategy?: { text: string };
  /**
   * Stage 6 handoff, executor -> planner: called after every `checkpointEvery`
   * turns and whenever a new hazard shows up. The planner may revise `strategy`.
   */
  checkpoint?: (report: ExecutorReport) => Promise<void>;
  checkpointEvery?: number;
}

/** What the executor tells the planner at a checkpoint — the whole "report back" contract. */
export interface ExecutorReport {
  reason: "hazard" | "periodic";
  turn: number;
  moveCount: number;
  player: Position;
  hazards: Position[];
  /** The last few turns as one-line summaries: "move(...) -> result". */
  recent: string[];
}

/**
 * Rebuilt before *every* API call, because the API is stateless: whatever
 * the model should "remember" has to be in this request. Short-term memory
 * (the scratchpad) changes each turn; long-term memory is fixed for the run.
 */
function buildSystemPrompt(options: AgentMemoryOptions, scratchpad: Scratchpad): string {
  const sections = [
    SYSTEM_PROMPT_TEMPLATE(options.hideTrap ? LEGEND_HIDDEN : LEGEND_VISIBLE, options.navigate === true),
    `Scratchpad (this game so far):\n${renderScratchpad(scratchpad)}`,
  ];
  if (options.strategy) {
    sections.push(
      `Strategy from your planner:\n${options.strategy.text}\nFollow it unless the world contradicts it. You choose the individual tool calls; the planner chose the direction.`
    );
  }
  if (options.longTerm) {
    sections.push(
      `Long-term memory:\n${options.longTerm} Use it, and say so in your <plan> when it affects your choice.`
    );
  }
  return sections.join("\n\n");
}

/**
 * What the agent can legitimately route around: the trap if it is drawn on the
 * grid, otherwise whatever it has found or remembered. Never the true trap
 * position under fog of war — that would be cheating.
 */
function knownHazards(state: GridState, options: AgentMemoryOptions, pad: Scratchpad): Position[] {
  if (!options.hideTrap) return [state.trap];
  return options.rememberedTrap ? [...pad.hazards, options.rememberedTrap] : pad.hazards;
}

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
  maxMoves: number,
  options: AgentMemoryOptions = {}
): Promise<RunResult> {
  const view = { hideTrap: options.hideTrap };
  // Short-term memory: lives and dies with this call.
  const scratchpad = createScratchpad(state);
  const totalUsage = emptyUsage();

  // `messages` is the growing conversation history — every turn's request
  // and response gets appended, so the model always sees the full run so
  // far (what it tried, what happened) when deciding its next move. This
  // is literally what "the loop" is made of: one array that both sides
  // keep adding to.
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${renderGrid(state, view)}\n\nBegin. Write your <plan>, then call a tool.`,
    },
  ];

  let moveCount = 0;
  let turn = 0;
  const trace: TraceStep[] = [];

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: buildSystemPrompt(options, scratchpad),
      tools: options.navigate ? [...TOOLS, NAVIGATE_TOOL] : TOOLS,
      messages,
    });

    // Counted before anything else so even a text-only reply (which we
    // re-ask below) is billed in the total — it cost real tokens.
    const turnUsage = fromApiUsage(response.usage);
    addUsage(totalUsage, turnUsage);

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

    const toolContext: ToolContext = {
      knownHazards: knownHazards(state, options, scratchpad),
      hideTrap: options.hideTrap === true,
      movesLeft: maxMoves - moveCount,
    };
    const hazardsBefore = scratchpad.hazards.length;
    const executed = executeTool(state, primary.name, primary.input, toolContext);
    const { resultText, outcome } = executed;
    moveCount += executed.moves ?? (primary.name === "move" ? 1 : 0);
    updateScratchpad(scratchpad, primary.name, state, outcome);
    if (executed.visited) recordNavigation(scratchpad, executed.visited, executed.discoveredHazards ?? []);
    turn++;

    const planText = plan ?? "(no plan given this turn)";
    console.log(`[turn ${turn}, move ${moveCount}/${maxMoves}] plan: ${planText}`);
    console.log(`  ${primary.name}(${JSON.stringify(primary.input)}) -> ${resultText}`);
    console.log(`  tokens: ${turnUsage.inputTokens} in / ${turnUsage.outputTokens} out`);
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
      usage: turnUsage,
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

    const discoveredTrap = scratchpad.hazards[0];
    const gameOver = outcome !== "ok" || moveCount >= maxMoves;
    if (!gameOver && options.checkpoint) {
      const newHazard = scratchpad.hazards.length > hazardsBefore;
      if (newHazard || (options.checkpointEvery && turn % options.checkpointEvery === 0)) {
        await options.checkpoint({
          reason: newHazard ? "hazard" : "periodic",
          turn,
          moveCount,
          player: { ...state.player },
          hazards: scratchpad.hazards.map((pos) => ({ ...pos })),
          recent: trace.slice(-3).map((step) => `${step.action.tool}(${JSON.stringify(step.action.input)}) -> ${step.result}`),
        });
      }
    }
    if (outcome === "win") return { outcome: "win", moveCount, trace, discoveredTrap, usage: totalUsage };
    if (outcome === "lose") return { outcome: "lose", moveCount, trace, discoveredTrap, usage: totalUsage };
    if (moveCount >= maxMoves) {
      return { outcome: "move_limit", moveCount, trace, discoveredTrap, usage: totalUsage };
    }
  }
}
