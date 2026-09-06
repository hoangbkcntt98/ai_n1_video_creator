import { startYouTubePublish } from "@/lib/pipeline";
import { validateYouTubeUpload, youtubeConfiguration } from "@/lib/youtube";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(youtubeConfiguration());
}

export async function POST(request: Request) {
  let input;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid upload settings.");
    input = validateYouTubeUpload(body);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid upload settings." }, { status: 400 });
  }
  if (!youtubeConfiguration().configured) {
    return Response.json({ error: "Configure YouTube OAuth credentials in .env.local first." }, { status: 503 });
  }
  try {
    const run = await startYouTubePublish(input);
    return Response.json({ run }, { status: 202 });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return Response.json({ error: "Another pipeline or upload is running. Wait for it to finish." }, { status: 409 });
    }
    return Response.json({ error: "Could not start YouTube upload. Check the video file and server configuration." }, { status: 500 });
  }
}
