// Dashboard auth gate (edge runtime).
//
//   request ─► middleware
//               │  /login, /api/auth/*, static  ─► allow
//               │  valid session cookie          ─► allow
//               │  no/invalid cookie, /api/*      ─► 401 (XHR/SSE fail clean)
//               └─ no/invalid cookie, page        ─► redirect /login?next=…
//
// The session cookie is an iron-session sealed blob ({ authed: true }). We
// only unseal here (edge-safe via iron-session's uncrypto); it is written in
// app/api/auth/login. The daemon bridge (127.0.0.1:8787) is never reachable
// from the internet — this only gates the human-facing dashboard.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { unsealData } from "iron-session";
import { SESSION_COOKIE, SESSION_TTL_SEC } from "@/lib/session-const";

interface Sealed {
  authed?: boolean;
}

async function isAuthed(req: NextRequest): Promise<boolean> {
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookie) return false;
  const password = process.env.MERIDIAN_SESSION_SECRET;
  if (!password || password.length < 32) return false;
  try {
    const data = await unsealData<Sealed>(cookie, { password, ttl: SESSION_TTL_SEC });
    return data?.authed === true;
  } catch {
    return false;
  }
}

/**
 * Point an absolute redirect url at the hostname the visitor actually asked for.
 *
 * Next derives `req.nextUrl`'s origin from the server's own bind address (and
 * normalises 127.0.0.1 -> localhost), NOT from the request headers — so behind
 * any reverse proxy `NextResponse.redirect(req.nextUrl)` emits
 * `https://localhost:3000/login` and bounces the visitor to *their* machine.
 * A relative Location would sidestep all of this, but Next's middleware adapter
 * parses Location as an absolute url and throws ERR_INVALID_URL on a path.
 *
 * `Host` is set by the edge (cloudflared and Caddy both pass the requested
 * hostname through), so it is preferred; `x-forwarded-host` is the fallback for
 * proxies that rewrite Host instead. Both only ever redirect a visitor to the
 * host they themselves supplied, so a forged value harms nobody else.
 */
function applyPublicOrigin(url: URL, req: NextRequest): void {
  const raw = req.headers.get("host") ?? req.headers.get("x-forwarded-host");
  const host = raw?.split(",")[0]?.trim();
  if (!host) return;
  // Split host:port on the LAST colon, but never inside a bracketed IPv6 literal.
  const colon = host.lastIndexOf(":");
  const hasPort = colon > host.lastIndexOf("]");
  url.hostname = hasPort ? host.slice(0, colon) : host;
  url.port = hasPort ? host.slice(colon + 1) : "";
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto === "http" || proto === "https") url.protocol = `${proto}:`;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Public: the login page and the auth endpoints themselves.
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  if (await isAuthed(req)) return NextResponse.next();

  // Unauthenticated. APIs get a clean 401 (so fetch/EventSource don't follow a
  // 30x into an HTML login page); pages redirect to the PIN screen.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  applyPublicOrigin(url, req);
  return NextResponse.redirect(url);
}

// Run on everything except Next internals and static assets. /login and
// /api/auth are allowed inside the handler (kept in the matcher so a stale
// cookie on /login still short-circuits correctly).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp)$).*)"],
};
