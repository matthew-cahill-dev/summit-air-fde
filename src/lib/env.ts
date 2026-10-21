import { z } from "zod";
import { normalizePhoneE164 } from "@/server/lib/phone";

// Treat empty strings (common in .env files and platform secret panes) as unset.
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DEMO_CALLER_PHONES="+17185550199=<customer uuid>,+19175550123=<uuid>" lets
 * specific real phones resolve to seeded demo customers. Parsed to E.164 → id.
 */
export function parseDemoCallerPhones(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || !raw.trim()) return map;
  for (const pair of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = pair.lastIndexOf("=");
    const phone = normalizePhoneE164(eq > 0 ? pair.slice(0, eq) : "");
    const customerId = eq > 0 ? pair.slice(eq + 1).trim() : "";
    // Error text deliberately omits the value: it may be a real phone number.
    if (!phone || !UUID_RE.test(customerId)) throw new Error("each entry must be <phone>=<customer uuid>");
    map.set(phone, customerId.toLowerCase());
  }
  return map;
}

const booleanFlag = z.preprocess(
  (v) => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()) : v),
  z.boolean().default(false),
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
  DEMO_CALLER_PHONES: optionalString.transform((v, ctx) => {
    try {
      return parseDemoCallerPhones(v);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : "invalid" });
      return z.NEVER;
    }
  }),
  // Stretch (M2-G): personalize the greeting via Vapi assistant-request. Off by default.
  ASSISTANT_REQUEST_ENABLED: booleanFlag,
  // The saved Vapi assistant that assistant-request answers with.
  VAPI_ASSISTANT_ID: optionalString,
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
