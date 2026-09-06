import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/video-creator";

function withoutBasePath(pathname: string) {
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname;
}

function isPublicPath(pathname: string) {
  return pathname === "/login" || pathname === "/api/auth/login" || pathname === "/api/auth/logout";
}

export async function middleware(request: NextRequest) {
  const pathname = withoutBasePath(request.nextUrl.pathname);
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico" || isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Bạn cần đăng nhập để sử dụng chức năng này." }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
