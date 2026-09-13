"use client";

import { useEffect, useState } from "react";
import type { WordCreatorJob } from "@/lib/wordCreatorJobs";
import type { WordCreatorSource } from "@/lib/wordCreator";
import PatternVideoButton from "./PatternVideoButton";
import styles from "./WordCreator.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
type Question = { id: number; source: string; required_vocabulary: string; answer_a: string; answer_b: string; answer_c: string; answer_d: string; correct_index: number; correct_answer: string; template_path: string; video_path: string | null; duration_seconds: number | null; fps: number; };

function videoUrl(relativePath: string) {
  const bytes = new TextEncoder().encode(relativePath);
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("/", "_").replaceAll("+", "-").replace(/=+$/, "");
  return `${basePath}/api/videos/${encoded}`;
}

async function readJson<T>(response: Response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    if (response.status === 504) {
      throw new Error("Gateway hết thời gian chờ (HTTP 504). Tác vụ đã nhận vẫn chạy nền; không cần tạo lại.");
    }
    throw new Error(`API trả về HTML thay vì JSON (HTTP ${response.status}).`);
  }
}

async function loadQuestions(signal?: AbortSignal) {
  const response = await fetch(`${basePath}/api/word-creator`, { cache: "no-store", signal });
  const body = await readJson<{ questions?: Question[]; job?: WordCreatorJob | null; error?: string }>(response);
  if (!response.ok) throw new Error(body.error || "Không đọc được danh sách.");
  return body;
}

export default function WordCreator() {
  const [limit, setLimit] = useState("10");
  const [durationSeconds, setDurationSeconds] = useState("10");
  const [fps, setFps] = useState("25");
  const [autoFps, setAutoFps] = useState(true);
  const [source, setSource] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceOffset, setSourceOffset] = useState(0);
  const [sources, setSources] = useState<WordCreatorSource[]>([]);
  const [hasMoreSources, setHasMoreSources] = useState(false);
  const [sourcesError, setSourcesError] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState<WordCreatorJob | null>(null);
  const [error, setError] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);

  const activeJobId = job && (job.status === "queued" || job.status === "running") ? job.id : null;
  const busy = loading || submitting || activeJobId !== null;
  const message = job
    ? job.status === "queued" ? "Đã nhận tác vụ. Đang chờ tạo video..."
      : job.status === "running"
        ? `Đang xử lý ${job.processed}/${job.total} record, đã tạo ${job.generated} video.${job.current_source ? ` Source: ${job.current_source}` : ""}`
        : `Đã tạo ${job.generated}/${job.total} video.${job.error ? ` Lỗi: ${job.error}` : ""}${job.errors.length ? ` Lỗi: ${job.errors.map((item) => `${item.source}: ${item.error}`).join(" | ")}` : ""}`
    : "";

  useEffect(() => {
    const controller = new AbortController();
    void loadQuestions(controller.signal).then((body) => {
      if (controller.signal.aborted) return;
      setQuestions(body.questions || []);
      setJob(body.job || null);
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Không đọc được danh sách.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setSourcesLoading(true);
      try {
        const response = await fetch(`${basePath}/api/word-creator?sources=1&q=${encodeURIComponent(sourceSearch)}&offset=${sourceOffset}`,
          { cache: "no-store", signal: controller.signal });
        const body = await readJson<{ sources?: WordCreatorSource[]; hasMore?: boolean; error?: string }>(response);
        if (!response.ok) throw new Error(body.error || "Không đọc được Kanji từ Anki.");
        if (controller.signal.aborted) return;
        setSources(body.sources || []);
        setHasMoreSources(body.hasMore || false);
        setSourcesError("");
      } catch (err) {
        if (!controller.signal.aborted) setSourcesError(err instanceof Error ? err.message : "Không đọc được Kanji.");
      } finally {
        if (!controller.signal.aborted) setSourcesLoading(false);
      }
    };
    const timer = setTimeout(() => void load(), 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sourceSearch, sourceOffset]);

  useEffect(() => {
    if (!activeJobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const response = await fetch(`${basePath}/api/word-creator?jobId=${encodeURIComponent(activeJobId)}`, {
          cache: "no-store", signal: controller.signal,
        });
        const body = await readJson<{ job?: WordCreatorJob; error?: string }>(response);
        if (!response.ok || !body.job) {
          if (response.status === 401 || response.status === 404) again = false;
          throw new Error(body.error || "Không đọc được tiến độ.");
        }
        if (controller.signal.aborted) return;
        setError("");
        const finished = body.job.status === "completed" || body.job.status === "failed";
        if (finished) {
          // Refresh the list before changing job state (which cleans up this effect).
          const snapshot = await loadQuestions(controller.signal);
          if (controller.signal.aborted) return;
          setQuestions(snapshot.questions || []);
          again = false;
        }
        setJob(body.job);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Không đọc được tiến độ.");
      } finally {
        // Network/proxy errors retry polling, never resubmit the render request.
        if (again && !controller.signal.aborted) timer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeJobId]);

  async function generate() {
    const frameRate = Number(fps);
    if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 60) {
      setError("FPS phải là số nguyên từ 1 đến 60.");
      return;
    }
    setSubmitting(true); setError("");
    try {
      const response = await fetch(`${basePath}/api/word-creator`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: Number(limit), source: source.trim() || undefined, durationSeconds: Number(durationSeconds), fps: frameRate, autoFps }) });
      const body = await readJson<{ job?: WordCreatorJob; error?: string }>(response);
      if (!response.ok || !body.job) throw new Error(body.error || "Không tạo được WordCreator.");
      setJob(body.job);
    } catch (err) { setError(err instanceof Error ? err.message : "Không tạo được WordCreator."); }
    finally { setSubmitting(false); }
  }

  return <div className={styles.layout}>
    <section className={styles.panel}>
      <div className={styles.fields}>
        <label>Tìm Kanji / từ vựng<input value={sourceSearch} onChange={(event) => { setSourceSearch(event.target.value); setSourceOffset(0); }} placeholder="遭, 遭う..." disabled={busy} /></label>
        <label>Chọn Kanji<select value={source} onChange={(event) => setSource(event.target.value)} disabled={busy || sourcesLoading}>
          <option value="">Tự động chọn theo số record</option>
          {source && !sources.some((item) => item.source === source) ? <option value={source}>{source} (đã chọn)</option> : null}
          {sources.map((item) => <option key={item.source} value={item.source}>{item.source} · {item.vocabulary} ({item.note_count} record)</option>)}
        </select></label>
        <label>Số record<input type="number" min="1" max="500" value={limit} onChange={(event) => setLimit(event.target.value)} disabled={busy} /></label>
        <label>Thời lượng video (giây)<input type="number" min="1" max="300" step="1" value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} disabled={busy} /></label>
        <label>FPS<input type="number" min="1" max="60" step="1" value={fps} onChange={(event) => setFps(event.target.value)} disabled={busy} /></label>
        <label>Tự động khớp FPS theo GIF<input type="checkbox" checked={autoFps} onChange={(event) => setAutoFps(event.target.checked)} disabled={busy} /></label>
        <button type="button" className="primary" onClick={() => void generate()} disabled={busy}>{busy ? "Đang tạo..." : "Generate WordCreator"}</button>
      </div>
      <div className={styles.sourcePages}>
        <button type="button" disabled={busy || sourcesLoading || sourceOffset === 0} onClick={() => setSourceOffset(Math.max(0, sourceOffset - 100))}>Kanji trước</button>
        <span>{sourcesLoading ? "Đang tải Kanji..." : `Trang ${sourceOffset / 100 + 1} · ${sources.length} Kanji`}</span>
        <button type="button" disabled={busy || sourcesLoading || !hasMoreSources} onClick={() => setSourceOffset(sourceOffset + 100)}>Kanji tiếp</button>
      </div>
      {sourcesError ? <p className={styles.error}>{sourcesError}</p> : null}
      <p className={styles.hint}>FPS mặc định 25. Bật tự động: chọn FPS khớp thời lượng frame GIF (tối đa 60); không có GIF giữ FPS đã nhập. Tắt để dùng FPS cố định. Card và log hiển thị FPS thực tế.</p>
      <p className={styles.hint}>Nguồn: anki_ai_notes với note_type = AIKanjiWithImage. File lưu trong WORD_CREATOR_OUTPUT_DIR hoặc DATA_DIR/word-creator.</p>
      {activeJobId ? <p className={styles.hint}>Video chạy nền. Có thể tải lại trang để xem tiến độ.</p> : null}
      {message ? <p role="status" className={job?.status === "failed" || job?.errors.length ? styles.error : styles.success}>{message}</p> : null}{error ? <p className={styles.error}>{error}</p> : null}
      <h3>Log tạo video</h3>
      <p className={styles.hint}>200 dòng gần nhất của tác vụ. Log lưu trong DB, cập nhật cùng tiến độ.</p>
      <pre className={styles.log} role="log" aria-label="Log tạo video">{job?.logs?.length
        ? job.logs.map((line) => `[${new Date(line.created_at).toLocaleString("vi-VN")}] ${line.level.toUpperCase()}${line.source ? ` [${line.source}]` : ""} ${line.message}`).join("\n")
        : "Chưa có log cho tác vụ này."}</pre>
    </section>
    <section className={styles.panel}>
      <div className={styles.title}><h2>Câu hỏi đã lưu</h2><span>{questions.length}</span></div>
      {questions.length ? <div className={styles.table}>{questions.map((question) => <article key={question.id}>
        {question.video_path ? <video
          key={question.video_path}
          className={styles.video}
          src={videoUrl(question.video_path)}
          controls
          playsInline
          preload="none"
          aria-label={`Video ${question.required_vocabulary}`}
        /> : <div className={styles.noVideo}>Chưa có video</div>}
        <div className={styles.cardInfo}>
          <strong>{question.required_vocabulary}</strong>
          <small>{question.source} · Đúng: {question.correct_answer} · {question.duration_seconds || 10}s · {question.fps ?? 30} FPS</small>
          <div>A. {question.answer_a} · B. {question.answer_b} · C. {question.answer_c} · D. {question.answer_d}</div>
          <code>{question.template_path}</code>
          {question.video_path ? <a href={videoUrl(question.video_path)} target="_blank" rel="noopener noreferrer">Mở video</a> : null}
          {question.video_path ? <PatternVideoButton
            key={question.video_path}
            patternId={question.id}
            patternName={question.required_vocabulary}
            videoPath={question.video_path}
            label="Upload / Lên lịch"
          /> : null}
        </div>
      </article>)}</div> : <p className={styles.hint}>Chưa có dữ liệu.</p>}
    </section>
  </div>;
}
