import { promises as fs } from "node:fs";
import path from "node:path";
import { listVideos, type VideoRecord } from "@/lib/video";
import { safeStudioName, studioRoot } from "@/lib/studio";

export type StudioAsset = {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
};

export function libraryRoot() {
  return path.join(studioRoot(), "library");
}

export function libraryCategoryRoot(category: "images" | "audio") {
  return path.join(libraryRoot(), category);
}

export async function saveLibraryAsset(sourcePath: string, category: "images" | "audio", originalName: string) {
  const destinationDir = libraryCategoryRoot(category);
  await fs.mkdir(destinationDir, { recursive: true });
  const extension = path.extname(sourcePath).toLowerCase() || path.extname(originalName).toLowerCase();
  const destination = path.join(destinationDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeStudioName(path.basename(originalName, path.extname(originalName)), "asset")}${extension}`);
  await fs.copyFile(sourcePath, destination);
  return `${category}/${path.basename(destination)}`;
}

async function listCategory(category: "images" | "audio"): Promise<StudioAsset[]> {
  const dir = libraryCategoryRoot(category);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(dir, entry.name);
    const stat = await fs.stat(filePath);
    return { path: `${category}/${entry.name}`, name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }));
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 200);
}

export async function getStudioLibrary(): Promise<{ images: StudioAsset[]; audio: StudioAsset[]; videos: VideoRecord[] }> {
  await fs.mkdir(libraryRoot(), { recursive: true });
  const [images, audio, videos] = await Promise.all([listCategory("images"), listCategory("audio"), listVideos()]);
  return { images, audio, videos };
}

export function resolveLibraryPath(relativePath: string) {
  const root = path.resolve(libraryRoot());
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Đường dẫn library không hợp lệ.");
  return target;
}

export async function deleteLibraryAsset(relativePath: string, category: "images" | "audio") {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized.startsWith(`${category}/`) || normalized.includes("/../") || normalized.endsWith("/..")) {
    throw new Error("Đường dẫn library không hợp lệ.");
  }
  const target = resolveLibraryPath(normalized);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) throw new Error("Không tìm thấy asset trong library.");
  await fs.unlink(target);
}
