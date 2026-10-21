import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { customers, equipment, memberships, serviceAddresses } from "@/server/db/schema";
import type { AddressRow, CallerContextRows, CustomerRepository, CustomerRow } from "./types";

const customerColumns = {
  id: customers.id,
  firstName: customers.firstName,
  lastName: customers.lastName,
  phoneE164: customers.phoneE164,
};

export function createCustomerRepository(db: Db): CustomerRepository {
  /** Round trip 2 (parallel): memberships, and addresses left-joined to equipment. */
  async function loadContext(customer: CustomerRow): Promise<CallerContextRows> {
    const [membershipRows, addressEquipmentRows] = await Promise.all([
      db
        .select({
          planName: memberships.planName,
          status: memberships.status,
          startedOn: memberships.startedOn,
          renewsOn: memberships.renewsOn,
        })
        .from(memberships)
        .where(eq(memberships.customerId, customer.id))
        .orderBy(desc(memberships.renewsOn)),
      db
        .select({
          id: serviceAddresses.id,
          line1: serviceAddresses.line1,
          unit: serviceAddresses.unit,
          city: serviceAddresses.city,
          zip: serviceAddresses.zip,
          county: serviceAddresses.county,
          propertyType: serviceAddresses.propertyType,
          accessNotes: serviceAddresses.accessNotes,
          equipmentKind: equipment.kind,
          equipmentBrand: equipment.brand,
          equipmentInstallYear: equipment.installYear,
        })
        .from(serviceAddresses)
        .leftJoin(equipment, eq(equipment.addressId, serviceAddresses.id))
        .where(eq(serviceAddresses.customerId, customer.id))
        .orderBy(asc(serviceAddresses.line1), asc(equipment.kind)),
    ]);

    const addresses = new Map<string, AddressRow>();
    for (const r of addressEquipmentRows) {
      let address = addresses.get(r.id);
      if (!address) {
        address = {
          id: r.id,
          line1: r.line1,
          unit: r.unit,
          city: r.city,
          zip: r.zip,
          county: r.county,
          propertyType: r.propertyType,
          accessNotes: r.accessNotes,
          equipment: [],
        };
        addresses.set(r.id, address);
      }
      if (r.equipmentKind) {
        address.equipment.push({ kind: r.equipmentKind, brand: r.equipmentBrand, installYear: r.equipmentInstallYear });
      }
    }

    return { customer, memberships: membershipRows, addresses: [...addresses.values()] };
  }

  return {
    async findCallerContextByPhone(phoneE164) {
      // Round trip 1: unique-index lookup.
      const [customer] = await db
        .select(customerColumns)
        .from(customers)
        .where(eq(customers.phoneE164, phoneE164))
        .limit(1);
      return customer ? loadContext(customer) : null;
    },

    async findCallerContextByCustomerId(customerId) {
      const [customer] = await db.select(customerColumns).from(customers).where(eq(customers.id, customerId)).limit(1);
      return customer ? loadContext(customer) : null;
    },

    async findByLastName({ lastName, zip }) {
      return db
        .select({ customerId: customers.id, addressId: serviceAddresses.id, line1: serviceAddresses.line1 })
        .from(customers)
        .innerJoin(serviceAddresses, eq(serviceAddresses.customerId, customers.id))
        .where(
          and(
            eq(sql`lower(${customers.lastName})`, lastName.trim().toLowerCase()),
            zip ? eq(serviceAddresses.zip, zip) : undefined,
          ),
        )
        .limit(25);
    },
  };
}
