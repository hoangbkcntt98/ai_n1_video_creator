export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeActiveRuns } = await import("@/lib/pipeline");
    await resumeActiveRuns().catch(() => {});
    const { recoverAbandonedRuns } = await import("@/lib/db");
    await recoverAbandonedRuns().catch(() => {});
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
