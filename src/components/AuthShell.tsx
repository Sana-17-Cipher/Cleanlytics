'use client';

import AuthProvider from './AuthProvider';

/**
 * Client-side shell that wraps the app with AuthProvider.
 *
 * RootLayout exports `metadata` which requires it to be a Server Component,
 * so the client boundary lives here instead.
 */
export default function AuthShell({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
