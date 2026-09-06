type ProviderConnection = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  isActive?: unknown;
};

type UsagePayload = {
  plan?: unknown;
  quotas?: {
    session?: Record<string, unknown>;
    weekly?: Record<string, unknown>;
  };
  resetCredits?: { availableCount?: unknown };
};

function cookieHeader(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() || headers.get("set-cookie")?.split(/,(?=\s*[^;,]+=)/) || [];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function quotaValue(value: Record<string, unknown> | undefined) {
  return {
    used: typeof value?.used === "number" ? value.used : null,
    remaining: typeof value?.remaining === "number" ? value.remaining : null,
    resetAt: typeof value?.resetAt === "string" ? value.resetAt : null,
  };
}

export const runtime = "nodejs";

export async function POST() {
  const baseUrl = (process.env.CODEX_QUOTA_BASE_URL || process.env.CODEX_QUOTA_BASE)?.trim().replace(/\/+$/, "");
  const password = process.env.CODEX_QUOTA_PASSWORD || process.env.CODEX_QUOTA_PASS;
  if (!baseUrl || !password) {
    return Response.json(
      { error: "Set CODEX_QUOTA_BASE_URL and CODEX_QUOTA_PASSWORD in .env.local." },
      { status: 503 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!login.ok) throw new Error(`Quota service login failed (${login.status}).`);
    const cookie = cookieHeader(login);
    if (!cookie) throw new Error("Quota service did not return a session cookie.");

    const providersResponse = await fetch(`${baseUrl}/api/providers`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!providersResponse.ok) throw new Error(`Could not load quota providers (${providersResponse.status}).`);
    const providers = await providersResponse.json() as { connections?: ProviderConnection[] };
    const connections = (providers.connections || []).filter(
      (connection) => connection.provider === "codex" && connection.isActive === true,
    );

    const accounts = await Promise.all(connections.map(async (connection) => {
      const id = typeof connection.id === "string" || typeof connection.id === "number" ? String(connection.id) : "";
      if (!id) throw new Error("Quota service returned provider without ID.");
      const usageResponse = await fetch(`${baseUrl}/api/usage/${encodeURIComponent(id)}`, {
        headers: { Cookie: cookie },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!usageResponse.ok) throw new Error(`Could not load usage for provider ${id} (${usageResponse.status}).`);
      const usage = await usageResponse.json() as UsagePayload;
      return {
        provider: "codex",
        account: typeof connection.name === "string" && connection.name.trim() ? connection.name : id,
        active: connection.isActive === true,
        plan: typeof usage.plan === "string" ? usage.plan : null,
        session: quotaValue(usage.quotas?.session),
        weekly: quotaValue(usage.quotas?.weekly),
        resetCredits: typeof usage.resetCredits?.availableCount === "number" ? usage.resetCredits.availableCount : null,
      };
    }));

    return Response.json({ accounts, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "Quota request timed out."
      : error instanceof Error ? error.message : "Could not load quota.";
    return Response.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
