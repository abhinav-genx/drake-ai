import { Stagehand } from "@browserbasehq/stagehand";
import Browserbase from "@browserbasehq/sdk";
import "dotenv/config";

export interface BrowserTaskResult {
  startingPage: string;
  liveUrl?: string;
  /** The hybrid agent's own natural-language summary of what it did. */
  agentSummary?: string;
  /** Whether the agent believes it completed the requested action. */
  success?: boolean;
  error?: string;
}

/**
 * Overall wall-clock budget for a single sub-agent run. The hybrid agent plans
 * and takes many steps (screenshot → reason → click/type → …), so this is
 * generous. Override per-call via `taskTimeoutMs`.
 */
const TASK_TIMEOUT_MS = 180_000;
/** Per agent tool-call timeout handed to Stagehand (goto/click/type/extract…). */
const TOOL_TIMEOUT_MS = 45_000;
/** Max time to wait for cleanup (close) before giving up so the batch never hangs. */
const CLEANUP_TIMEOUT_MS = 10_000;
/** Default cap on the number of agent steps for a single action. */
const DEFAULT_MAX_STEPS = 18;

/**
 * On-page reasoning model for the hybrid agent. Hybrid mode needs a model that
 * can act from screenshots (coordinate clicks) AND use DOM tools — any Claude
 * model works well. Configurable via STAGEHAND_MODEL. Reads ANTHROPIC_API_KEY
 * (or the provider key baked into the model config) automatically.
 */
const HYBRID_MODEL =
  process.env.STAGEHAND_MODEL ?? "anthropic/claude-haiku-4-5-20251001";

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}

/** Wrap a promise so it rejects (or resolves to a fallback) after `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Normalize any thrown value into a non-empty error string. */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Unknown error";
  if (typeof err === "string" && err.trim()) return err;
  try {
    const s = JSON.stringify(err);
    return s && s !== "{}" ? s : "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/**
 * Resolve the model config for the hybrid agent. Stagehand's on-page reasoning
 * runs against THIS model (not the orchestrator's OpenRouter call), so it needs
 * its own credentials:
 *   - If ANTHROPIC_API_KEY is set, use it directly (native Anthropic).
 *   - Otherwise fall back to OpenRouter (we always have OPENROUTER_API_KEY),
 *     which proxies the same `anthropic/…` model slugs.
 * Returning `undefined` lets Stagehand read the provider key from the env on its
 * own, but we prefer to pass it explicitly so a missing key fails loudly here.
 */
function resolveAgentModel():
  | { modelName: string; apiKey: string; baseURL?: string }
  | undefined {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return { modelName: HYBRID_MODEL, apiKey: anthropicKey };
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return {
      modelName: HYBRID_MODEL,
      apiKey: openrouterKey,
      baseURL: "https://openrouter.ai/api/v1",
    };
  }
  return undefined;
}

/**
 * Run a single browser sub-agent task using Stagehand's hybrid agent.
 *
 * The hybrid agent autonomously plans and executes the WHOLE multi-step flow
 * on the page (screenshot → reason → click/type → verify), keeping context
 * between steps and self-healing when a site changes. This replaces the old
 * manual act()/split-into-steps approach, which lost context between steps.
 */
export async function doBrowserTask({
  startingPage,
  instruction,
  onLiveUrl,
  onLog,
  contextId,
  persist = false,
  maxSteps = DEFAULT_MAX_STEPS,
  taskTimeoutMs = TASK_TIMEOUT_MS,
}: {
  startingPage: string;
  /** The goal for the hybrid agent to accomplish on the page, in plain English. */
  instruction: string;
  /** Called with the Browserbase live-view URL as soon as the session starts. */
  onLiveUrl?: (url: string) => void;
  /** Called with human-readable progress logs. */
  onLog?: (message: string) => void;
  /**
   * Optional Browserbase Context id. When set, the session is launched with this
   * context so previously-saved cookies + localStorage (e.g. a Gmail / WhatsApp
   * login) are injected automatically.
   */
  contextId?: string;
  /**
   * When true, changes made during this session (fresh logins, new cookies) are
   * written back into the context. Sub-agents use `false` (read-only); the
   * interactive login flow uses `true`.
   */
  persist?: boolean;
  /** Max agent steps for this task. */
  maxSteps?: number;
  /** Overall wall-clock budget for the whole task. */
  taskTimeoutMs?: number;
}): Promise<BrowserTaskResult> {
  const result: BrowserTaskResult = { startingPage };

  let stagehand: Stagehand | undefined;

  try {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) throw new Error("Missing BROWSERBASE_API_KEY.");
    const projectId = process.env.BROWSERBASE_PROJECT_ID;

    // The on-page reasoning model needs its OWN credentials (separate from the
    // orchestrator's OpenRouter call). Resolve them up front and fail loudly if
    // none exist — otherwise Stagehand throws deep inside agent.execute() with
    // "Anthropic API key is missing" and the session just closes.
    const modelConfig = resolveAgentModel();
    if (!modelConfig) {
      throw new Error(
        "No LLM key for the on-page agent. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.",
      );
    }

    stagehand = new Stagehand({
      env: "BROWSERBASE",
      experimental: true, // Required for hybrid mode.
      apiKey,
      ...(projectId ? { projectId } : {}),
      // Give the tool-execution model (act/extract inside agent tools) the same
      // credentials so nothing falls back to a missing default provider key.
      model: modelConfig,
      // Inject the user's saved login context (cookies + localStorage) so the
      // agent may already be signed in. `persist` writes fresh logins back.
      ...(contextId
        ? {
            browserbaseSessionCreateParams: {
              ...(projectId ? { projectId } : {}),
              browserSettings: { context: { id: contextId, persist } },
            },
          }
        : {}),
      // Silence Stagehand's internal logger; we surface our own progress logs.
      logger: () => {},
    });

    await withTimeout(stagehand.init(), taskTimeoutMs, "stagehand init");

    if (contextId) {
      onLog?.(
        `Using shared login context ${contextId}${persist ? " (persisting)" : ""}`,
      );
    }

    // Surface the live-view URL so the UI can watch the agent in real time.
    try {
      const sessionId = stagehand.browserbaseSessionID;
      if (sessionId) {
        const bb = new Browserbase({ apiKey });
        const live = await bb.sessions.debug(sessionId);
        result.liveUrl = live.debuggerFullscreenUrl;
        onLiveUrl?.(live.debuggerFullscreenUrl);
        onLog?.(`Live view: ${live.debuggerFullscreenUrl}`);
      }
    } catch {
      /* live url is best-effort */
    }

    // Navigate to the starting page first. Starting the agent already on the
    // target page is far more reliable than asking it to navigate there.
    const page =
      stagehand.context.activePage() ??
      stagehand.context.pages()[0] ??
      (await stagehand.context.newPage());
    onLog?.(`Navigating to ${startingPage}`);
    await withTimeout(
      page.goto(startingPage, { waitUntil: "domcontentloaded" }),
      TOOL_TIMEOUT_MS,
      "navigation",
    ).catch((err) => onLog?.(`Navigation warning: ${toErrorMessage(err)}`));

    onLog?.(
      `On-page model: ${modelConfig.modelName} (hybrid${
        modelConfig.baseURL ? " via OpenRouter" : ""
      })`,
    );
    const agent = stagehand.agent({
      mode: "hybrid",
      model: {
        modelName: modelConfig.modelName,
        apiKey: modelConfig.apiKey,
        ...(modelConfig.baseURL ? { baseURL: modelConfig.baseURL } : {}),
      },
      systemPrompt:
        "You are a precise web automation agent. You interact with pages both " +
        "visually (screenshots/coordinates) and via the DOM. Complete the task " +
        "efficiently, verify each step actually took effect before moving on, " +
        "and recover from popups or transient failures instead of giving up. " +
        "When asked to read information, report exactly what is on the page.",
    });

    onLog?.(`Acting: ${instruction}`);
    const agentResult = await withTimeout(
      agent.execute({
        instruction,
        maxSteps,
        highlightCursor: true,
        toolTimeout: TOOL_TIMEOUT_MS,
      }),
      taskTimeoutMs,
      "agent execute",
    );

    result.success = agentResult.success;
    result.agentSummary = agentResult.message;

    // The agent reporting failure is a real failure the orchestrator should see.
    if (!agentResult.success && !agentResult.completed) {
      result.error =
        agentResult.message ||
        "The agent could not complete the requested action.";
      onLog?.(`Action failed: ${result.error}`);
    } else {
      onLog?.(`Done: ${agentResult.message}`);
    }

    return result;
  } catch (err) {
    result.error = toErrorMessage(err);
    onLog?.(`Error: ${result.error}`);
    return result;
  } finally {
    // Cleanup must never hang the parallel batch — bound it with a timeout.
    if (stagehand) {
      await withTimeout(
        Promise.resolve(stagehand.close()),
        CLEANUP_TIMEOUT_MS,
        "stagehand close",
      ).catch(() => {});
    }
  }
}
