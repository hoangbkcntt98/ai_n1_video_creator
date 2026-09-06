import { loadCodexQuota } from "@/lib/codexQuota";

export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(await loadCodexQuota());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load quota." }, { status: 502 });
  }
}
