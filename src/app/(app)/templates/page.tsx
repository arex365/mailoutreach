import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { TemplateList } from "@/components/templates/template-list";
import { changedLabel, changedTitle, sequenceSummary, type TemplateListItem } from "@/components/templates/format";
import { ensureDefaultTemplates, listTemplates } from "@/server/services/templates";

export const metadata: Metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const user = await requireUser();
  // A fresh database gets the default sequences (PLAN.md A7) the first time anyone opens this page.
  await ensureDefaultTemplates();
  const now = new Date();
  const items: TemplateListItem[] = (await listTemplates()).map((t) => ({
    id: t.id,
    name: t.name,
    isMaster: t.isMaster,
    summary: sequenceSummary(t),
    subject: t.firstSubject?.trim() ? t.firstSubject : null,
    changed: changedLabel(t, user, now),
    changedTitle: changedTitle(t, user.timeZone),
  }));
  return <TemplateList templates={items} />;
}
