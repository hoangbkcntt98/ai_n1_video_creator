"use client";

import { useState } from "react";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function LogoutButton() {
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch(`${basePath}/api/auth/logout`, { method: "POST" });
    window.location.href = `${basePath}/login`;
  }

  return <button type="button" onClick={() => void logout()} disabled={busy}>{busy ? "Logging out..." : "Log Out"}</button>;
}
