"use client";

import { useMemo, useState } from "react";
import styles from "@/app/quota/page.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

type QuotaValue = { used: number | null; remaining: number | null; resetAt: string | null };
type QuotaAccount = {
  provider: string;
  account: string;
  active: boolean;
  plan: string | null;
  session: QuotaValue;
  weekly: QuotaValue;
  resetCredits: number | null;
};

const example = JSON.stringify([{
  provider: "codex",
  account: "example@example.com",
  active: true,
  plan: "pro",
  session: { used: 25, remaining: 75, resetAt: "2026-09-06T12:00:00Z" },
  weekly: { used: 40, remaining: 60, resetAt: "2026-09-10T12:00:00Z" },
  resetCredits: 1,
}], null, 2);

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeQuota(value: unknown): QuotaValue {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    used: numberOrNull(source.used),
    remaining: numberOrNull(source.remaining),
    resetAt: textOrNull(source.resetAt),
  };
}

function normalize(value: unknown): QuotaAccount[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map((row) => ({
      provider: textOrNull(row.provider) || "unknown",
      account: textOrNull(row.account) || "Unnamed account",
      active: row.active === true,
      plan: textOrNull(row.plan),
      session: normalizeQuota(row.session),
      weekly: normalizeQuota(row.weekly),
      resetCredits: numberOrNull(row.resetCredits),
    }));
}

function formatReset(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US");
}

function quotaPercent(quota: QuotaValue) {
  if (quota.used === null || quota.remaining === null) return null;
  const total = quota.used + quota.remaining;
  return total > 0 ? Math.min(100, Math.max(0, quota.used / total * 100)) : 0;
}

function QuotaBlock({ label, quota }: { label: string; quota: QuotaValue }) {
  const percent = quotaPercent(quota);
  return (
    <div className={styles.quotaBlock}>
      <div className={styles.quotaBlockHeader}><strong>{label}</strong>{percent !== null ? <span>{percent.toFixed(0)}% used</span> : null}</div>
      {percent !== null ? <div className={styles.progress}><span style={{ width: `${percent}%` }} /></div> : null}
      <div className={styles.quotaValues}><span>Used: <b>{quota.used ?? "—"}</b></span><span>Remaining: <b>{quota.remaining ?? "—"}</b></span></div>
      <small>Reset: {formatReset(quota.resetAt)}</small>
    </div>
  );
}

export default function QuotaChecker() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadedAt, setLoadedAt] = useState("");
  const parsed = useMemo(() => {
    if (!input.trim()) return { accounts: [] as QuotaAccount[], error: "" };
    try {
      return { accounts: normalize(JSON.parse(input)), error: "" };
    } catch {
      return { accounts: [] as QuotaAccount[], error: "Invalid JSON. Paste the exact output from jq ." };
    }
  }, [input]);

  function loadExample() {
    setInput(example);
  }

  async function loadQuota() {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`${basePath}/api/quota`, { method: "POST", cache: "no-store" });
      const body = await response.json() as { accounts?: unknown[]; fetchedAt?: string; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load quota.");
      setInput(JSON.stringify(body.accounts || [], null, 2));
      setLoadedAt(body.fetchedAt || new Date().toISOString());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load quota.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.inputHeader}>
        <div><h2>Quota response JSON</h2><p>Expected array fields: provider, account, active, plan, session, weekly, resetCredits.</p></div>
        <div className={styles.inputActions}><button type="button" onClick={loadQuota} disabled={loading}>{loading ? "Loading..." : "Load Quota"}</button><button type="button" onClick={loadExample}>Load Example</button><button type="button" onClick={() => { setInput(""); setLoadedAt(""); }} disabled={!input}>Clear</button></div>
      </div>
      <textarea className={styles.jsonInput} value={input} onChange={(event) => setInput(event.target.value)} placeholder='Paste response, for example: [{"provider":"codex","account":"..."}]' spellCheck={false} />
      {loadError ? <p className={styles.error} role="alert">{loadError}</p> : null}
      {loadedAt ? <p className={styles.loadedAt}>Loaded: {formatReset(loadedAt)}</p> : null}
      {parsed.error ? <p className={styles.error} role="alert">{parsed.error}</p> : null}
      {!parsed.error && !parsed.accounts.length ? <p className={styles.empty}>Paste JSON to show quota details.</p> : null}
      {parsed.accounts.length ? <div className={styles.accountGrid}>{parsed.accounts.map((account, index) => <article className={styles.accountCard} key={`${account.account}-${index}`}>
        <div className={styles.accountHeader}><div><span className={styles.provider}>{account.provider}</span><h3>{account.account}</h3></div><span className={account.active ? styles.active : styles.inactive}>{account.active ? "Active" : "Inactive"}</span></div>
        <div className={styles.accountMeta}><span>Plan: <b>{account.plan || "—"}</b></span><span>Reset credits: <b>{account.resetCredits ?? "—"}</b></span></div>
        <div className={styles.quotaGrid}><QuotaBlock label="Session" quota={account.session} /><QuotaBlock label="Weekly" quota={account.weekly} /></div>
      </article>)}</div> : null}
    </div>
  );
}
