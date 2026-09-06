import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appConfig } from "@/lib/config";
import { ensureStudioDirs, safeStudioName, studioRoot, toRelativeStudioPath } from "@/lib/studio";

export const runtime = "nodejs";
const MAX_TEXT = 12000;
const VOICE_PATTERN = /^[a-zA-Z0-9-]{2,80}$/;

function runTts(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("python3", args, { cwd: appConfig.skillDir(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-3000) || `TTS thất bại (code ${code}).`)));
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { text?: unknown; voice?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const voice = typeof body.voice === "string" && VOICE_PATTERN.test(body.voice) ? body.voice : (process.env.TTS_VOICE?.trim() || "ja-JP-NanamiNeural");
    if (!text) return Response.json({ error: "Nhập nội dung cần đọc." }, { status: 400 });
    if (text.length > MAX_TEXT) return Response.json({ error: `Nội dung TTS tối đa ${MAX_TEXT} ký tự.` }, { status: 400 });
    await ensureStudioDirs();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const textPath = path.join(studioRoot(), "tts", `${id}.txt`);
    const audioPath = path.join(studioRoot(), "tts", `${id}-${safeStudioName(voice)}.mp3`);
    await fs.writeFile(textPath, text, { encoding: "utf8", mode: 0o640 });
    try {
      await runTts([path.join(appConfig.skillDir(), "grammar_pipeline_module", "generate_audio.py"), "--text-file", textPath, "--output-file", audioPath, "--voice", voice]);
    } catch (error) {
      await fs.rm(audioPath, { force: true });
      throw error;
    } finally {
      await fs.rm(textPath, { force: true });
    }
    const relativeAudioPath = toRelativeStudioPath(audioPath);
    return Response.json({ ok: true, audioPath: relativeAudioPath, audioUrl: `/api/studio/audio?path=${encodeURIComponent(relativeAudioPath)}` }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Không tạo được audio TTS." }, { status: 500 });
  }
}
