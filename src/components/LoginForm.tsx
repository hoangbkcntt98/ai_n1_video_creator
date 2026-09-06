"use client";

import { FormEvent, useState } from "react";
import styles from "@/app/login/page.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${basePath}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Log in failed.");
      const next = new URLSearchParams(window.location.search).get("next");
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : `${basePath}/`;
      window.location.href = safeNext;
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Log in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
      <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
      {error ? <p className={styles.error}>{error}</p> : null}
      <button type="submit" disabled={busy}>{busy ? "Logging in..." : "Log In"}</button>
    </form>
  );
}
