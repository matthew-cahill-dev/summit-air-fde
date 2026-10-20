import { z } from "zod";

// Treat empty strings (common in .env files and platform secret panes) as unset.
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL"),
  VAPI_TOOL_SECRET: z.string().min(16, "must be at least 16 characters"),
  DASHBOARD_PASSWORD: z.string().min(8, "must be at least 8 characters"),
  APP_URL: z.url(),
  APP_TIMEZONE: z
    .string()
    .default("America/New_York")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "must be a valid IANA time zone"),
  ON_CALL_TRANSFER_NUMBER: optionalString.pipe(
    z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +17185550100")
      .optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parsed, validated environment. Lazy so `next build` doesn't need runtime
 * secrets; `instrumentation.ts` calls this at server boot so a misconfigured
 * deploy fails fast instead of on the first phone call.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Name the bad variables, never their values.
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached env so tests can change process.env. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
