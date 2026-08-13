import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `typescript.ignoreBuildErrors` used to be set here, which meant the build
  // passed while two real type errors sat in the code. The codebase now
  // typechecks clean, so the build is allowed to fail again when it should.
  experimental: {
    // Uploads are streamed straight through the proxy route, so the body size
    // limit that applies to buffered server actions is not the constraint here.
    // The real ceiling is enforced by the API (200 MB per file).
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
