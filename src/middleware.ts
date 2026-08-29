import { type NextRequest, NextResponse } from 'next/server';

/**
 * Route-protecting middleware.
 *
 * Checks for the Supabase auth cookies. If the user is not authenticated they
 * are redirected to /login. Public routes (/login, static assets, API proxy)
 * are always allowed through.
 */

const PUBLIC_PATHS = new Set(['/login']);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow: public pages, API routes (the backend handles its own auth),
  // Next.js internals, and static files.
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
  }

  // Supabase stores auth in cookies prefixed with `sb-<project-ref>-auth-token`.
  // The @supabase/ssr library may chunk them as `.0`, `.1`, etc.
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));

  if (!hasAuthCookie) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.hash = '';
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except static assets and Next.js internals
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
