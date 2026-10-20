// Runs once when the Next.js server boots. Validating env here makes a
// misconfigured deploy fail at startup instead of on the first phone call.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/lib/env");
    try {
      getEnv();
    } catch (err) {
      // Next would otherwise keep serving 500s; exit so the deploy visibly fails.
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
}
