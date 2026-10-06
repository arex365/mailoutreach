import { INSTAGRAM_NOT_PROFILES, parseWebsite } from "@/core/shared-domains";
import { refreshCompanySearchText } from "@/server/company-search";
import { db, dbTx } from "@/server/db";
import { getSetting } from "@/server/settings";

/**
 * One-off repair for companies saved before profile links were read per platform.
 * Older versions stored "host + first path segment" as Company.profileKey, so every Etsy shop
 * got "etsy.com/shop", every Facebook profile.php link "facebook.com/profile.php", and so on;
 * links to Instagram posts stored the handle "p" or "reel". Those keys matched unrelated
 * companies. This recomputes profileKey from the stored website with today's rules (a key
 * that can't be told any more becomes null, which never matches) and clears Instagram
 * handles that are really Instagram's own pages. Safe to run any number of times: rows that
 * are already right are left alone. Run it once after updating (worker start-up or a script).
 */

const PAGE = 500;

export type ProfileKeyRepair = { checked: number; changed: number };

async function extraShared(): Promise<ReadonlySet<string>> {
  try {
    const extra = await getSetting("sharedDomains.extra");
    return new Set((Array.isArray(extra) ? extra : []).map((d) => String(d).trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function recomputeProfileKeys(): Promise<ProfileKeyRepair> {
  const extra = await extraShared();
  let checked = 0;
  let changed = 0;
  let afterId = 0;
  for (;;) {
    // Only rows that can be wrong: a shared-host website (domain null) or a stored profile/handle.
    const page = await db.company.findMany({
      where: {
        id: { gt: afterId },
        OR: [{ profileKey: { not: null } }, { AND: [{ website: { not: null } }, { domain: null }] }, { instagram: { in: [...INSTAGRAM_NOT_PROFILES] } }],
      },
      orderBy: { id: "asc" },
      take: PAGE,
      select: { id: true, website: true, domain: true, profileKey: true, instagram: true },
    });
    if (page.length === 0) break;
    afterId = page[page.length - 1]!.id;
    checked += page.length;
    const updates: Array<{ id: number; data: { profileKey?: string | null; instagram?: null } }> = [];
    for (const c of page) {
      const data: { profileKey?: string | null; instagram?: null } = {};
      const site = c.website ? parseWebsite(c.website, extra) : null;
      // Only shared-host keys are recomputed; a company website never has one.
      const key = site?.isShared ? site.profileKey : null;
      if (key !== c.profileKey) data.profileKey = key;
      if (c.instagram && INSTAGRAM_NOT_PROFILES.has(c.instagram)) data.instagram = null;
      if (Object.keys(data).length) updates.push({ id: c.id, data });
    }
    if (updates.length) {
      await dbTx(async (tx) => {
        for (const u of updates) await tx.company.update({ where: { id: u.id }, data: u.data });
        await refreshCompanySearchText(
          tx,
          updates.map((u) => u.id),
        );
      });
      changed += updates.length;
    }
    if (page.length < PAGE) break;
  }
  return { checked, changed };
}
