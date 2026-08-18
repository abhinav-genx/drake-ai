import Browserbase from "@browserbasehq/sdk";
import {
  getOrCreateContextId,
  getExistingContextId,
  deleteContext,
} from "@/utils/browser-context";
import { getCurrentUserId } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Interactive login flow for the CURRENT USER's Browserbase Context.
 *
 * Actions (POST body: { action }):
 *   - "status": report whether this user has saved any login data yet.
 *   - "start":  create a keep-alive session bound to the user's context with
 *               `persist: true`, and return its live-view URL so they can log in
 *               manually (Gmail, YouTube, WhatsApp, Discord, ...).
 *   - "save":   release the session so Browserbase writes the fresh cookies +
 *               localStorage back into the user's context.
 *   - "clear":  delete the user's context and saved login data entirely.
 */
export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  let action = "";
  let sessionId = "";
  try {
    const body = (await request.json()) as {
      action?: string;
      sessionId?: string;
    };
    action = (body.action ?? "").trim();
    sessionId = (body.sessionId ?? "").trim();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Missing BROWSERBASE_API_KEY." },
      { status: 500 },
    );
  }
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const bb = new Browserbase({ apiKey });

  try {
    if (action === "status") {
      const contextId = await getExistingContextId(userId);
      return Response.json({ hasLogin: Boolean(contextId), contextId });
    }

    if (action === "start") {
      const contextId = await getOrCreateContextId(userId);

      const session = await bb.sessions.create({
        ...(projectId ? { projectId } : {}),
        keepAlive: true,
        browserSettings: {
          context: { id: contextId, persist: true },
        },
      });

      const live = await bb.sessions.debug(session.id);

      return Response.json({
        sessionId: session.id,
        contextId,
        liveUrl: live.debuggerFullscreenUrl,
      });
    }

    if (action === "save") {
      if (!sessionId) {
        return Response.json(
          { error: "Missing 'sessionId'." },
          { status: 400 },
        );
      }
      // Releasing the session ends it cleanly; because it was created with
      // persist: true, the fresh cookies + localStorage are written back into
      // the user's context.
      await bb.sessions.update(sessionId, {
        status: "REQUEST_RELEASE",
        ...(projectId ? { projectId } : {}),
      });
      return Response.json({ ok: true });
    }

    if (action === "clear") {
      await deleteContext(userId);
      return Response.json({ ok: true });
    }

    return Response.json({ error: `Unknown action '${action}'.` }, {
      status: 400,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
