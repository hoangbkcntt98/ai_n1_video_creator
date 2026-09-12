export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeActiveRuns } = await import("@/lib/pipeline");
    await resumeActiveRuns().catch(() => {});
    const { recoverAbandonedRuns } = await import("@/lib/db");
    await recoverAbandonedRuns().catch(() => {});
    // Abandoned PID-less runs may have just become failed; clear/report their
    // publishing continuations before the schedule queue checks for busy work.
    await resumeActiveRuns().catch(() => {});
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
