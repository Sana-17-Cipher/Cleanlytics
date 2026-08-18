import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `typescript.ignoreBuildErrors` used to be set here, which meant the build
  // passed while two real type errors sat in the code. The codebase now
  // typechecks clean, so the build is allowed to fail again when it should.
  turbopack: {
    // Next infers the workspace root from the nearest lockfile, and an empty
    // `package-lock.json` in the parent folder made it pick the parent instead
    // of this directory. The root is what Turbopack resolves and watches, so
    // leaving it pointing a level too high widens the watch set for no reason.
    // Pinning it also silences the multiple-lockfiles warning on every start.
    root: __dirname,
  },
  experimental: {
    // Uploads are streamed straight through the proxy route, so the body size
    // limit that applies to buffered server actions is not the constraint here.
    // The real ceiling is enforced by the API (200 MB per file).
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
