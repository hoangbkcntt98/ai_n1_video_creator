export const youtubeEnvKeys = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"] as const;

export function youtubeConfiguration() {
  const missing = youtubeEnvKeys.filter((key) => !process.env[key]?.trim());
  return { configured: missing.length === 0, missing };
}

export type YouTubeUploadInput = {
  path: string;
  title: string;
  description: string;
  privacy: "private" | "unlisted" | "public";
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
};

export function validateYouTubeUpload(body: Record<string, unknown>): YouTubeUploadInput {
  if (body.confirmUpload !== true) throw new Error("Confirm the YouTube upload first.");
  if (typeof body.path !== "string" || !body.path.toLowerCase().endsWith(".mp4")) {
    throw new Error("Select an MP4 video.");
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || [...title].length > 100 || /[<>]/.test(title)) {
    throw new Error("YouTube title must contain 1–100 characters, without < or >.");
  }
  if (typeof body.description !== "string" || Buffer.byteLength(body.description, "utf8") > 5000 || /[<>]/.test(body.description)) {
    throw new Error("YouTube description must not exceed 5000 UTF-8 bytes or contain < or >.");
  }
  if (body.privacy !== "private" && body.privacy !== "unlisted" && body.privacy !== "public") {
    throw new Error("Choose private, unlisted, or public visibility.");
  }
  if (typeof body.madeForKids !== "boolean" || typeof body.containsSyntheticMedia !== "boolean") {
    throw new Error("Choose the audience and altered/synthetic content settings.");
  }
  return {
    path: body.path, title, description: body.description, privacy: body.privacy,
    madeForKids: body.madeForKids, containsSyntheticMedia: body.containsSyntheticMedia,
  };
}
