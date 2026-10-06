/**
 * Seeding helpers for the Contacts integration tests. Server modules are imported
 * lazily, so a test file can call createTestDb() first (it sets DATABASE_URL).
 */

import type { CompanyStatusValue, PriorityValue } from "@/core/labels";

export type SeedCompany = {
  name: string;
  website?: string | null;
  country?: string | null;
  niche?: string | null;
  status?: CompanyStatusValue;
  priority?: PriorityValue;
  lastEmailedAt?: Date | null;
  lastEmailedById?: number | null;
  importedLastContactAt?: Date | null;
  firstContactedById?: number | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  customFields?: Record<string, string | number | null>;
  people?: Array<{ name?: string; email?: string | null; role?: string | null; deletedAt?: Date | null }>;
  listIds?: number[];
  tagIds?: number[];
};

export async function makeUser(name: string, role: "OWNER" | "MEMBER" = "MEMBER") {
  const { dbWrite } = await import("@/server/db");
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${Math.floor(Math.random() * 1e9)}@example.com`;
  return dbWrite((c) => c.user.create({ data: { name, email, role }, select: { id: true, name: true } }));
}

export async function makeCompany(input: SeedCompany): Promise<number> {
  const { dbTx } = await import("@/server/db");
  const { refreshCompanySearchText } = await import("@/server/company-search");
  const { normalizeCompanyName } = await import("@/core/text");
  const { parseWebsite } = await import("@/core/shared-domains");
  const { lastContactAt, priorityRank } = await import("@/server/services/companies/filters");
  const site = input.website ? parseWebsite(input.website) : null;
  const priority = input.priority ?? "NORMAL";
  return dbTx(async (tx) => {
    const c = await tx.company.create({
      data: {
        name: input.name,
        nameNorm: normalizeCompanyName(input.name),
        website: site?.url ?? null,
        domain: site?.domain ?? null,
        profileKey: site?.profileKey ?? null,
        country: input.country ?? null,
        niche: input.niche ?? null,
        status: input.status ?? "NOT_CONTACTED",
        priority,
        priorityRank: priorityRank(priority),
        lastEmailedAt: input.lastEmailedAt ?? null,
        lastEmailedById: input.lastEmailedById ?? null,
        importedLastContactAt: input.importedLastContactAt ?? null,
        lastContactAt: lastContactAt(input.lastEmailedAt, input.importedLastContactAt),
        firstContactedById: input.firstContactedById ?? null,
        deletedAt: input.deletedAt ?? null,
        customFields: input.customFields ?? undefined,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
      select: { id: true },
    });
    for (const p of input.people ?? []) {
      await tx.person.create({
        data: {
          companyId: c.id,
          name: p.name ?? "",
          role: p.role ?? null,
          email: p.email ?? null,
          emailNorm: p.email ? p.email.toLowerCase() : null,
          deletedAt: p.deletedAt ?? null,
        },
      });
    }
    for (const listId of input.listIds ?? []) await tx.companyList.create({ data: { companyId: c.id, listId } });
    for (const tagId of input.tagIds ?? []) await tx.companyTag.create({ data: { companyId: c.id, tagId } });
    await refreshCompanySearchText(tx, [c.id]);
    return c.id;
  });
}

export async function makeList(name: string): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  return (await dbWrite((c) => c.list.create({ data: { name }, select: { id: true } }))).id;
}

export async function makeTag(name: string): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  return (await dbWrite((c) => c.tag.create({ data: { name }, select: { id: true } }))).id;
}

/** Filters from a query string, like the Contacts page reads them. */
export async function filtersFrom(query: string) {
  const { parseCompanyFilters } = await import("@/server/services/companies/filters");
  return parseCompanyFilters(new URLSearchParams(query));
}
