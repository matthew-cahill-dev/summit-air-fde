import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { customers, equipment, memberships, serviceAddresses } from "@/server/db/schema";
import type { AddressRow, CustomerRepository } from "./types";

export function createCustomerRepository(db: Db): CustomerRepository {
  return {
    async findCallerContextByPhone(phoneE164) {
      // Round trip 1: unique-index lookup.
      const [customer] = await db
        .select({
          id: customers.id,
          firstName: customers.firstName,
          lastName: customers.lastName,
          phoneE164: customers.phoneE164,
        })
        .from(customers)
        .where(eq(customers.phoneE164, phoneE164))
        .limit(1);
      if (!customer) return null;

      // Round trip 2 (parallel): memberships, and addresses left-joined to equipment.
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
    },
  };
}
