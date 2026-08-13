import type { NextRequest } from 'next/server';

/**
 * Single proxy between the browser and the analysis API.
 *
 * This replaces twenty near-identical hand-written route files, each of which
 * hardcoded `http://localhost:8005` and buffered the whole request body into
 * memory before forwarding it. Buffering is fatal here: a 150 MB upload would
 * have to be held in the Node process in full before a single byte reached the
 * backend. The request body is piped straight through instead.
 */

const API_BASE = (
  process.env.CLEANYTICS_API_URL ?? 'http://127.0.0.1:8008'
).replace(/\/$/, '');

// Streaming a request body requires opting out of Next's static analysis and
// running on Node rather than the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hop-by-hop headers describe the connection between the client and *this*
// server, not the payload, so forwarding them corrupts the next hop.
//
// `expect` is the one that actually bit: clients sending a large body add
// `Expect: 100-continue`, and Node's HTTP client rejects the whole request with
// "expect header not supported" rather than ignoring it. Uploads failed at
// exactly 320 KB with a misleading "could not reach the service" error.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'expect',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const search = request.nextUrl.search;
  const target = `${API_BASE}/api/${path.join('/')}${search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Required by undici whenever a stream is used as the body; without it
      // the request is rejected before it is sent.
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',
    } as RequestInit & { duplex?: 'half' });

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
    console.error('[proxy] %s %s failed:', request.method, target, error, cause);

    const detail =
      error instanceof Error && error.message.includes('fetch failed')
        ? `Could not reach the analysis service at ${API_BASE}. Start it with: python backend/main.py${
            cause ? ` (${cause.message})` : ''
          }`
        : error instanceof Error
          ? error.message
          : 'Unknown error contacting the analysis service.';

    return Response.json({ detail }, { status: 502 });
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;
