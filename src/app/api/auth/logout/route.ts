import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ ...sessionCookieOptions, name: SESSION_COOKIE, value: "", maxAge: 0 });
  return response;
}
