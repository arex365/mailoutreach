import type { NextConfig } from "next";

// The public https address (Cloudflare Tunnel), e.g. https://outreach.example.com.
// Next.js checks the Origin of Server Actions; the LAN address and a tunnel that passes
// the Host header through already work, this is only a safeguard (PLAN.md B1).
const publicHost = (() => {
  try {
    return process.env.APP_PUBLIC_URL ? new URL(process.env.APP_PUBLIC_URL).host : null;
  } catch {
    return null;
  }
})();

const nextConfig: NextConfig = {
  // better-sqlite3 and @prisma/client are external by default; the adapter is not. The Anthropic SDK is loaded from
  // node_modules too (Settings › AI checks the key from the web process, M5-DESIGN §5.5).
  serverExternalPackages: ["@prisma/adapter-better-sqlite3", "@anthropic-ai/sdk"],
  poweredByHeader: false,
  // A stray package-lock.json in the user's home folder would otherwise be taken as the root.
  turbopack: { root: import.meta.dirname },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
      ...(publicHost ? { allowedOrigins: [publicHost] } : {}),
    },
  },
};

export default nextConfig;
