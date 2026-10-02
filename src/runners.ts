// runners.ts — one place that knows how to build each agent, so cli.ts (play
// one game, watch it) and eval.ts (play hundreds, score them) can't drift apart.
//
// An agent is named by a config string: a brain, plus optional "+nav".
//
//   classic        BFS, no model, $0                     (classic-agent.ts)
//   claude         Stage 3/4 plan-then-act loop          (agent.ts)
//   claude+nav     same, but offered the navigate_to tool
//   planner        Stage 6 planner/executor pair         (planner-agent.ts)
//   planner+nav    same, executor also gets navigate_to
//   jev            TypeSafe Jev classifier loop          (jev-agent.ts)

import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { GridState, Position } from "./grid.js";
import { runAgentLoop, type RunResult } from "./agent.js";
import { runClassicLoop } from "./classic-agent.js";
import { runJevLoop } from "./jev-agent.js";
import { runPlannerExecutorLoop } from "./planner-agent.js";
import { estimateCostUsd } from "./usage.js";

export const BRAINS = ["classic", "claude", "planner", "jev"] as const;
export type Brain = (typeof BRAINS)[number];

export interface AgentConfig {
  brain: Brain;
  navigate: boolean;
}

export function parseAgentConfig(text: string): AgentConfig {
  const [brain, ...modifiers] = text.trim().split("+");
  if (!BRAINS.includes(brain as Brain)) {
    throw new Error(`Unknown agent "${brain}". Use one of: ${BRAINS.join(", ")} (optionally +nav).`);
  }
  const unknown = modifiers.filter((m) => m !== "nav");
  if (unknown.length > 0) throw new Error(`Unknown modifier "+${unknown[0]}" in "${text}". Only +nav exists.`);
  const config = { brain: brain as Brain, navigate: modifiers.includes("nav") };
  if (config.navigate && (config.brain === "jev" || config.brain === "classic")) {
    throw new Error(`"+nav" only applies to claude and planner ("${text}"). classic always navigates; jev can't call tools.`);
  }
  return config;
}

export const agentLabel = (config: AgentConfig) => config.brain + (config.navigate ? "+nav" : "");

/** The environment variables a given brain needs, or null if it is ready to run. */
export function missingKey(config: AgentConfig): string | null {
  if (config.brain === "jev") return process.env.TYPESAFE_API_KEY ? null : "TYPESAFE_API_KEY";
  if (config.brain === "claude" || config.brain === "planner") return process.env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY";
  return null;
}

export const executorModel = () => process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
export const plannerModel = () => process.env.PLANNER_MODEL ?? "claude-sonnet-5-5";

/** The model name to show for a config: the one that drives the moves. */
export function modelFor(config: AgentConfig): string {
  if (config.brain === "jev") return process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest";
  if (config.brain === "classic") return "none (BFS)";
  return config.brain === "planner" ? `${plannerModel()} plans, ${executorModel()} executes` : executorModel();
}

/** Per-game knowledge and switches, the same for every brain. */
export interface RunContext {
  hideTrap: boolean;
  longTerm?: string | null;
  rememberedTrap?: Position | null;
}

export type Runner = (state: GridState, maxMoves: number, context: RunContext) => Promise<RunResult>;

/** Anthropic clients are cheap to build, but only build one if a brain needs it. */
export function createAnthropic(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {},
  });
}

/** `anthropic` can be injected (tests pass a scripted stand-in); otherwise it is built lazily. */
export function buildRunner(config: AgentConfig, anthropic?: Anthropic): Runner {
  const claude = () => (anthropic ??= createAnthropic());
  switch (config.brain) {
    case "classic":
      return async (state, maxMoves, ctx) => runClassicLoop(state, maxMoves, ctx);
    case "claude":
      return (state, maxMoves, ctx) => runAgentLoop(claude(), executorModel(), state, maxMoves, { ...ctx, navigate: config.navigate });
    case "planner":
      return (state, maxMoves, ctx) =>
        runPlannerExecutorLoop(claude(), { planner: plannerModel(), executor: executorModel() }, state, maxMoves, { ...ctx, navigate: config.navigate });
    case "jev":
      return (state, maxMoves, ctx) => {
        if (ctx.hideTrap) throw new Error("Jev can't play with a hidden trap: its guard reads the real trap position.");
        return runJevLoop(new TypeSafeClient(), state, maxMoves);
      };
  }
}

/** USD for one finished run: the run's own figure if it billed several models, else tokens at the executor's price. */
export function runCostUsd(result: RunResult): number | null {
  if (result.costUsd !== undefined) return result.costUsd;
  return result.usage ? estimateCostUsd(executorModel(), result.usage) : null;
}
