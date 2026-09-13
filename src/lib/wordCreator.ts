import { promises as fs } from "node:fs";
import { randomInt } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { appConfig, toRelativeOutputPath } from "@/lib/config";
import { ensureWordCreatorSchema, query } from "@/lib/db";
import { runCommand } from "@/lib/studio";
import { saveVideoDetails } from "@/lib/video";

type AnkiNote = {
  anki_note_id: number;
  source: string;
  fields_json: Record<string, unknown> | null;
};

export type WordCreatorQuestion = {
  id: number;
  anki_note_id: number | null;
  source: string;
  required_vocabulary: string;
  answer_a: string;
  answer_b: string;
  answer_c: string;
  answer_d: string;
  correct_index: number;
  correct_answer: string;
  template_path: string;
  video_path: string | null;
  duration_seconds: number | null;
  fps: number;
  created_at: string;
};

export type WordCreatorResult = {
  source: string;
  requiredVocabulary: string;
  path: string;
  videoPath: string;
  durationSeconds: number;
  fps: number;
  correctAnswer: string;
  answers: string[];
};

export type WordCreatorOptions = {
  limit?: number; source?: string; durationSeconds?: number; fps?: number; autoFps?: boolean;
  scheduled?: boolean; forceRecreate?: boolean; pipelineRunId?: number;
};
export type WordCreatorLogger = (message: string, level?: "info" | "error", source?: string) => Promise<void>;
export type WordCreatorSource = { source: string; vocabulary: string; note_count: number };
export type WordCreatorProgress = {
  total: number;
  processed: number;
  generated: number;
  currentSource: string | null;
  errors: Array<{ source: string; error: string }>;
};

let ankiPool: Pool | undefined;

function getAnkiPool() {
  if (!ankiPool) ankiPool = new Pool({ connectionString: appConfig.ankiDatabaseUrl(), max: 3 });
  return ankiPool;
}

function safeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function safeFileName(value: string) {
  const cleaned = value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "word").slice(0, 150);
}

async function findLibraryAsset(fileName: string) {
  const libraryDir = path.join(appConfig.dataDir(), "video-studio", "library", "images");
  const names = await fs.readdir(libraryDir).catch(() => []);
  const match = names.find((name) => name === fileName || name.endsWith(`-${fileName}`));
  return match ? path.join(libraryDir, match) : null;
}

async function copyHtmlAssets(html: string, htmlPath: string) {
  const outputDir = path.dirname(htmlPath);
  const references = [
    ...[...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]),
    ...[...html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((match) => match[1]),
  ]
    .filter((value) => value && !/^(?:data:|https?:|file:|#)/i.test(value));
  for (const reference of new Set(references)) {
    const relative = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    const target = path.resolve(outputDir, relative);
    if (!target.startsWith(`${outputDir}${path.sep}`)) continue;
    if (await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) continue;
    const templateAsset = path.resolve(process.cwd(), relative);
    const source = await fs.stat(templateAsset).then((stat) => stat.isFile() ? templateAsset : null).catch(() => null)
      || await findLibraryAsset(path.basename(relative));
    if (source) await fs.copyFile(source, target);
  }
}

async function renderHtmlVideo(htmlPath: string, source: string, durationSeconds: number, fps: number, autoFps: boolean, log: WordCreatorLogger, dataPath?: string) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const outputDir = path.join(appConfig.outputDir(), date, "word-creator");
  await fs.mkdir(outputDir, { recursive: true });
  const videoPath = path.join(outputDir, `${Date.now()}-${safeFileName(source)}_word.mp4`);
  let buffered = "";
  let pending = Promise.resolve();
  let logError: unknown;
  const append = (line: string) => {
    if (!line || line.startsWith("WORD_CREATOR_RESULT=")) return;
    pending = pending.then(() => log(line, "info", source)).catch((error) => { logError = error; });
  };
  let output;
  try {
    output = await runCommand(process.execPath, [
    path.join(process.cwd(), "html-to-image.js"),
    "--html", htmlPath,
    "--output", videoPath,
    "--duration", durationSeconds.toFixed(3),
    "--fps", String(fps),
    ...(!autoFps ? ["--fixed-fps"] : []),
    ...(typeof dataPath === "string" && dataPath ? ["--data", dataPath] : []),
    ], (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      lines.forEach(append);
    });
  } finally {
    append(buffered);
    await pending;
  }
  if (logError) throw logError;
  const line = output.stdout.split("\n").find((line) => line.startsWith("WORD_CREATOR_RESULT="));
  if (!line) throw new Error("Renderer không trả về FPS thực tế.");
  const rendered = JSON.parse(line.slice("WORD_CREATOR_RESULT=".length)) as { fps?: unknown };
  if (typeof rendered.fps !== "number" || !Number.isInteger(rendered.fps) || rendered.fps < 1 || rendered.fps > 60) {
    throw new Error("Renderer trả FPS không hợp lệ.");
  }
  return { videoPath, fps: rendered.fps };
}

async function renderHtmlVideoWithQuiz(htmlPath: string, source: string, durationSeconds: number, fps: number, autoFps: boolean, log: WordCreatorLogger, quizData: Record<string, string>) {
  const jsonPath = htmlPath.replace(/\.html$/i, ".json");
  await fs.writeFile(jsonPath, JSON.stringify(quizData), "utf8");
  try {
    return await renderHtmlVideo(htmlPath, source, durationSeconds, fps, autoFps, log, jsonPath);
  } finally {
    await fs.unlink(jsonPath).catch(() => {});
  }
}

function parseJsonResponse(text: string): unknown {
  const withoutFence = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1));
    throw new Error("AI trả về JSON không hợp lệ.");
  }
}

function validateAnswers(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("AI không trả về danh sách đáp án.");
  const candidate = value as { answers?: unknown; correctIndex?: unknown };
  if (!Array.isArray(candidate.answers) || candidate.answers.length !== 4 || !candidate.answers.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("AI phải trả đúng 4 đáp án.");
  }
  const answers = candidate.answers.map((item) => (item as string).trim());
  if (new Set(answers).size !== 4) throw new Error("AI trả về đáp án trùng nhau.");
  const correctIndex = Number(candidate.correctIndex);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) throw new Error("AI trả về correctIndex không hợp lệ.");
  return { answers, correctIndex };
}

function randomizeCorrectAnswer(answers: string[], correctIndex: number) {
  const targetIndex = randomInt(0, answers.length);
  if (targetIndex !== correctIndex) {
    [answers[targetIndex], answers[correctIndex]] = [answers[correctIndex], answers[targetIndex]];
  }
  return { answers, correctIndex: targetIndex };
}

type LlmChatPayload = {
  choices?: Array<{
    message?: { content?: unknown };
    delta?: { content?: unknown };
    text?: unknown;
  }>;
  error?: { message?: unknown };
};

function payloadContent(payload: LlmChatPayload): string | null {
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

function ssePayloadFromEvents(events: string[]): LlmChatPayload {
  let completePayload: LlmChatPayload | undefined;
  let streamedContent = "";
  let streamedText = "";
  let lastPayload: LlmChatPayload | undefined;

  for (const event of events) {
    const trimmed = event.trim();
    if (!trimmed || trimmed === "[DONE]") continue;

    let parsed: LlmChatPayload;
    try {
      parsed = JSON.parse(trimmed) as LlmChatPayload;
    } catch {
      // Some providers may emit non-JSON bookkeeping events.
      // Ignore those here; a useful JSON event or delta must still exist below.
      continue;
    }

    lastPayload = parsed;

    const errorMessage = parsed.error?.message;
    if (typeof errorMessage === "string" && errorMessage.trim()) {
      throw new Error(`LLM: ${errorMessage.trim()}`);
    }

    const messageContent = parsed.choices?.[0]?.message?.content;
    if (typeof messageContent === "string") {
      completePayload = parsed;
    }

    const deltaContent = parsed.choices?.[0]?.delta?.content;
    if (typeof deltaContent === "string") {
      streamedContent += deltaContent;
    }

    const textContent = parsed.choices?.[0]?.text;
    if (typeof textContent === "string") {
      streamedText += textContent;
    }
  }

  if (completePayload && payloadContent(completePayload)) {
    return completePayload;
  }

  const content = streamedContent || streamedText;
  if (content) {
    return {
      choices: [{ message: { content } }],
    };
  }

  if (lastPayload) return lastPayload;

  throw new Error("LLM trả về stream nhưng không có dữ liệu JSON hợp lệ.");
}

async function readLlmResponse(response: Response): Promise<LlmChatPayload> {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`LLM HTTP ${response.status}: ${errorText.slice(-500)}`);
  }

  if (!contentType.includes("text/event-stream")) {
    const body = await response.text();
    try {
      return JSON.parse(body) as LlmChatPayload;
    } catch {
      throw new Error(
        `LLM trả về dữ liệu không phải JSON: ${contentType || "unknown"}: ${body.slice(0, 300)}`,
      );
    }
  }

  if (!response.body) {
    throw new Error("Không thể đọc stream từ LLM.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let pending = "";
  let eventData: string[] = [];

  const flushLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    // Blank line terminates one SSE event.
    if (line === "") {
      if (eventData.length) {
        events.push(eventData.join("\n"));
        eventData = [];
      }
      return;
    }

    // SSE comments / keep-alive.
    if (line.startsWith(":")) return;

    if (line.startsWith("data:")) {
      eventData.push(line.slice(5).trimStart());
    }
  };

  while (true) {
    const { done, value } = await reader.read();

    if (value) {
      // stream:true is important so UTF-8 characters split across chunks survive.
      pending += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        flushLine(line);
      }
    }

    if (done) break;
  }

  pending += decoder.decode();

  if (pending) {
    flushLine(pending);
  }
  if (eventData.length) {
    events.push(eventData.join("\n"));
  }

  return ssePayloadFromEvents(events);
}

async function createAnswers(source: string, requiredVocabulary: string) {
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim();

  if (!baseUrl || !apiKey || !model) {
    throw new Error("Thiếu LLM_BASE_URL, LLM_API_KEY hoặc LLM_MODEL.");
  }

  const controller = new AbortController();
  const timeoutSeconds = Number(process.env.LLM_TIMEOUT || 120);
  const timeout = setTimeout(
    () => controller.abort(),
    (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 120) * 1000,
  );

  try {
    const requestBody = JSON.stringify({
      model,
      temperature: Number(process.env.LLM_TEMPERATURE || 0.7),
      max_tokens: Number(process.env.LLM_MAX_TOKENS || 1000),

      // Yêu cầu provider trả response JSON thường.
      // Một số OpenAI-compatible proxy vẫn có thể ép SSE, nên readLlmResponse()
      // phía trên vẫn hỗ trợ text/event-stream đầy đủ.
      stream: false,

      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You create Japanese multiple-choice reading questions. Return JSON only.",
        },
        {
          role: "user",
          content: [
            `Kanji/source: ${source}`,
            `RequiredVocabulary: ${requiredVocabulary}`,
            "Return exactly JSON with answers array of 4 strings and correctIndex as integer 0, 1, 2, or 3.",
            "One answer must be the correct Japanese reading of RequiredVocabulary, written in hiragana or katakana.",
            "Other three answers must be plausible but incorrect Japanese readings. Do not include explanations or duplicate answers.",
          ].join("\n"),
        },
      ],
    });

    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(
          `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${apiKey}`,
            },
            body: requestBody,
            signal: controller.signal,
          },
        );

        const payload = await readLlmResponse(response);
        const content = payloadContent(payload);

        if (!content) {
          throw new Error("LLM không trả về nội dung.");
        }

        const generated = validateAnswers(parseJsonResponse(content));
        return randomizeCorrectAnswer(
          generated.answers,
          generated.correctIndex,
        );
      } catch (error) {
        lastError = error;

        if (controller.signal.aborted) {
          throw new Error(`LLM hết thời gian chờ sau ${timeoutSeconds || 120} giây.`);
        }

        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Không gọi được LLM.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readAnkiNotes(source?: string, limit = 100, scheduled = false, forceRecreate = false) {
  const filters = ["note_type = 'AIKanjiWithImage'", "NULLIF(BTRIM(fields_json->>'RequiredVocabulary'), '') IS NOT NULL"];
  const values: unknown[] = [];
  let order = "source";
  if (scheduled) {
    // Anki and application data may live in different databases.
    const saved = await query(`SELECT source, required_vocabulary AS vocabulary, updated_at
      FROM word_creator_questions WHERE video_path IS NOT NULL`);
    values.push(JSON.stringify(saved.rows));
    const previous = `SELECT saved.updated_at FROM jsonb_to_recordset($1::jsonb)
      AS saved(source text, vocabulary text, updated_at timestamptz)
      WHERE saved.source = anki_ai_notes.source
        AND saved.vocabulary = BTRIM(anki_ai_notes.fields_json->>'RequiredVocabulary')`;
    if (forceRecreate) order = `(${previous}) ASC NULLS FIRST, source`;
    else filters.push(`NOT EXISTS (${previous})`);
  }
  if (source?.trim()) {
    values.push(source.trim());
    filters.push(`source = $${values.length}`);
  }
  values.push(Math.min(Math.max(limit, 1), 500));
  const result = await getAnkiPool().query<AnkiNote>(
    `SELECT anki_note_id, source, fields_json
     FROM public.anki_ai_notes
     WHERE ${filters.join(" AND ")}
     ORDER BY ${order}
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function listWordCreatorSources(search = "", offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset không hợp lệ.");
  const pattern = `%${search.trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`;
  const result = await getAnkiPool().query<WordCreatorSource>(
    `SELECT source, MIN(fields_json->>'RequiredVocabulary') AS vocabulary, COUNT(*)::integer AS note_count
     FROM public.anki_ai_notes
     WHERE note_type = 'AIKanjiWithImage'
       AND NULLIF(BTRIM(source), '') IS NOT NULL
       AND NULLIF(BTRIM(fields_json->>'RequiredVocabulary'), '') IS NOT NULL
       AND (source ILIKE $1 OR fields_json->>'RequiredVocabulary' ILIKE $1)
     GROUP BY source ORDER BY source LIMIT 101 OFFSET $2`, [pattern, offset],
  );
  return { sources: result.rows.slice(0, 100), hasMore: result.rows.length > 100 };
}

function requiredVocabulary(row: AnkiNote) {
  const value = row.fields_json?.RequiredVocabulary;
  return typeof value === "string" ? value.trim() : "";
}

export async function markWordCreatorStatus(source: string, vocabulary: string, status: 'video_generated' | 'publish_facebook_ok' | 'publish_youtube_ok' | 'failed', lastError?: string) {
  await ensureWordCreatorSchema();
  await query(
    `UPDATE word_creator_questions SET status = $1, last_error = $2, updated_at = NOW()
     WHERE source = $3 AND required_vocabulary = $4`,
    [status, lastError?.slice(0, 4000) ?? null, source, vocabulary],
  );
}

export function fillQuizTemplate(template: string, vocabulary: string, answers: string[]) {
  const data: Record<string, string> = { Word: vocabulary };
  answers.forEach((answer, index) => { data[`Answer${"ABCD"[index]}`] = answer; });
  let html = template;
  for (const [key, value] of Object.entries(data)) html = html.replaceAll(`{{${key}}}`, safeHtml(value));
  // New templates expose setQuiz instead of placeholders. Keep both formats.
  const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const script = `<script>document.addEventListener("DOMContentLoaded",function(){if(typeof window.setQuiz==="function")window.setQuiz(${json});});</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${script}</body>`) : `${html}${script}`;
}

export async function generateWordCreator(
  options: WordCreatorOptions = {},
  onProgress?: (progress: WordCreatorProgress) => Promise<void>,
  log: WordCreatorLogger = async () => {},
) {
  const fps = options.fps ?? 25;
  const autoFps = options.autoFps ?? true;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new Error("FPS phải là số nguyên từ 1 đến 60.");
  }
  await log(`Chuẩn bị: ${options.source || "tự động chọn Kanji"}, ${options.limit ?? 100} record, ${fps} FPS.`);
  await ensureWordCreatorSchema();
  const template = await fs.readFile(path.join(process.cwd(), "template.html"), "utf8");
  const outputDir = path.resolve(appConfig.wordCreatorOutputDir());
  await fs.mkdir(outputDir, { recursive: true });
  const durationSeconds = options.durationSeconds ?? appConfig.wordCreatorDuration();
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300) {
    throw new Error("durationSeconds phải lớn hơn 0 và không quá 300 giây.");
  }
  await log("Đang đọc Kanji từ database Anki.");
  const rows = await readAnkiNotes(options.source, options.limit ?? 100, options.scheduled, options.forceRecreate);
  await log(`Tìm thấy ${rows.length} record; thời lượng ${durationSeconds}s/video.`);
  const results: WordCreatorResult[] = [];
  const errors: Array<{ source: string; error: string }> = [];
  let processed = 0;
  const report = (currentSource: string | null) => onProgress?.({
    total: rows.length, processed, generated: results.length, currentSource, errors: [...errors],
  });
  await report(null);

  for (const row of rows) {
    const vocabulary = requiredVocabulary(row);
    if (!vocabulary) {
      processed += 1;
      await report(null);
      continue;
    }
    await report(row.source);
    try {
      await log(`Gọi AI tạo đáp án cho ${vocabulary}.`, "info", row.source);
      const generated = await createAnswers(row.source, vocabulary);
      await log("Đã tạo và trộn đáp án. Đang ghi HTML và sao chép ảnh/GIF.", "info", row.source);
      const html = fillQuizTemplate(template, vocabulary, generated.answers);
      const fileName = `${safeFileName(row.source)}.html`;
      const filePath = path.join(outputDir, fileName);
      await fs.writeFile(filePath, html, "utf8");
      await copyHtmlAssets(html, filePath);
      await log(`Phân tích GIF và render ${durationSeconds}s, FPS yêu cầu ${fps}${autoFps ? " (tự động khớp GIF)" : " (cố định)"}.`, "info", row.source);
      const quizData: Record<string, string> = { Word: vocabulary, AnswerA: generated.answers[0], AnswerB: generated.answers[1], AnswerC: generated.answers[2], AnswerD: generated.answers[3] };
      const rendered = await renderHtmlVideoWithQuiz(filePath, row.source, durationSeconds, fps, autoFps, log, quizData);
      await log("Render xong; frame tạm đã được xóa. Đang lưu video vào DB.", "info", row.source);
      const relativeVideoPath = toRelativeOutputPath(rendered.videoPath);
      await saveVideoDetails(relativeVideoPath, {
        title: `${row.source} ${vocabulary}`,
        caption: `WordCreator: ${vocabulary}`,
      });
      await query(
        `INSERT INTO word_creator_questions
          (anki_note_id, source, required_vocabulary, answer_a, answer_b, answer_c, answer_d, correct_index, correct_answer, template_path, video_path, duration_seconds, fps, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (source, required_vocabulary) DO UPDATE SET
           anki_note_id = EXCLUDED.anki_note_id, answer_a = EXCLUDED.answer_a, answer_b = EXCLUDED.answer_b,
           answer_c = EXCLUDED.answer_c, answer_d = EXCLUDED.answer_d, correct_index = EXCLUDED.correct_index,
           correct_answer = EXCLUDED.correct_answer, template_path = EXCLUDED.template_path,
           video_path = EXCLUDED.video_path, duration_seconds = EXCLUDED.duration_seconds, fps = EXCLUDED.fps, updated_at = NOW()`,
        [row.anki_note_id, row.source, vocabulary, ...generated.answers, generated.correctIndex, generated.answers[generated.correctIndex], filePath, relativeVideoPath, durationSeconds, rendered.fps],
      );
      results.push({
        source: row.source,
        requiredVocabulary: vocabulary,
        path: filePath,
        videoPath: relativeVideoPath,
        durationSeconds,
        fps: rendered.fps,
        correctAnswer: generated.answers[generated.correctIndex],
        answers: generated.answers,
      });
      await log(`Đã lưu video: ${relativeVideoPath}`, "info", row.source);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không tạo được câu hỏi.";
      errors.push({ source: row.source, error: message });
      await log(message, "error", row.source);
    }
    processed += 1;
    await report(null);
  }
  await log(`Kết quả: ${results.length}/${rows.length} video, ${errors.length} lỗi.`);
  return { total: rows.length, generated: results.length, errors, results };
}

export async function listWordCreatorQuestions() {
  await ensureWordCreatorSchema();
  return (await query<WordCreatorQuestion>(
    `SELECT id, anki_note_id, source, required_vocabulary, answer_a, answer_b, answer_c, answer_d,
            correct_index, correct_answer, template_path, video_path, duration_seconds, fps, created_at::text
     FROM word_creator_questions ORDER BY updated_at DESC LIMIT 500`,
  )).rows;
}
