import { PrismaClient } from "@prisma/client";

/**
 * A single shared PrismaClient. In development Next.js hot-reloads modules,
 * which would otherwise create a new client (and a new connection pool) on
 * every reload and exhaust the database connections. Caching it on
 * `globalThis` avoids that.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
