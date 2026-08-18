import Browserbase from "@browserbasehq/sdk";
import { prisma } from "@/lib/prisma";
import "dotenv/config";

/**
 * Per-USER Browserbase Context.
 *
 * A Browserbase "Context" is an encrypted, persistent user-data-directory
 * (cookies, localStorage, cache). We give EACH user their own context so their
 * logins (Gmail, YouTube, WhatsApp, Discord, ...) are completely isolated from
 * every other user. The mapping userId -> browserbaseContextId lives in the
 * `BrowserContext` table.
 *
 * When a browser session is created with
 * `browserSettings.context = { id, persist }`:
 *   - the stored cookies/localStorage are injected into the fresh browser, and
 *   - if `persist: true`, changes (a fresh login) are saved back to the context.
 */

function bbClient(): Browserbase {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("Missing BROWSERBASE_API_KEY.");
  return new Browserbase({ apiKey });
}

/**
 * Return the id of the given user's Browserbase context, creating one on first
 * use. Uses an upsert so concurrent first-time calls can't create duplicates.
 */
export async function getOrCreateContextId(userId: string): Promise<string> {
  const existing = await prisma.browserContext.findUnique({
    where: { userId },
    select: { browserbaseContextId: true },
  });
  if (existing) return existing.browserbaseContextId;

  const bb = bbClient();
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const created = await bb.contexts.create(projectId ? { projectId } : {});

  const row = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId, browserbaseContextId: created.id },
    update: {},
    select: { browserbaseContextId: true },
  });
  return row.browserbaseContextId;
}

/**
 * Return the user's existing context id WITHOUT creating one, or null. Used by
 * sub-agents to inject saved logins only if the user has set some up.
 */
export async function getExistingContextId(
  userId: string,
): Promise<string | null> {
  const row = await prisma.browserContext.findUnique({
    where: { userId },
    select: { browserbaseContextId: true },
  });
  return row?.browserbaseContextId ?? null;
}

/**
 * Delete the user's saved login data: removes the Browserbase context (so the
 * encrypted cookies/localStorage are gone) and the local mapping row.
 */
export async function deleteContext(userId: string): Promise<void> {
  const row = await prisma.browserContext.findUnique({
    where: { userId },
    select: { browserbaseContextId: true },
  });
  if (!row) return;

  try {
    await bbClient().contexts.delete(row.browserbaseContextId);
  } catch {
    /* best-effort: still drop the local mapping even if remote delete fails */
  }
  await prisma.browserContext.delete({ where: { userId } }).catch(() => {});
}
