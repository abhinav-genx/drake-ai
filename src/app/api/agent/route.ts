import { Agent, type AgentEvent, type Message } from "@/agent";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SYSTEM_PROMPT } from "@/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  let prompt = "";
  let conversationId: string | undefined;
  try {
    const body = (await request.json()) as {
      prompt?: string;
      conversationId?: string;
    };
    prompt = (body.prompt ?? "").trim();
    conversationId = body.conversationId?.trim() || undefined;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!prompt) {
    return Response.json({ error: "Missing 'prompt'." }, { status: 400 });
  }

  // Load or create the conversation (scoped to this user), and rebuild history.
  let conversation = conversationId
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      })
    : null;

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { userId, title: prompt.slice(0, 60) },
      include: { messages: true },
    });
  }

  const history: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversation.messages.map((m) => ({
      role: m.role as Message["role"],
      content: m.content,
    })),
  ];

  // Persist the incoming user message.
  await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: prompt },
  });

  const convId = conversation.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (
        event: AgentEvent | { type: "done"; conversationId?: string },
      ) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      const agent = new Agent(history, { onEvent: send, userId });

      try {
        const finalText = await agent.startLoop(prompt);
        // Persist the assistant's final answer.
        if (finalText) {
          await prisma.message.create({
            data: {
              conversationId: convId,
              role: "assistant",
              content: finalText,
            },
          });
        }
      } catch (err) {
        send({
          type: "error",
          agentId: "root",
          depth: 0,
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        send({ type: "done", conversationId: convId });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
