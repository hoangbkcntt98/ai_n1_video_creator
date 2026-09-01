"use client";

import { useEffect, useState } from "react";
import type { Run } from "@/lib/pipeline";
import styles from "./RunHistory.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

type LogState = { text: string; error?: string; loading: boolean };

function formatRunName(run: Run) {
  return run.pattern_name ? `${run.pattern_name} (#${run.pattern_id})` : run.action === "publish" ? "Facebook upload" : "Pipeline chọn mẫu kế tiếp";
}

export default function RunHistory({ runs }: { runs: Run[] }) {
  const [logs, setLogs] = useState<Record<number, LogState>>({});

  async function loadLog(runId: number) {
    setLogs((current) => ({ ...current, [runId]: { text: current[runId]?.text || "", loading: true } }));
    try {
      const response = await fetch(`${basePath}/api/runs/${runId}/log`, { cache: "no-store" });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) throw new Error("Endpoint log trả về dữ liệu không hợp lệ.");
      const payload = await response.json() as { log?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Không đọc được log.");
      setLogs((current) => ({ ...current, [runId]: { text: payload.log || "Chưa có dữ liệu log.", loading: false } }));
    } catch (error) {
      setLogs((current) => ({ ...current, [runId]: { text: "", error: error instanceof Error ? error.message : "Không đọc được log.", loading: false } }));
    }
  }

  useEffect(() => {
    const activeRuns = runs.filter((run) => run.status === "running");
    activeRuns.forEach((run) => { void loadLog(run.id); });
    if (!activeRuns.length) return;
    const interval = window.setInterval(() => activeRuns.forEach((run) => { void loadLog(run.id); }), 1500);
    return () => window.clearInterval(interval);
  }, [runs]);

  if (!runs.length) return <p className={styles.empty}>Chưa có run. Pipeline mới sẽ hiện ở đây.</p>;

  return <div className={styles.list}>{runs.map((run) => {
    const log = logs[run.id];
    return <article className={styles.run} key={run.id}>
      <div className={styles.summary}>
        <span className={`${styles.status} ${styles[run.status]}`}>{run.status}</span>
        <div><strong>#{run.id} · {run.action}</strong><p>{formatRunName(run)}</p>{run.error ? <p className={styles.error}>{run.error}</p> : null}</div>
        <time>{new Date(run.started_at).toLocaleString("vi-VN")}</time>
      </div>
      {run.status === "running" || log ? <div className={styles.logArea}>
        <div className={styles.logTitle}><strong>Python output</strong><span>{log?.loading ? "Đang cập nhật..." : run.status === "running" ? "Tự cập nhật 1.5 giây" : "Run đã kết thúc"}</span><button type="button" onClick={() => void loadLog(run.id)} disabled={log?.loading}>Tải log</button></div>
        {log?.error ? <p className={styles.logError}>{log.error}</p> : <pre>{log?.text || "Đang chờ output từ Python..."}</pre>}
      </div> : <button className={styles.showLog} type="button" onClick={() => void loadLog(run.id)}>Xem Python output</button>}
    </article>;
  })}</div>;
}
