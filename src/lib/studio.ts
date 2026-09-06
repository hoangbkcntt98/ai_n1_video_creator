import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appConfig } from "@/lib/config";

const execFileAsync = promisify(execFile);

export const STUDIO_ROOT_NAME = "video-studio";

export function studioRoot() {
  return path.join(appConfig.dataDir(), STUDIO_ROOT_NAME);
}

export function safeStudioName(name: string, fallback = "studio") {
  const cleaned = name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 100) || fallback;
}

export function resolveStudioPath(relativePath: string) {
  const root = path.resolve(studioRoot());
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Đường dẫn studio không hợp lệ.");
  return target;
}

export function toRelativeStudioPath(filePath: string) {
  const root = path.resolve(studioRoot());
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("File nằm ngoài thư mục studio.");
  return relative.split(path.sep).join("/");
}

export async function runCommand(command: string, args: string[]) {
  try {
    return await execFileAsync(command, args, { maxBuffer: 12 * 1024 * 1024 });
  } catch (error) {
    const details = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error((details.stderr || details.stdout || details.message || `Không chạy được ${command}`).trim().slice(-4000));
  }
}

export async function audioDuration(filePath: string) {
  const result = await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
  const duration = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export async function ensureStudioDirs() {
  await fs.mkdir(path.join(studioRoot(), "tts"), { recursive: true });
  await fs.mkdir(path.join(studioRoot(), "uploads"), { recursive: true });
  await fs.mkdir(path.join(studioRoot(), "renders"), { recursive: true });
}
