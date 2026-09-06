import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "video_creator_session";
const ISSUER = "video-creator";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function secret() {
  const value = process.env.APP_AUTH_SECRET?.trim();
  return value ? new TextEncoder().encode(value) : null;
}

export function authConfigured() {
  return Boolean(
    process.env.APP_AUTH_USERNAME?.trim() &&
    process.env.APP_AUTH_PASSWORD &&
    process.env.APP_AUTH_SECRET?.trim(),
  );
}

export function configuredUsername() {
  return process.env.APP_AUTH_USERNAME?.trim() || "";
}

export async function createSessionToken(username: string) {
  const key = secret();
  if (!key) throw new Error("Thiếu APP_AUTH_SECRET.");
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(username)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySessionToken(token: string | undefined) {
  const key = secret();
  if (!key || !token) return false;
  try {
    const result = await jwtVerify(token, key, { issuer: ISSUER });
    return typeof result.payload.sub === "string" && result.payload.sub.length > 0;
  } catch {
    return false;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};
