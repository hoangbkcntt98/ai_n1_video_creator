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

export type QuotaValue = {
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
};

export type CodexQuotaAccount = {
  provider: "codex";
  account: string;
  active: boolean;
  plan: string | null;
  session: QuotaValue;
  weekly: QuotaValue;
  resetCredits: number | null;
};

function cookieHeader(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() || headers.get("set-cookie")?.split(/,(?=\s*[^;,]+=)/) || [];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function quotaValue(value: Record<string, unknown> | undefined): QuotaValue {
  return {
    used: typeof value?.used === "number" ? value.used : null,
    remaining: typeof value?.remaining === "number" ? value.remaining : null,
    resetAt: typeof value?.resetAt === "string" ? value.resetAt : null,
  };
}

function quotaServiceConfig() {
  const baseUrl = (process.env.CODEX_QUOTA_BASE_URL || process.env.CODEX_QUOTA_BASE)
    ?.trim().replace(/\/+$/, "");
  const password = process.env.CODEX_QUOTA_PASSWORD || process.env.CODEX_QUOTA_PASS;
  if (!baseUrl || !password) {
    throw new Error("Set CODEX_QUOTA_BASE_URL and CODEX_QUOTA_PASSWORD in .env.local.");
  }
  return { baseUrl, password };
}

export function configuredCodexQuotaAccount() {
  return (process.env.CODEX_QUOTA_ACCOUNT || "bugger485@gmail.com").trim();
}

export function configuredQuotaThresholdPercent() {
  const value = Number(process.env.CODEX_QUOTA_THRESHOLD_PERCENT || 10);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 10;
}

export async function loadCodexQuota(): Promise<{ accounts: CodexQuotaAccount[]; fetchedAt: string }> {
  const { baseUrl, password } = quotaServiceConfig();
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
        provider: "codex" as const,
        account: typeof connection.name === "string" && connection.name.trim() ? connection.name : id,
        active: connection.isActive === true,
        plan: typeof usage.plan === "string" ? usage.plan : null,
        session: quotaValue(usage.quotas?.session),
        weekly: quotaValue(usage.quotas?.weekly),
        resetCredits: typeof usage.resetCredits?.availableCount === "number" ? usage.resetCredits.availableCount : null,
      };
    }));

    return { accounts, fetchedAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "Quota request timed out."
      : error instanceof Error ? error.message : "Could not load quota.";
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadConfiguredCodexQuota() {
  const target = configuredCodexQuotaAccount().toLowerCase();
  if (!target) throw new Error("Set CODEX_QUOTA_ACCOUNT in .env.local.");
  const result = await loadCodexQuota();
  const account = result.accounts.find((item) => item.account.trim().toLowerCase() === target);
  if (!account) throw new Error(`Configured Codex account was not found: ${configuredCodexQuotaAccount()}.`);
  return { ...result, account };
}

function remainingPercent(value: QuotaValue) {
  if (value.used === null || value.remaining === null) return null;
  const total = value.used + value.remaining;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, value.remaining / total * 100));
}

/**
 * Stop when either known Codex limit reaches threshold. This avoids continuing
 * when session quota is exhausted even if weekly quota still has capacity.
 */
export function accountRemainingPercent(account: CodexQuotaAccount) {
  const values = [remainingPercent(account.session), remainingPercent(account.weekly)]
    .filter((value): value is number => value !== null);
  return values.length ? Math.min(...values) : null;
}
