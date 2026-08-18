import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These are Node-only packages that must not be bundled by Turbopack.
  serverExternalPackages: [
    "@browserbasehq/stagehand",
    "@browserbasehq/sdk",
    "@prisma/client",
    "bcryptjs",
  ],
};

export default nextConfig;
