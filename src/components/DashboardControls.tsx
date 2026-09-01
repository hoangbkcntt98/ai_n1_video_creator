"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { GrammarPattern } from "@/lib/dashboard";

type Props = { patterns: GrammarPattern[] };
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function DashboardControls({ patterns }: Props) {
  const router = useRouter();
  const [patternId, setPatternId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 8000);
    return () => window.clearInterval(timer);
  }, [router]);

  async function start(action: "create_next" | "generate_pattern") {
    setBusy(true); setMessage("");
    try {
      const selected = patterns.find((item) => String(item.id) === patternId);
      if (action === "generate_pattern" && !selected) throw new Error("Chọn mẫu ngữ pháp trước.");
      const response = await fetch(`${basePath}/api/runs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, patternId: selected?.id, patternName: selected?.pattern }) });
      const body = await response.json() as { error?: string; run?: { id: number } };
      if (!response.ok) throw new Error(body.error || "Không khởi động được pipeline.");
      setMessage(`Đã tạo pipeline run #${body.run?.id}. Trang tự làm mới mỗi 8 giây.`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Có lỗi."); }
    finally { setBusy(false); }
  }

  return <section className="createPanel">
    <div><p className="eyebrow">JLPT N1 PIPELINE</p><h1>Tạo video học tiếng Nhật</h1><p>LLM, ảnh, TTS, ghép MP4 dùng pipeline jlpt-n1. Tạo video không tự đăng Facebook.</p></div>
    <div className="actions">
      <button disabled={busy} className="primary" onClick={() => start("create_next")}>Tạo mẫu kế tiếp</button>
      <select value={patternId} disabled={busy || !patterns.length} onChange={(event) => setPatternId(event.target.value)} aria-label="Mẫu ngữ pháp">
        <option value="">Chọn mẫu có sẵn</option>{patterns.map((item) => <option key={item.id} value={item.id}>#{item.id} · {item.pattern} · {item.processingStatus}</option>)}
      </select>
      <button disabled={busy || !patterns.length} onClick={() => start("generate_pattern")}>Tạo lại mẫu đã chọn</button>
    </div>
    {message && <p className="runMessage" role="status">{message}</p>}
  </section>;
}
