// Fictional demo data only. Phone numbers use the 555-01xx fictional range;
// emails use the reserved example.com domain. IDs are fixed so the seed is
// idempotent (re-running upserts the same rows).
// Keep this file free of path aliases: it is also compiled for the seed script.

type EquipmentKind = "furnace" | "boiler" | "central_ac" | "heat_pump" | "mini_split" | "other";

export type SeedCustomer = {
  id: string;
  firstName: string;
  lastName: string;
  phoneE164: string;
  email: string | null;
  membership?: { id: string; planName: string; status: "active" | "lapsed"; startedOn: string; renewsOn: string };
  addresses: Array<{
    id: string;
    line1: string;
    unit: string | null;
    city: string;
    zip: string;
    county: string | null;
    propertyType: "residential" | "commercial";
    accessNotes: string | null;
    equipment: Array<{ id: string; kind: EquipmentKind; brand: string | null; installYear: number | null }>;
  }>;
};

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const aid = (n: number) => `00000000-0000-4000-8001-${String(n).padStart(12, "0")}`;
const mid = (n: number) => `00000000-0000-4000-8002-${String(n).padStart(12, "0")}`;
const eid = (n: number) => `00000000-0000-4000-8003-${String(n).padStart(12, "0")}`;

export const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    id: cid(1), firstName: "Dana", lastName: "Quillfeather", phoneE164: "+17185550101", email: "dana.q@example.com",
    membership: { id: mid(1), planName: "Comfort Club Plus", status: "active", startedOn: "2024-03-15", renewsOn: "2027-03-15" },
    addresses: [{
      id: aid(1), line1: "412 Seventh Ave", unit: null, city: "Brooklyn", zip: "11215", county: "Kings",
      propertyType: "residential", accessNotes: null,
      equipment: [
        { id: eid(1), kind: "boiler", brand: "Burnham", installYear: 2009 },
        { id: eid(2), kind: "mini_split", brand: "Mitsubishi", installYear: 2021 },
      ],
    }],
  },
  {
    id: cid(2), firstName: "Priya", lastName: "Marlowe-Venn", phoneE164: "+13475550102", email: "priya.mv@example.com",
    membership: { id: mid(2), planName: "Comfort Club", status: "active", startedOn: "2025-01-10", renewsOn: "2027-01-10" },
    addresses: [{
      // Queens hyphenated house number.
      id: aid(2), line1: "37-12 82nd St", unit: null, city: "Jackson Heights", zip: "11372", county: "Queens",
      propertyType: "residential", accessNotes: "Side door by the driveway.",
      equipment: [
        { id: eid(3), kind: "furnace", brand: "Carrier", installYear: 2012 },
        { id: eid(4), kind: "central_ac", brand: "Carrier", installYear: 2012 },
      ],
    }],
  },
  {
    id: cid(3), firstName: "Marcus", lastName: "Thistlewood", phoneE164: "+17185550103", email: null,
    membership: { id: mid(3), planName: "Comfort Club", status: "lapsed", startedOn: "2022-06-01", renewsOn: "2025-06-01" },
    addresses: [{
      id: aid(3), line1: "88 Rockrose Ave", unit: null, city: "Staten Island", zip: "10314", county: "Richmond",
      propertyType: "residential", accessNotes: null,
      equipment: [
        { id: eid(5), kind: "furnace", brand: "Lennox", installYear: 2006 },
        { id: eid(6), kind: "central_ac", brand: "Lennox", installYear: 2014 },
      ],
    }],
  },
  {
    id: cid(4), firstName: "Lena", lastName: "Okonkwo-Hart", phoneE164: "+19175550104", email: "lena.oh@example.com",
    addresses: [{
      // Apartment building with access notes.
      id: aid(4), line1: "1450 Ocean Ave", unit: "5C", city: "Brooklyn", zip: "11230", county: "Kings",
      propertyType: "residential",
      accessNotes: "Elevator building. Buzz 5C; if no answer, the super is in the basement office (ring bell marked SUPER). Parking on Ave J only.",
      equipment: [{ id: eid(7), kind: "mini_split", brand: "Daikin", installYear: 2019 }],
    }],
  },
  {
    id: cid(5), firstName: "Tomas", lastName: "Wrenfield", phoneE164: "+17185550105", email: "tomas.w@example.com",
    membership: { id: mid(5), planName: "Comfort Club Plus", status: "active", startedOn: "2023-10-01", renewsOn: "2026-12-01" },
    addresses: [{
      id: aid(5), line1: "21-45 31st St", unit: "1R", city: "Astoria", zip: "11105", county: "Queens",
      propertyType: "residential", accessNotes: "Two-family house; ring the right-side bell.",
      equipment: [{ id: eid(8), kind: "boiler", brand: "Weil-McLain", installYear: 2015 }],
    }],
  },
  {
    id: cid(6), firstName: "Rosalind", lastName: "Achterberg", phoneE164: "+13475550106", email: "ros.a@example.com",
    addresses: [{
      id: aid(6), line1: "190 Kent Ave", unit: "3A", city: "Brooklyn", zip: "11249", county: "Kings",
      propertyType: "residential", accessNotes: "Doorman building; tech must check in at front desk.",
      equipment: [{ id: eid(9), kind: "heat_pump", brand: "Bosch", installYear: 2022 }],
    }],
  },
  {
    // Commercial property (residential-only business should decline).
    id: cid(7), firstName: "Sam", lastName: "Fernhollow", phoneE164: "+17185550107", email: "sam@example.com",
    addresses: [{
      id: aid(7), line1: "251 Atlantic Ave", unit: "Storefront", city: "Brooklyn", zip: "11201", county: "Kings",
      propertyType: "commercial", accessNotes: "Corner deli; rooftop unit access via rear stairs.",
      equipment: [
        { id: eid(10), kind: "central_ac", brand: "Trane", installYear: 2011 },
        { id: eid(11), kind: "other", brand: "True", installYear: 2018 },
      ],
    }],
  },
  {
    // Out-of-area: Manhattan (New York County).
    id: cid(8), firstName: "Jordan", lastName: "Pikesbury", phoneE164: "+12125550108", email: null,
    addresses: [{
      id: aid(8), line1: "600 W 110th St", unit: "4B", city: "New York", zip: "10025", county: "New York",
      propertyType: "residential", accessNotes: null,
      equipment: [{ id: eid(12), kind: "other", brand: "Unknown", installYear: null }],
    }],
  },
  {
    id: cid(9), firstName: "Grace", lastName: "Nakamori-Lowe", phoneE164: "+17185550109", email: "grace.nl@example.com",
    membership: { id: mid(9), planName: "Comfort Club", status: "active", startedOn: "2025-05-20", renewsOn: "2027-05-20" },
    addresses: [
      {
        id: aid(9), line1: "45 Bayview Ter", unit: null, city: "Staten Island", zip: "10301", county: "Richmond",
        propertyType: "residential", accessNotes: null,
        equipment: [
          { id: eid(13), kind: "furnace", brand: "Goodman", installYear: 2017 },
          { id: eid(14), kind: "central_ac", brand: "Goodman", installYear: 2017 },
        ],
      },
      {
        id: aid(10), line1: "108-20 71st Ave", unit: "6D", city: "Forest Hills", zip: "11375", county: "Queens",
        propertyType: "residential", accessNotes: "Rental unit; tenant will let tech in. Call tenant first.",
        equipment: [{ id: eid(15), kind: "mini_split", brand: "Fujitsu", installYear: 2020 }],
      },
    ],
  },
  {
    id: cid(10), firstName: "Hector", lastName: "Alvarenga-Stout", phoneE164: "+13475550110", email: null,
    membership: { id: mid(10), planName: "Comfort Club", status: "lapsed", startedOn: "2021-11-01", renewsOn: "2024-11-01" },
    addresses: [{
      id: aid(11), line1: "164-20 Highland Ave", unit: null, city: "Jamaica", zip: "11432", county: "Queens",
      propertyType: "residential", accessNotes: null,
      equipment: [{ id: eid(16), kind: "boiler", brand: "Peerless", installYear: 2001 }],
    }],
  },
  {
    id: cid(11), firstName: "Wen", lastName: "Larkspur", phoneE164: "+19175550111", email: "wen.l@example.com",
    addresses: [{
      id: aid(12), line1: "7520 Ridge Blvd", unit: null, city: "Brooklyn", zip: "11209", county: "Kings",
      propertyType: "residential", accessNotes: null,
      equipment: [
        { id: eid(17), kind: "furnace", brand: "Rheem", installYear: 2013 },
        { id: eid(18), kind: "central_ac", brand: "Rheem", installYear: 2013 },
      ],
    }],
  },
  {
    id: cid(12), firstName: "Bea", lastName: "Castellwood", phoneE164: "+17185550112", email: "bea.c@example.com",
    membership: { id: mid(12), planName: "Comfort Club Plus", status: "active", startedOn: "2024-09-09", renewsOn: "2026-11-09" },
    addresses: [{
      id: aid(13), line1: "312 Amboy Rd", unit: null, city: "Staten Island", zip: "10306", county: "Richmond",
      propertyType: "residential", accessNotes: "Dog in yard; please call on arrival.",
      equipment: [{ id: eid(19), kind: "heat_pump", brand: "Daikin", installYear: 2023 }],
    }],
  },
  {
    // Shares last name + ZIP with customer 1: exercises the "ambiguous" name lookup.
    id: cid(13), firstName: "Morgan", lastName: "Quillfeather", phoneE164: "+13475550113", email: null,
    addresses: [{
      id: aid(14), line1: "211 Prospect Park W", unit: "2", city: "Brooklyn", zip: "11215", county: "Kings",
      propertyType: "residential", accessNotes: "Brownstone; garden-level door under the stoop.",
      equipment: [{ id: eid(20), kind: "boiler", brand: "Burnham", installYear: 2016 }],
    }],
  },
];

// ASSUMPTION: arrival windows per business day (local time). 2–4 hours each.
export const SLOT_WINDOWS: Array<{ startHour: number; endHour: number }> = [
  { startHour: 8, endHour: 10 },
  { startHour: 10, endHour: 13 },
  { startHour: 13, endHour: 17 },
];
