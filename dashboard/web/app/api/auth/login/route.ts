// PIN login. Verifies the 6-digit PIN (constant-time), rate-limits per client
// IP, and on success writes an iron-session sealed cookie the middleware reads.
//
//   POST { pin } ─► locked? ─429
//                 ─► verify (scrypt + timingSafeEqual)
//                       fail ─► RateLimiter.fail, 401
//                       ok   ─► sealData({authed}), Set-Cookie httpOnly/secure, 200
//
// Node runtime (node:crypto). Behind Cloudflare Access + Tunnel, so the client
// IP arrives as cf-connecting-ip.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { sealData } from "iron-session";
import { verifyPin, RateLimiter } from "@/lib/auth-core";
import { SESSION_COOKIE, SESSION_TTL_SEC } from "@/lib/session-const";

export const runtime = "nodejs";

// Module-level singleton: one limiter shared across requests in this instance.
const limiter = new RateLimiter();

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.MERIDIAN_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }

  const ip = clientIp(req);
  const now = Date.now();
  if (limiter.locked(ip, now)) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as { pin?: unknown };
  const pin = typeof body.pin === "string" ? body.pin : "";

  if (!verifyPin(pin, process.env.MERIDIAN_DASHBOARD_PIN_HASH)) {
    limiter.fail(ip, now);
    return NextResponse.json({ error: "invalid PIN" }, { status: 401 });
  }

  limiter.reset(ip);
  const sealed = await sealData({ authed: true, at: now }, { password: secret, ttl: SESSION_TTL_SEC });
  (await cookies()).set(SESSION_COOKIE, sealed, {
    httpOnly: true,
    // `next dev` serves plain http://localhost, where a Secure cookie is dropped.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
  return NextResponse.json({ ok: true });
}
