import { SYSTEM_PROMPT } from "@/prompts";
import { sendPrompt } from "@/provider/openrouter";
import { getAllTagContents, getFirstTagContent } from "@/utils/xml-parser";
import { doBrowserTask, type BrowserTaskResult } from "@/utils/do-browser-task";
import { getExistingContextId } from "@/utils/browser-context";
import { withContextWriteLock } from "@/utils/context-lock";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A parsed <SUB_AGENT> spec. */
export interface SubAgentSpec {
  startingPage: string;
  performAction?: string;
  readPrompt?: string;
  observePrompt?: string;
  /**
   * When true, this sub-agent logs in / signs up, so any new cookies +
   * localStorage it produces are written back into the shared login context and
   * become available to all future sub-agents. Persisting sub-agents are run
   * one-at-a-time (never simultaneously) to avoid clobbering each other.
   */
  persistLogin?: boolean;
  /**
   * Optional hint for how many browser steps this sub-agent may need. Longer,
   * multi-step flows (e.g. a checkout) should request more; a single read needs
   * few. Clamped to a safe range so a bad value can't stall the batch.
   */
  maxSteps?: number;
}

/** Events emitted during a run so a UI can render live. */
export type AgentEvent =
  | { type: "response"; agentId: string; depth: number; text: string }
  | { type: "log"; agentId: string; depth: number; text: string }
  | {
      type: "sub_agents_spawned";
      agentId: string;
      depth: number;
      specs: SubAgentSpec[];
    }
  | {
      type: "browser_live_url";
      agentId: string;
      depth: number;
      taskId: string;
      startingPage: string;
      liveUrl: string;
      label: string;
    }
  | {
      type: "sub_agent_result";
      agentId: string;
      depth: number;
      taskId: string;
      result: BrowserTaskResult;
    }
  | { type: "finish"; agentId: string; depth: number; text: string }
  | { type: "error"; agentId: string; depth: number; text: string };

export type EventHandler = (event: AgentEvent) => void;

const MAX_ITERATIONS = 8;
const MAX_DEPTH = 3;

let AGENT_COUNTER = 0;
function nextAgentId(depth: number): string {
  AGENT_COUNTER += 1;
  return depth === 0 ? "root" : `agent-${AGENT_COUNTER}`;
}

/**
 * Parse a raw <SUB_AGENTS> block (or a full model response) into structured specs.
 */
export function parseSubAgents(text: string): SubAgentSpec[] {
  const block = getFirstTagContent(text, "SUB_AGENTS");
  if (!block) return [];
  return getAllTagContents(block, "SUB_AGENT")
    .map((raw): SubAgentSpec | null => {
      const startingPage = getFirstTagContent(raw, "STARTING_PAGE");
      if (!startingPage) return null;
      const spec: SubAgentSpec = { startingPage };
      const performAction = getFirstTagContent(raw, "PERFORM_ACTION");
      const readPrompt = getFirstTagContent(raw, "READ_PROMPT");
      const observePrompt = getFirstTagContent(raw, "OBSERVE_PROMPT");
      const persistLogin = getFirstTagContent(raw, "PERSIST_LOGIN");
      const maxSteps = getFirstTagContent(raw, "MAX_STEPS");
      if (performAction) spec.performAction = performAction;
      if (readPrompt) spec.readPrompt = readPrompt;
      if (observePrompt) spec.observePrompt = observePrompt;
      if (persistLogin && /^(true|yes|1)$/i.test(persistLogin.trim()))
        spec.persistLogin = true;
      if (maxSteps) {
        const n = Number.parseInt(maxSteps.trim(), 10);
        // Clamp to a sane window so a bad hint can't stall or truncate the run.
        if (Number.isFinite(n)) spec.maxSteps = Math.min(Math.max(n, 3), 40);
      }
      return spec;
    })
    .filter((s): s is SubAgentSpec => s !== null);
}

/**
 * Collapse a spec's action + read + observe goals into ONE plain-English
 * instruction for the hybrid sub-agent. The agent plans and executes the whole
 * flow itself, so we just describe the goal (and any data to report back).
 */
export function buildInstruction(spec: SubAgentSpec): string {
  const parts: string[] = [];
  if (spec.performAction) parts.push(spec.performAction.trim());
  if (spec.readPrompt)
    parts.push(`Then read and report: ${spec.readPrompt.trim()}`);
  if (spec.observePrompt)
    parts.push(
      `Also identify these elements / links: ${spec.observePrompt.trim()}`,
    );
  if (parts.length === 0)
    parts.push("Wait for the page to load and describe what is on it.");
  parts.push(
    `Dismiss any cookie banner or popup first. You are already on ${spec.startingPage}; do not navigate away unless the task requires it.`,
  );
  return parts.join(" ");
}

export class Agent {
  conversations: Message[];
  new_prompt: boolean;
  depth: number;
  id: string;
  /** The owner of this run. Scopes which Browserbase context is used. */
  userId?: string;
  private emit: EventHandler;

  constructor(
    conversations: Message[] = [],
    options: {
      onEvent?: EventHandler;
      depth?: number;
      id?: string;
      userId?: string;
    } = {},
  ) {
    this.new_prompt = false;
    this.depth = options.depth ?? 0;
    this.id = options.id ?? nextAgentId(this.depth);
    this.userId = options.userId;
    this.emit = options.onEvent ?? (() => {});
    this.conversations =
      conversations.length > 0
        ? conversations
        : [{ role: "system", content: SYSTEM_PROMPT }];
  }

  private log(text: string) {
    console.log(`[${this.id}] ${text}`);
    this.emit({ type: "log", agentId: this.id, depth: this.depth, text });
  }

  /**
   * Run the reasoning loop until the model emits <FINISH> (or limits are hit).
   * Returns the final text (contents of <FINISH>, or the last <RESPONSE>).
   */
  startLoop = async (prompt: string): Promise<string> => {
    this.new_prompt = true;
    this.conversations.push({
      role: "user",
      content: `<USER_TASK>\n${prompt}\n</USER_TASK>`,
    });

    let finalText = "";
    let iterations = 0;

    while (this.new_prompt && iterations < MAX_ITERATIONS) {
      iterations += 1;

      let res: string;
      try {
        res = await sendPrompt("", { messages: this.conversations });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.emit({ type: "error", agentId: this.id, depth: this.depth, text });
        this.new_prompt = false;
        break;
      }

      this.conversations.push({ role: "assistant", content: res });

      // Emit any <LOG> lines.
      for (const line of getAllTagContents(res, "LOG")) {
        this.log(line);
      }

      // Emit the human-readable <RESPONSE>.
      const response = getFirstTagContent(res, "RESPONSE");
      if (response) {
        this.emit({
          type: "response",
          agentId: this.id,
          depth: this.depth,
          text: response,
        });
      }

      // If finished, stop.
      const finish = getFirstTagContent(res, "FINISH");
      if (finish) {
        finalText = finish;
        this.emit({
          type: "finish",
          agentId: this.id,
          depth: this.depth,
          text: finish,
        });
        this.new_prompt = false;
        break;
      }

      // Otherwise look for sub-agents to run.
      const specs = parseSubAgents(res);
      if (specs.length === 0) {
        // No sub-agents and no finish: treat the response as the final answer.
        finalText = response ?? res;
        this.new_prompt = false;
        break;
      }

      if (this.depth >= MAX_DEPTH) {
        this.log(
          `Max recursion depth (${MAX_DEPTH}) reached; refusing to spawn more sub-agents.`,
        );
      }

      this.emit({
        type: "sub_agents_spawned",
        agentId: this.id,
        depth: this.depth,
        specs,
      });

      // Run ALL sub-agents in one parallel batch, then feed results back in.
      const results = await this.runSubAgentsBatch(specs);
      const resultsBlock = this.formatResults(results);
      this.conversations.push({ role: "user", content: resultsBlock });
    }

    if (iterations >= MAX_ITERATIONS && this.new_prompt) {
      this.log(`Stopped after ${MAX_ITERATIONS} iterations.`);
      this.new_prompt = false;
    }

    return finalText;
  };

  /** Runs every spec in parallel (one batch) and returns all results in order. */
  private runSubAgentsBatch = async (
    specs: SubAgentSpec[],
  ): Promise<Array<{ spec: SubAgentSpec; result: BrowserTaskResult }>> => {
    // Resolve THIS USER's login context once for the whole batch (if they have
    // saved any login data). Passed read-only so parallel agents share the
    // user's cookies + localStorage without racing writes back to the context.
    let sharedContextId: string | null = null;
    try {
      if (this.userId) {
        sharedContextId = await getExistingContextId(this.userId);
        if (sharedContextId) {
          this.log(`Injecting saved login data (context ${sharedContextId}).`);
        }
      }
    } catch {
      /* no context available; sub-agents run logged-out */
    }

    return Promise.all(
      specs.map(async (spec, index) => {
        const label = `${this.id} › sub-${index + 1}`;
        // Globally-unique id for this specific browser task, stable across the
        // live-url and result events so the UI can reliably close the right window.
        AGENT_COUNTER += 1;
        const taskId = `task-${AGENT_COUNTER}`;
        this.log(`Spawning ${label} → ${spec.startingPage}`);

        // A sub-agent that logs in / signs up writes its new cookies back into
        // the shared context so every future sub-agent inherits them. Those
        // writes MUST be serialized (Browserbase persists the whole context on
        // close, last-write-wins), so persisting sub-agents run under a lock
        // one-at-a-time; read-only ones stay fully parallel.
        const persistLogin = Boolean(sharedContextId && spec.persistLogin);

        const runTask = () =>
          doBrowserTask({
            startingPage: spec.startingPage,
            instruction: buildInstruction(spec),
            ...(spec.maxSteps ? { maxSteps: spec.maxSteps } : {}),
            ...(sharedContextId
              ? { contextId: sharedContextId, persist: persistLogin }
              : {}),
            onLiveUrl: (liveUrl) => {
              this.emit({
                type: "browser_live_url",
                agentId: this.id,
                depth: this.depth,
                taskId,
                startingPage: spec.startingPage,
                liveUrl,
                label,
              });
            },
            onLog: (text) => {
              this.emit({
                type: "log",
                agentId: label,
                depth: this.depth + 1,
                text,
              });
            },
          });

        let result: BrowserTaskResult;
        try {
          if (persistLogin && sharedContextId) {
            this.log(
              `${label} will save its login data to your context (runs solo).`,
            );
            // Key the lock by the user's context id so a user's own persisting
            // sub-agents serialize, but different users never block each other.
            result = await withContextWriteLock(sharedContextId, runTask);
          } else {
            result = await runTask();
          }
        } catch (err) {
          // Defense in depth: a sub-agent must never reject the whole batch.
          result = {
            startingPage: spec.startingPage,
            error: err instanceof Error ? err.message : String(err),
          };
          this.log(`${label} failed: ${result.error}`);
        }

        this.emit({
          type: "sub_agent_result",
          agentId: label,
          depth: this.depth + 1,
          taskId,
          result,
        });

        return { spec, result };
      }),
    );
  };

  /** Formats sub-agent results into a <SUB_AGENTS_RESULTS> block for the next turn. */
  private formatResults(
    results: Array<{ spec: SubAgentSpec; result: BrowserTaskResult }>,
  ): string {
    const parts = results.map(({ spec, result }, index) => {
      // STATUS lets the orchestrator quickly decide whether to retry. A task is
      // only "ok" if it did NOT error and the agent reported success.
      const ok = !result.error && result.success !== false;
      const lines = [
        `  <STATUS>${ok ? "ok" : "failed"}</STATUS>`,
        `  <STARTING_PAGE>${spec.startingPage}</STARTING_PAGE>`,
      ];
      if (result.agentSummary)
        lines.push(`  <SUMMARY>${result.agentSummary}</SUMMARY>`);
      if (result.error) lines.push(`  <ERROR>${result.error}</ERROR>`);
      return `<SUB_AGENT_RESULT index="${index + 1}">\n${lines.join(
        "\n",
      )}\n</SUB_AGENT_RESULT>`;
    });
    return `<SUB_AGENTS_RESULTS>\n${parts.join("\n")}\n</SUB_AGENTS_RESULTS>`;
  }
}
