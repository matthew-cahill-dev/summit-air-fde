import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING_CONFIG, seatsAvailableFor, selectSlots, type SlotCandidate } from "@/server/scheduling/availability";

const TZ = "America/New_York";
// Tuesday 2026-10-20 09:00 New York (13:00Z).
const NOW = new Date("2026-10-20T13:00:00Z");
const H = 3_600_000;

let n = 0;
const slot = (hoursFromNow: number, capacity: number, booked: number, lengthHours = 3): SlotCandidate => ({
  id: `s${++n}`,
  county: "Queens",
  startsAt: new Date(NOW.getTime() + hoursFromNow * H),
  endsAt: new Date(NOW.getTime() + (hoursFromNow + lengthHours) * H),
  capacity,
  booked,
});

describe("member priority (last seat inside 48h is held for members)", () => {
  const cfg = DEFAULT_SCHEDULING_CONFIG;
  it.each([
    ["1 seat left at +24h, non-member", slot(24, 3, 2), false, 0],
    ["1 seat left at +24h, member", slot(24, 3, 2), true, 1],
    ["1 seat left at +47h, non-member", slot(47, 2, 1), false, 0],
    ["1 seat left at exactly +48h (outside window), non-member", slot(48, 2, 1), false, 1],
    ["2 seats left at +24h, non-member", slot(24, 3, 1), false, 1],
  ])("%s", (_name, s, isMember, expected) => {
    expect(seatsAvailableFor(s, isMember, NOW, cfg)).toBe(expected);
  });

  it("members are offered the last seat; non-members get the next window", () => {
    const lastSeat = slot(24, 2, 1);
    const open = slot(30, 3, 0);
    const member = selectSlots([lastSeat, open], { now: NOW, timeZone: TZ, urgency: "urgent", isMember: true });
    const nonMember = selectSlots([lastSeat, open], { now: NOW, timeZone: TZ, urgency: "urgent", isMember: false });
    expect(member.slots.map((s) => s.slot_id)).toEqual([lastSeat.id, open.id]);
    expect(nonMember.slots.map((s) => s.slot_id)).toEqual([open.id]);
  });
});

describe("selectSlots", () => {
  it("never offers windows starting inside the lead time, and at most 3", () => {
    const tooSoon = slot(1.5, 3, 0);
    const ok = [slot(2, 3, 0), slot(5, 3, 0), slot(26, 3, 0), slot(29, 3, 0)];
    const out = selectSlots([tooSoon, ...ok], { now: NOW, timeZone: TZ, urgency: "routine", isMember: false });
    expect(out.slots.map((s) => s.slot_id)).toEqual(ok.slice(0, 3).map((s) => s.id));
  });

  it("urgent prefers the 48h window and flags when it has to go later", () => {
    const later = slot(72, 3, 0);
    expect(selectSlots([later, slot(30, 3, 0)], { now: NOW, timeZone: TZ, urgency: "urgent", isMember: false })).toMatchObject({
      withinTarget: true,
      slots: [expect.objectContaining({})],
    });
    const out = selectSlots([later], { now: NOW, timeZone: TZ, urgency: "urgent", isMember: false });
    expect(out).toMatchObject({ withinTarget: false, slots: [{ slot_id: later.id }] });
  });

  it("filters by morning/afternoon and weekday, falling back when nothing matches", () => {
    // NOW is 09:00 local; +23h = 08:00 Wed, +28h = 13:00 Wed, +47h = 08:00 Thu.
    const wedMorning = slot(23, 3, 0);
    const wedAfternoon = slot(28, 3, 0);
    const thuMorning = slot(47, 3, 0);
    const all = [wedMorning, wedAfternoon, thuMorning];
    const base = { now: NOW, timeZone: TZ, urgency: "routine" as const, isMember: false };
    expect(selectSlots(all, { ...base, preferredWindow: "afternoon" }).slots.map((s) => s.slot_id)).toEqual([wedAfternoon.id]);
    expect(selectSlots(all, { ...base, preferredWindow: "morning", preferredDay: "thursday" }).slots.map((s) => s.slot_id)).toEqual([thuMorning.id]);
    const saturday = selectSlots(all, { ...base, preferredDay: "saturday" });
    expect(saturday.preferenceMatched).toBe(false);
    expect(saturday.slots).toHaveLength(3);
  });

  it("'after' pages to later windows", () => {
    const a = slot(23, 3, 0);
    const b = slot(28, 3, 0);
    const out = selectSlots([a, b], { now: NOW, timeZone: TZ, urgency: "routine", isMember: false, after: a.startsAt });
    expect(out.slots.map((s) => s.slot_id)).toEqual([b.id]);
  });

  it("labels windows the way a person says them", () => {
    const wed = slot(23, 3, 0); // Wed 8–11 AM
    const thu = slot(49, 3, 0, 3); // Thu 10 AM–1 PM
    const out = selectSlots([wed, thu], { now: NOW, timeZone: TZ, urgency: "routine", isMember: false });
    expect(out.slots.map((s) => s.label)).toEqual([
      "tomorrow, Wednesday, October 21, between 8 and 11 AM",
      "Thursday, October 22, between 10 AM and 1 PM",
    ]);
  });
});
