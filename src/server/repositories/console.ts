// Read-only queries for the operations console. Raw SQL where joins, laterals or
// percentiles are clearer than the query builder; every value is a bound parameter.
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import type {
  ActivityRow,
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
  OverviewStats,
  UpcomingAppointmentRow,
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
  };
}

// Calls are the union of end-of-call reports and tool activity: a call that's still
// in progress (or whose report never arrived) only has tool_invocations rows.
const callActivity = (where: SQL) => sql`
  with inv as (
    select vapi_call_id, min(created_at) as first_at, max(created_at) as last_at, bool_or(is_demo_seed) as seed
      from tool_invocations
     where vapi_call_id is not null
     group by vapi_call_id
  ), merged as (
    select coalesce(c.vapi_call_id, inv.vapi_call_id) as vapi_call_id,
           c.started_at, c.ended_at, c.ended_reason, c.caller_phone, c.summary, c.transcript,
           (c.id is not null) as has_report,
           inv.first_at, inv.last_at,
           coalesce(c.is_demo_seed, inv.seed, false) as is_demo_seed
      from calls c
      full outer join inv on inv.vapi_call_id = c.vapi_call_id
  )
  select * from merged ${where}`;

export function createConsoleRepository(db: Db): ConsoleRepository {
  return {
    async board({ includeSeed }) {
      const [dispatchRows, callbackRows] = await Promise.all([
        rows(
          db,
          sql`
          select d.id, d.urgency, d.reasons, d.status, d.caller_name, d.caller_phone, d.address, d.intake,
                 d.created_at, d.acknowledged_at, d.vapi_call_id, d.is_demo_seed,
                 ${fullName("c.first_name", "c.last_name")} as customer_name, c.phone_e164 as customer_phone
            from dispatch_requests d
            left join customers c on c.id = d.customer_id
           where d.status in ('open', 'acknowledged')
             and (${includeSeed} or not d.is_demo_seed)
           limit 500`,
        ),
        rows(
          db,
          sql`
          select cb.id, cb.reason, cb.context, cb.caller_name, cb.caller_phone, cb.created_at, cb.vapi_call_id,
                 cb.is_demo_seed, t.result ->> 'urgency' as triage_urgency, t.result -> 'reasons' as triage_reasons
            from callback_requests cb
            left join lateral (
              select ti.result
                from tool_invocations ti
               where ti.vapi_call_id = cb.vapi_call_id and ti.tool_name = 'triage_issue' and ti.ok
               order by ti.created_at desc
               limit 1
            ) t on true
           where cb.status = 'open'
             and (${includeSeed} or not cb.is_demo_seed)
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
        vapiCallId: strOrNull(r.vapi_call_id),
        isDemoSeed: Boolean(r.is_demo_seed),
        triageUrgency: (strOrNull(r.triage_urgency) as Urgency | null) ?? null,
        triageReasons: strArray(r.triage_reasons),
      }));
      return { dispatches, callbacks };
    },

    async recentCalls({ includeSeed, limit }) {
      const result = await rows(
        db,
        callActivity(sql`
          where (${includeSeed} or not is_demo_seed)
          order by coalesce(started_at, first_at, ended_at) desc nulls last
          limit ${limit}`),
      );
      return result.map(mapCallActivity);
    },

    async call(vapiCallId) {
      const [r] = await rows(db, callActivity(sql`where vapi_call_id = ${vapiCallId} limit 1`));
      return r ? { ...mapCallActivity(r), transcript: strOrNull(r.transcript) } : null;
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
          sql`select id, vapi_call_id, urgency, reasons, status, caller_name, caller_phone, intake
                from dispatch_requests where vapi_call_id in ${ids} order by created_at asc`,
        ),
        rows(
          db,
          sql`select id, vapi_call_id, reason, status, caller_name, caller_phone, context
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
          }),
        ),
      };
      return records;
    },

    async upcomingAppointments({ includeSeed, from, limit }) {
      const result = await rows(
        db,
        sql`
        select a.id, s.starts_at, s.ends_at, s.county,
               ${fullName("c.first_name", "c.last_name")} as customer_name, c.phone_e164,
               exists (select 1 from memberships m where m.customer_id = c.id and m.status = 'active') as is_member,
               ad.line1, ad.unit, ad.city, ad.zip, ad.access_notes,
               a.service_type, a.urgency, a.issue_summary, a.technician_notes, a.vapi_call_id, a.is_demo_seed
          from appointments a
          join appointment_slots s on s.id = a.slot_id
          join customers c on c.id = a.customer_id
          join service_addresses ad on ad.id = a.address_id
         where a.status = 'confirmed'
           and s.ends_at > ${from}
           and (${includeSeed} or not a.is_demo_seed)
         order by s.starts_at asc, c.last_name asc
         limit ${limit}`,
      );
      return result.map(
        (r): UpcomingAppointmentRow => ({
          id: String(r.id),
          startsAt: dateOrNull(r.starts_at)!,
          endsAt: dateOrNull(r.ends_at)!,
          county: String(r.county),
          customerName: strOrNull(r.customer_name) ?? "",
          customerPhone: String(r.phone_e164),
          isMember: Boolean(r.is_member),
          line1: String(r.line1),
          unit: strOrNull(r.unit),
          city: String(r.city),
          zip: String(r.zip),
          accessNotes: strOrNull(r.access_notes),
          serviceType: r.service_type as UpcomingAppointmentRow["serviceType"],
          urgency: r.urgency as Urgency,
          issueSummary: strOrNull(r.issue_summary),
          technicianNotes: strOrNull(r.technician_notes),
          vapiCallId: strOrNull(r.vapi_call_id),
          isDemoSeed: Boolean(r.is_demo_seed),
        }),
      );
    },

    async overviewStats({ includeSeed, from, to }) {
      const [r] = await rows(
        db,
        sql`
        select
          (select count(*) from (
             select vapi_call_id from calls
              where coalesce(started_at, ended_at) >= ${from} and coalesce(started_at, ended_at) < ${to}
                and (${includeSeed} or not is_demo_seed)
             union
             select vapi_call_id from tool_invocations
              where vapi_call_id is not null and created_at >= ${from} and created_at < ${to}
                and (${includeSeed} or not is_demo_seed)
           ) x) as calls,
          (select count(*) from appointments
            where status = 'confirmed' and created_at >= ${from} and created_at < ${to}
              and (${includeSeed} or not is_demo_seed)) as bookings,
          (select count(*) from dispatch_requests
            where created_at >= ${from} and created_at < ${to}
              and (${includeSeed} or not is_demo_seed)) as priority_requests,
          (select count(*) from callback_requests
            where status = 'open' and (${includeSeed} or not is_demo_seed)) as open_callbacks,
          (select count(*) from dispatch_requests
            where status in ('open', 'acknowledged') and (${includeSeed} or not is_demo_seed)) as open_dispatches,
          t.tool_calls, t.tool_errors, t.avg_ms, t.p95_ms
        from (
          select count(*) as tool_calls,
                 count(*) filter (where not ok) as tool_errors,
                 avg(latency_ms) as avg_ms,
                 percentile_cont(0.95) within group (order by latency_ms) as p95_ms
            from tool_invocations
           where created_at >= ${from} and created_at < ${to}
             and (${includeSeed} or not is_demo_seed)
        ) t`,
      );
      const stats: OverviewStats = {
        calls: num(r.calls),
        bookings: num(r.bookings),
        priorityRequests: num(r.priority_requests),
        openCallbacks: num(r.open_callbacks),
        openDispatches: num(r.open_dispatches),
        toolCalls: num(r.tool_calls),
        toolErrors: num(r.tool_errors),
        avgToolMs: r.avg_ms === null ? null : Math.round(num(r.avg_ms)),
        p95ToolMs: r.p95_ms === null ? null : Math.round(num(r.p95_ms)),
      };
      return stats;
    },

    async recentActivity({ includeSeed, limit }) {
      const seed = (alias: string) => sql`(${includeSeed} or not ${sql.raw(alias)}.is_demo_seed)`;
      const who = fullName("c.first_name", "c.last_name");
      const result = await rows(
        db,
        sql`
        select * from (
          select ca.ended_at as at, 'call_ended' as kind, ca.id::text as ref_id, ca.vapi_call_id,
                 ca.caller_phone as who, ca.ended_reason as detail, null::text as urgency, ca.is_demo_seed
            from calls ca where ca.ended_at is not null and ${seed("ca")}
          union all
          select a.created_at, 'booked', a.id::text, a.vapi_call_id, ${who}, a.issue_summary, a.urgency::text, a.is_demo_seed
            from appointments a join customers c on c.id = a.customer_id
           where a.status = 'confirmed' and ${seed("a")}
          union all
          select d.created_at, 'dispatch_created', d.id::text, d.vapi_call_id,
                 coalesce(d.caller_name, ${who}, d.caller_phone), d.reasons[1], d.urgency::text, d.is_demo_seed
            from dispatch_requests d left join customers c on c.id = d.customer_id where ${seed("d")}
          union all
          select d.acknowledged_at, 'dispatch_acknowledged', d.id::text, d.vapi_call_id,
                 coalesce(d.caller_name, ${who}, d.caller_phone), null, d.urgency::text, d.is_demo_seed
            from dispatch_requests d left join customers c on c.id = d.customer_id
           where d.acknowledged_at is not null and ${seed("d")}
          union all
          select d.resolved_at, 'dispatch_resolved', d.id::text, d.vapi_call_id,
                 coalesce(d.caller_name, ${who}, d.caller_phone), null, d.urgency::text, d.is_demo_seed
            from dispatch_requests d left join customers c on c.id = d.customer_id
           where d.resolved_at is not null and ${seed("d")}
          union all
          select cb.created_at, 'callback_created', cb.id::text, cb.vapi_call_id,
                 coalesce(cb.caller_name, cb.caller_phone), cb.reason, null, cb.is_demo_seed
            from callback_requests cb where ${seed("cb")}
          union all
          select cb.completed_at, 'callback_done', cb.id::text, cb.vapi_call_id,
                 coalesce(cb.caller_name, cb.caller_phone), cb.reason, null, cb.is_demo_seed
            from callback_requests cb where cb.completed_at is not null and ${seed("cb")}
        ) events
        order by at desc
        limit ${limit}`,
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
