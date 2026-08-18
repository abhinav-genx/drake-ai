import { z } from "zod/v4";
import { prisma } from "@/lib/prisma";
import { verifyPassword, setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input." }, { status: 400 });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // Always run a comparison to avoid leaking whether the email exists via timing,
  // then return the same generic error for both bad-email and bad-password.
  const ok = user
    ? await verifyPassword(password, user.hashedPassword)
    : await verifyPassword(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidin");

  if (!user || !ok) {
    return Response.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  await setSessionCookie(user.id);
  return Response.json({ user: { id: user.id, email: user.email } });
}
