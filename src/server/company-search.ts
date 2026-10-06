import { buildSearchText } from "@/core/text";
import { countryName } from "@/core/geo/display";
import type { DbOrTx } from "./db";

/**
 * Company.searchText = lowercase, accent-free words the search box looks through:
 * company name, website host, domain/profile, Instagram, niche, country (code and name),
 * and every (non-deleted) person's name, email and role.
 * Call inside the same transaction as any change to those fields.
 */
export async function refreshCompanySearchText(tx: DbOrTx, companyIds: number[]): Promise<void> {
  if (companyIds.length === 0) return;
  const companies = await tx.company.findMany({
    where: { id: { in: companyIds } },
    select: {
      id: true,
      name: true,
      website: true,
      domain: true,
      profileKey: true,
      instagram: true,
      niche: true,
      country: true,
      people: { where: { deletedAt: null }, select: { name: true, email: true, role: true } },
    },
  });
  for (const c of companies) {
    let host: string | null = null;
    if (c.website) {
      try {
        host = new URL(c.website.includes("://") ? c.website : `https://${c.website}`).hostname.replace(/^www\./, "");
      } catch {
        host = c.website;
      }
    }
    const searchText = buildSearchText([
      c.name,
      host,
      c.domain,
      c.profileKey,
      c.instagram,
      c.niche,
      c.country,
      c.country ? countryName(c.country) : null,
      ...c.people.flatMap((p) => [p.name, p.email, p.role]),
    ]);
    await tx.company.update({ where: { id: c.id }, data: { searchText } });
  }
}
