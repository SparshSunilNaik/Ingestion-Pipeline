import type { NextConfig } from "next";

// The browser talks only to this Next.js origin; /api/* is proxied to the local backend by the
// route handler in app/api/[...path]/route.ts (lib/proxy.ts), which reports an unreachable backend
// as a structured 503 instead of a bare 500. Same-origin requests let the backend use HttpOnly
// SameSite=Strict session cookies. The backend address comes from IP_BACKEND_URL.

const nextConfig: NextConfig = {
  // Separate output dir for isolated builds (e.g. end-to-end tests) so they never clobber the dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
