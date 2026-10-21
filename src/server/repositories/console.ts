// Read-only queries for the operations console. Raw SQL where joins, laterals or
// percentiles are clearer than the query builder; every value is a bound parameter.
// Every list honors one Scope: seed data and test traffic (simulations, web calls, chats)
// are hidden unless asked for, so evals never mix into real numbers.
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import type {
  ActivityRow,
  AppointmentRow,
  AppointmentStage,
  BoardCallbackRow,
  BoardDispatchRow,
  CallActivityRow,
  CallAppointmentRow,
  CallCallbackRow,
  CallDispatchRow,
  CallRecords,
  ConsoleRepository,
  InvocationRow,
  JsonObject,
  Scope,
  ToolHealthRow,
  TranscriptMessage,
  Urgency,
} from "./types";

type Row = Record<string, unknown>;

const rows = async (db: Db, query: SQL): Promise<Row[]> => (await db.execute(query)).rows as Row[];
const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const dateOrNull = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);
const objOrNull = (v: unknown): JsonObject | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const fullName = (first: string, last: string) => sql`nullif(trim(concat_ws(' ', ${sql.raw(first)}, ${sql.raw(last)})), '')`;

/**
 * A record belongs to test traffic when it has no call id (a simulated chat or a dashboard tool
 * test) or its call was a simulation (the tool rows or the end-of-call report say so).
 */
const testCall = (col: SQL) =>
  sql`(${col} is null
       or exists (select 1 from tool_invocations tx where tx.vapi_call_id = ${col} and tx.is_simulation)
       or exists (select 1 from calls cx where cx.vapi_call_id = ${col} and cx.is_simulation))`;

/** Seed rows follow includeSeed; everything else hides test traffic unless includeTests. */
export const visible = (alias: string, scope: Scope) => {
  const a = sql.raw(alias);
  return sql`((${scope.includeSeed} or not ${a}.is_demo_seed)
              and (${scope.includeTests ?? false} or ${a}.is_demo_seed or not ${testCall(sql`${a}.vapi_call_id`)}))`;
};

function mapCallActivity(r: Row): CallActivityRow {
  return {
    vapiCallId: String(r.vapi_call_id),
    startedAt: dateOrNull(r.started_at),
    endedAt: dateOrNull(r.ended_at),
    endedReason: strOrNull(r.ended_reason),
    callerPhone: strOrNull(r.caller_phone),
    summary: strOrNull(r.summary),
    hasReport: Boolean(r.has_report),
    firstActivityAt: dateOrNull(r.first_at),
    lastActivityAt: dateOrNull(r.last_at),
    isDemoSeed: Boolean(r.is_demo_seed),
    isSimulation: Boolean(r.is_simulation),
    responseP50Ms: numOrNull(r.response_p50_ms),
  };
}

// Calls are the union of end-of-call reports and tool activity: a call that's still
// in progress (or whose report never arrived) only has tool_invocations rows. A call's
// time is when it started, else its first tool call, else when it ended (metrics.ts).
const callActivity = (where: SQL) => sql`
  with inv as (
    select vapi_call_id, min(created_at) as first_at, max(created_at) as last_at,
           bool_or(is_demo_seed) as seed, bool_or(is_simulation) as sim
      from tool_invocations
     where vapi_call_id is not null
     group by vapi_call_id
  ), merged as (
    select coalesce(c.vapi_call_id, inv.vapi_call_id) as vapi_call_id,
           c.started_at, c.ended_at, c.ended_reason, c.caller_phone, c.summary, c.transcript,
           c.response_p50_ms, c.response_p95_ms, c.response_turns,
           (c.id is not null) as has_report,
           inv.first_at, inv.last_at,
           coalesce(c.is_demo_seed, inv.seed, false) as is_demo_seed,
           (coalesce(c.is_simulation, false) or coalesce(inv.sim, false)) as is_simulation,
           coalesce(c.started_at, inv.first_at, c.ended_at) as call_at
      from calls c
      full outer join inv on inv.vapi_call_id = c.vapi_call_id
  )
  select * from merged ${where}`;

const callScope = (scope: Scope) =>
  sql`(${scope.includeSeed} or not is_demo_seed) and (${scope.includeTests ?? false} or is_demo_seed or not is_simulation)`;

const STAGE_SQL = sql`case when a.status = 'cancelled' then 'cancelled' when a.completion = 'completed' then 'completed'
                          when a.completion = 'no_show' then 'no_show' else 'scheduled' end`;

export function createConsoleRepository(db: Db): ConsoleRepository {
  return {
    async board(scope) {
      const since = scope.resolvedSince ?? null;
      const [dispatchRows, callbackRows] = await Promise.all([
        rows(
          db,
          sql`
          select d.id, d.urgency, d.reasons, d.status, d.caller_name, d.caller_phone, d.address, d.intake,
                 d.created_at, d.acknowledged_at, d.acknowledged_by, d.resolved_at, d.resolution, d.resolution_note,
                 d.resolved_by, d.vapi_call_id, d.is_demo_seed,
                 ${fullName("c.first_name", "c.last_name")} as customer_name, c.phone_e164 as customer_phone
            from dispatch_requests d
            left join customers c on c.id = d.customer_id
           where (d.status in ('open', 'acknowledged') or (${since}::timestamptz is not null and d.status = 'resolved' and d.resolved_at >= ${since}))
             and ${visible("d", scope)}
           limit 500`,
        ),
        rows(
          db,
          sql`
          select cb.id, cb.reason, cb.context, cb.caller_name, cb.caller_phone, cb.created_at, cb.vapi_call_id,
                 cb.status, cb.called_back_at, cb.called_back_by, cb.completed_at, cb.resolution, cb.resolution_note,
                 cb.resolved_by, cb.is_demo_seed, t.result ->> 'urgency' as triage_urgency,
                 t.result -> 'reasons' as triage_reasons, t.args as triage_args, ap.id as appointment_id
            from callback_requests cb
            left join lateral (
              select ti.result, ti.args
                from tool_invocations ti
               where ti.vapi_call_id = cb.vapi_call_id and ti.tool_name = 'triage_issue' and ti.ok
               order by ti.created_at desc
               limit 1
            ) t on true
            left join lateral (
              -- The caller's next scheduled visit: by the account a lookup verified on this call, else by phone.
              select a.id
                from appointments a
                join customers c on c.id = a.customer_id
                join appointment_slots s on s.id = a.slot_id
               where a.status = 'confirmed' and a.completion is null and s.ends_at > now()
                 and (c.phone_e164 = cb.caller_phone
                      or c.id::text in (select li.result ->> 'customer_id' from tool_invocations li
                                         where li.vapi_call_id = cb.vapi_call_id and li.tool_name = 'lookup_customer'
                                           and li.result ->> 'verified' = 'true'))
               order by s.starts_at asc
               limit 1
            ) ap on true
           where (cb.status = 'open' or (${since}::timestamptz is not null and cb.status = 'done' and cb.completed_at >= ${since}))
             and ${visible("cb", scope)}
           limit 500`,
        ),
      ]);

      const dispatches: BoardDispatchRow[] = dispatchRows.map((r) => ({
        id: String(r.id),
        urgency: r.urgency as Urgency,
        reasons: strArray(r.reasons),
        status: r.status as BoardDispatchRow["status"],
        callerName: strOrNull(r.caller_name),
        callerPhone: strOrNull(r.caller_phone),
        address: objOrNull(r.address),
        intake: objOrNull(r.intake),
        customerName: strOrNull(r.customer_name),
        customerPhone: strOrNull(r.customer_phone),
        createdAt: dateOrNull(r.created_at)!,
        acknowledgedAt: dateOrNull(r.acknowledged_at),
        acknowledgedBy: strOrNull(r.acknowledged_by),
        resolvedAt: dateOrNull(r.resolved_at),
        resolution: strOrNull(r.resolution),
        resolutionNote: strOrNull(r.resolution_note),
        resolvedBy: strOrNull(r.resolved_by),
        vapiCallId: strOrNull(r.vapi_call_id),
        isDemoSeed: Boolean(r.is_demo_seed),
      }));
      const callbacks: BoardCallbackRow[] = callbackRows.map((r) => ({
        id: String(r.id),
        reason: strOrNull(r.reason),
        context: objOrNull(r.context),
        callerName: strOrNull(r.caller_name),
        callerPhone: strOrNull(r.caller_phone),
        createdAt: dateOrNull(r.created_at)!,
        status: r.status as BoardCallbackRow["status"],
        calledBackAt: dateOrNull(r.called_back_at),
        calledBackBy: strOrNull(r.called_back_by),
        resolvedAt: dateOrNull(r.completed_at),
        resolution: strOrNull(r.resolution),
        resolutionNote: strOrNull(r.resolution_note),
        resolvedBy: strOrNull(r.resolved_by),
        vapiCallId: strOrNull(r.vapi_call_id),
        isDemoSeed: Boolean(r.is_demo_seed),
        triageUrgency: (strOrNull(r.triage_urgency) as Urgency | null) ?? null,
        triageReasons: strArray(r.triage_reasons),
        triageArgs: objOrNull(r.triage_args),
        appointmentId: strOrNull(r.appointment_id),
      }));
      return { dispatches, callbacks };
    },

    async recentCalls(opts) {
      const since = opts.since ?? null;
      const result = await rows(
        db,
        callActivity(sql`
          where ${callScope(opts)}
            and (${since}::timestamptz is null or call_at >= ${since})
          order by call_at desc nulls last
          limit ${opts.limit}`),
      );
      return result.map(mapCallActivity);
    },

    async call(vapiCallId) {
      const [r] = await rows(db, callActivity(sql`where vapi_call_id = ${vapiCallId} limit 1`));
      return r
        ? {
            ...mapCallActivity(r),
            transcript: strOrNull(r.transcript),
            responseP50Ms: numOrNull(r.response_p50_ms),
            responseP95Ms: numOrNull(r.response_p95_ms),
            responseTurns: numOrNull(r.response_turns),
          }
        : null;
    },

    async callExists(vapiCallId) {
      const [r] = await rows(
        db,
        sql`select exists(select 1 from calls where vapi_call_id = ${vapiCallId})
                or exists(select 1 from tool_invocations where vapi_call_id = ${vapiCallId}) as found`,
      );
      return r?.found === true;
    },

    async callRecords(vapiCallIds) {
      if (vapiCallIds.length === 0) return { invocations: [], appointments: [], dispatches: [], callbacks: [] };
      const ids = sql`(${sql.join(
        vapiCallIds.map((id) => sql`${id}`),
        sql`, `,
      )})`;
      const [inv, appts, disp, cbs] = await Promise.all([
        rows(
          db,
          sql`select id, vapi_call_id, tool_name, args, result, ok, latency_ms, db_ms, created_at
                from tool_invocations where vapi_call_id in ${ids} order by created_at asc, id asc`,
        ),
        rows(
          db,
          sql`select a.id, a.vapi_call_id, a.status, a.urgency, a.issue_summary,
                     ${fullName("c.first_name", "c.last_name")} as customer_name, c.phone_e164,
                     s.starts_at, s.ends_at
                from appointments a
                join customers c on c.id = a.customer_id
                join appointment_slots s on s.id = a.slot_id
               where a.vapi_call_id in ${ids}`,
        ),
        rows(
          db,
          sql`select id, vapi_call_id, urgency, reasons, status, caller_name, caller_phone, intake, created_at,
                     acknowledged_at, acknowledged_by, resolved_at, resolution, resolution_note, resolved_by
                from dispatch_requests where vapi_call_id in ${ids} order by created_at asc`,
        ),
        rows(
          db,
          sql`select id, vapi_call_id, reason, status, caller_name, caller_phone, context, created_at,
                     called_back_at, called_back_by, completed_at, resolution, resolution_note, resolved_by
                from callback_requests where vapi_call_id in ${ids} order by created_at asc`,
        ),
      ]);
      const records: CallRecords = {
        invocations: inv.map(
          (r): InvocationRow => ({
            id: String(r.id),
            vapiCallId: String(r.vapi_call_id),
            toolName: String(r.tool_name),
            args: objOrNull(r.args),
            result: objOrNull(r.result) ?? {},
            ok: Boolean(r.ok),
            latencyMs: num(r.latency_ms),
            dbMs: numOrNull(r.db_ms),
            createdAt: dateOrNull(r.created_at)!,
          }),
        ),
        appointments: appts.map(
          (r): CallAppointmentRow => ({
            id: String(r.id),
            vapiCallId: String(r.vapi_call_id),
            status: r.status as CallAppointmentRow["status"],
            urgency: r.urgency as Urgency,
            issueSummary: strOrNull(r.issue_summary),
            customerName: strOrNull(r.customer_name) ?? "",
            customerPhone: String(r.phone_e164),
            startsAt: dateOrNull(r.starts_at)!,
            endsAt: dateOrNull(r.ends_at)!,
          }),
        ),
        dispatches: disp.map(
          (r): CallDispatchRow => ({
            id: String(r.id),
            vapiCallId: String(r.vapi_call_id),
            urgency: r.urgency as Urgency,
            reasons: strArray(r.reasons),
            status: r.status as CallDispatchRow["status"],
            callerName: strOrNull(r.caller_name),
            callerPhone: strOrNull(r.caller_phone),
            intake: objOrNull(r.intake),
            createdAt: dateOrNull(r.created_at) ?? undefined,
            acknowledgedAt: dateOrNull(r.acknowledged_at),
            acknowledgedBy: strOrNull(r.acknowledged_by),
            resolvedAt: dateOrNull(r.resolved_at),
            resolution: strOrNull(r.resolution),
            resolutionNote: strOrNull(r.resolution_note),
            resolvedBy: strOrNull(r.resolved_by),
          }),
        ),
        callbacks: cbs.map(
          (r): CallCallbackRow => ({
            id: String(r.id),
            vapiCallId: String(r.vapi_call_id),
            reason: strOrNull(r.reason),
            status: r.status as CallCallbackRow["status"],
            callerName: strOrNull(r.caller_name),
            callerPhone: strOrNull(r.caller_phone),
            context: objOrNull(r.context),
            createdAt: dateOrNull(r.created_at) ?? undefined,
            calledBackAt: dateOrNull(r.called_back_at),
            calledBackBy: strOrNull(r.called_back_by),
            resolvedAt: dateOrNull(r.completed_at),
            resolution: strOrNull(r.resolution),
            resolutionNote: strOrNull(r.resolution_note),
            resolvedBy: strOrNull(r.resolved_by),
          }),
        ),
      };
      return records;
    },

    async appointments(opts) {
      const from = opts.from ?? null;
      const closedSince = opts.closedSince ?? null;
      const bookedSince = opts.bookedSince ?? null;
      const ids = opts.ids && opts.ids.length ? opts.ids : null;
      const which = ids
        ? sql`a.id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : bookedSince
          ? sql`a.created_at >= ${bookedSince} and a.rescheduled_from is null and a.status = 'confirmed'`
          : sql`((a.status = 'confirmed' and a.completion is null and (${from}::timestamptz is null or s.ends_at > ${from}))
                 or (${closedSince}::timestamptz is not null
                     and coalesce(a.completed_at, a.cancelled_at, a.created_at) >= ${closedSince}
                     and (a.status = 'cancelled' or a.completion is not null)))`;
      const result = await rows(
        db,
        sql`
        select a.id, ${STAGE_SQL} as stage, a.slot_id, s.starts_at, s.ends_at, s.county, a.customer_id,
               ${fullName("c.first_name", "c.last_name")} as customer_name, c.phone_e164,
               exists (select 1 from memberships m where m.customer_id = c.id and m.status = 'active') as is_member,
               ad.line1, ad.unit, ad.city, ad.zip, ad.access_notes,
               a.service_type, a.urgency, a.issue_summary, a.technician_notes, a.vapi_call_id, a.is_demo_seed,
               a.intake->>'arrival_preference' as arrival_preference, a.created_at, a.completed_at, a.completion_note,
               a.cancelled_at, a.status_by, a.rescheduled_from,
               (select n.id from appointments n where n.rescheduled_from = a.id order by n.created_at desc limit 1) as rescheduled_to
          from appointments a
          join appointment_slots s on s.id = a.slot_id
          join customers c on c.id = a.customer_id
          join service_addresses ad on ad.id = a.address_id
         where ${which}
           and (${ids !== null} or ${visible("a", opts)})
         order by s.starts_at asc, c.last_name asc
         limit ${opts.limit}`,
      );
      return result.map(
        (r): AppointmentRow => ({
          id: String(r.id),
          stage: String(r.stage) as AppointmentStage,
          slotId: String(r.slot_id),
          startsAt: dateOrNull(r.starts_at)!,
          endsAt: dateOrNull(r.ends_at)!,
          county: String(r.county),
          customerId: String(r.customer_id),
          customerName: strOrNull(r.customer_name) ?? "",
          customerPhone: String(r.phone_e164),
          isMember: Boolean(r.is_member),
          line1: String(r.line1),
          unit: strOrNull(r.unit),
          city: String(r.city),
          zip: String(r.zip),
          accessNotes: strOrNull(r.access_notes),
          serviceType: r.service_type as AppointmentRow["serviceType"],
          urgency: r.urgency as Urgency,
          issueSummary: strOrNull(r.issue_summary),
          technicianNotes: strOrNull(r.technician_notes),
          arrivalPreference: strOrNull(r.arrival_preference),
          vapiCallId: strOrNull(r.vapi_call_id),
          isDemoSeed: Boolean(r.is_demo_seed),
          createdAt: dateOrNull(r.created_at)!,
          completedAt: dateOrNull(r.completed_at),
          completionNote: strOrNull(r.completion_note),
          cancelledAt: dateOrNull(r.cancelled_at),
          statusBy: strOrNull(r.status_by),
          rescheduledFrom: strOrNull(r.rescheduled_from),
          rescheduledTo: strOrNull(r.rescheduled_to),
        }),
      );
    },

    async toolHealthRows(opts) {
      const result = await rows(
        db,
        sql`select tool_name, ok, result ->> 'error_code' as error_code, latency_ms, created_at
              from tool_invocations ti
             where ti.created_at >= ${opts.from}
               and (${opts.includeSeed} or not ti.is_demo_seed)
               and (${opts.includeTests ?? false} or ti.is_demo_seed or (not ti.is_simulation and ti.vapi_call_id is not null))`,
      );
      return result.map(
        (r): ToolHealthRow => ({
          toolName: String(r.tool_name),
          ok: Boolean(r.ok),
          errorCode: strOrNull(r.error_code),
          latencyMs: num(r.latency_ms),
          createdAt: dateOrNull(r.created_at)!,
        }),
      );
    },

    async callMessages(vapiCallId) {
      const [r] = await rows(
        db,
        sql`select coalesce(raw_report->'artifact'->'messages', raw_report->'call'->'artifact'->'messages', raw_report->'messages') as messages
              from calls where vapi_call_id = ${vapiCallId} limit 1`,
      );
      const list = Array.isArray(r?.messages) ? (r.messages as JsonObject[]) : [];
      const out: TranscriptMessage[] = [];
      for (const m of list) {
        const text = typeof m.message === "string" ? m.message.trim() : "";
        const at = typeof m.time === "number" ? new Date(m.time) : null;
        if (!text || !at) continue;
        if (m.role === "user") out.push({ role: "caller", text, at });
        else if (m.role === "bot" || m.role === "assistant") out.push({ role: "ava", text, at });
      }
      return out;
    },

    async recentActivity(opts) {
      const v = (alias: string) => visible(alias, opts);
      const who = fullName("c.first_name", "c.last_name");
      const result = await rows(
        db,
        sql`
        select * from (
          select ca.ended_at as at, 'call_ended' as kind, ca.id::text as ref_id, ca.vapi_call_id,
                 ca.caller_phone as who, ca.ended_reason as detail, null::text as urgency, ca.is_demo_seed
            from calls ca
           where ca.ended_at is not null and (${opts.includeSeed} or not ca.is_demo_seed)
             and (${opts.includeTests ?? false} or ca.is_demo_seed or not ${testCall(sql`ca.vapi_call_id`)})
          union all
          select a.created_at, 'booked', a.id::text, a.vapi_call_id, ${who}, a.issue_summary, a.urgency::text, a.is_demo_seed
            from appointments a join customers c on c.id = a.customer_id
           where a.status = 'confirmed' and a.rescheduled_from is null and ${v("a")}
          union all
          select d.created_at, 'dispatch_created', d.id::text, d.vapi_call_id,
                 coalesce(d.caller_name, ${who}, d.caller_phone), d.reasons[1], d.urgency::text, d.is_demo_seed
            from dispatch_requests d left join customers c on c.id = d.customer_id where ${v("d")}
          union all
          select d.acknowledged_at, 'dispatch_acknowledged', d.id::text, d.vapi_call_id,
                 coalesce(d.caller_name, ${who}, d.caller_phone), d.acknowledged_by, d.urgency::text, d.is_demo_seed
            from dispatch_requests d left join customers c on c.id = d.customer_id
           where d.acknowledged_at is not null and ${v("d")}
          union all
          select d.resolved_at, 'dispatch_resolved', d.id::text, d.vapi_call_id,
                 coalesce(d.caller_name, ${who}, d.caller_phone), d.resolution, d.urgency::text, d.is_demo_seed
            from dispatch_requests d left join customers c on c.id = d.customer_id
           where d.resolved_at is not null and ${v("d")}
          union all
          select cb.created_at, 'callback_created', cb.id::text, cb.vapi_call_id,
                 coalesce(cb.caller_name, cb.caller_phone), cb.reason, null, cb.is_demo_seed
            from callback_requests cb where ${v("cb")}
          union all
          select cb.called_back_at, 'callback_called_back', cb.id::text, cb.vapi_call_id,
                 coalesce(cb.caller_name, cb.caller_phone), cb.called_back_by, null, cb.is_demo_seed
            from callback_requests cb where cb.called_back_at is not null and ${v("cb")}
          union all
          select cb.completed_at, 'callback_done', cb.id::text, cb.vapi_call_id,
                 coalesce(cb.caller_name, cb.caller_phone), coalesce(cb.resolution, cb.reason), null, cb.is_demo_seed
            from callback_requests cb where cb.completed_at is not null and ${v("cb")}
        ) events
        order by at desc
        limit ${opts.limit}`,
      );
      return result.map(
        (r): ActivityRow => ({
          at: dateOrNull(r.at)!,
          kind: r.kind as ActivityRow["kind"],
          refId: String(r.ref_id),
          vapiCallId: strOrNull(r.vapi_call_id),
          who: strOrNull(r.who),
          detail: strOrNull(r.detail),
          urgency: (strOrNull(r.urgency) as Urgency | null) ?? null,
          isDemoSeed: Boolean(r.is_demo_seed),
        }),
      );
    },
  };
}
