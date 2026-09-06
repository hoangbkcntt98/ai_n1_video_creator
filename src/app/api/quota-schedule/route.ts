import {
  deleteCodexQuotaSchedule,
  getCodexQuotaSchedule,
  startQuotaScheduler,
  updateCodexQuotaSchedule,
} from "@/lib/quotaScheduler";

export const runtime = "nodejs";

export async function GET() {
  try {
    startQuotaScheduler();
    return Response.json({ schedule: await getCodexQuotaSchedule() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read Codex quota schedule.";
    return Response.json({ error: message }, { status: message === "Codex quota schedule is not configured." ? 404 : 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      enabled?: unknown;
      runDay?: unknown;
      runTime?: unknown;
      timezone?: unknown;
    };
    if (
      typeof body.enabled !== "boolean"
      || typeof body.runDay !== "number"
      || typeof body.runTime !== "string"
      || typeof body.timezone !== "string"
    ) {
      return Response.json({ error: "Invalid Codex quota schedule settings." }, { status: 400 });
    }
    startQuotaScheduler();
    const schedule = await updateCodexQuotaSchedule({
      enabled: body.enabled,
      runDay: body.runDay,
      runTime: body.runTime,
      timezone: body.timezone,
    });
    return Response.json({ schedule });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Could not save Codex quota schedule.",
    }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    await deleteCodexQuotaSchedule();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Could not delete Codex quota schedule.",
    }, { status: 400 });
  }
}
