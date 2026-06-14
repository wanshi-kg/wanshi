import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // The run dashboard drives wanshi by spawning its CLI as a child process
  // (see server/run-registry.ts) — no wanshi code is bundled into the app, so
  // none of its native deps (whisper, ffmpeg, pdf2json) touch the Next build.
  reactStrictMode: true,
  // This app has its own lockfile but lives inside the wanshi repo (which also
  // has one); pin the tracing root to this dir so Next doesn't pick the parent.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
