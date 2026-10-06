import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/page-header";
import { ImportWizard } from "@/components/import/import-wizard";
import { db } from "@/server/db";
import { getImportSessionView } from "@/server/services/imports/sessions";

export const metadata: Metadata = { title: "Import" };

export default async function ImportSessionPage({ params }: PageProps<"/import/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const sessionId = Number.parseInt(id, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0 || String(sessionId) !== id) notFound();
  const [session, lists, tags] = await Promise.all([
    getImportSessionView(sessionId),
    db.list.findMany({
      select: { id: true, name: true, _count: { select: { companies: { where: { company: { deletedAt: null } } } } } },
    }),
    db.tag.findMany({ select: { name: true } }),
  ]);
  if (!session) notFound();
  const listChoices = lists
    .map((l) => ({ id: l.id, name: l.name, count: l._count.companies }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  const tagNames = tags.map((t) => t.name).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return (
    <div>
      <PageHeader
        title="Import"
        description="Match the columns, choose the options, check the rows, then import."
      />
      <div className="px-4 md:px-6">
        <ImportWizard session={session} lists={listChoices} tags={tagNames} timeZone={user.timeZone} />
      </div>
    </div>
  );
}
