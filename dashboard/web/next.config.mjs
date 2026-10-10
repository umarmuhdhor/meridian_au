import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {(phase: string) => import('next').NextConfig} */
const nextConfig = (phase) => ({
  reactStrictMode: true,
  // Dashboard is localhost-only; no image optimization / telemetry needs.
  eslint: { ignoreDuringBuilds: true },
  // Pin file-tracing to this app (the repo root also has a lockfile, which Next
  // would otherwise infer as the workspace root).
  outputFileTracingRoot: __dirname,
  // `next dev` gets its own build dir. pm2's `next start` serves the production
  // build from `.next`; a dev server sharing that dir overwrites it, and the next
  // pm2 restart then crash-loops with "Could not find a production build"
  // (took the public dashboard down 2026-10-07).
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
});

export default nextConfig;
