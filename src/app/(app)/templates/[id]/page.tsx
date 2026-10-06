import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { changedLabel } from "@/components/templates/format";
import { TemplateEditor } from "@/components/templates/template-editor";
import {
  defaultPreviewPerson,
  getTemplate,
  listActiveSenders,
  templateVariables,
} from "@/server/services/templates";

export const metadata: Metadata = { title: "Edit template" };

export default async function TemplateEditorPage({ params }: PageProps<"/templates/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const templateId = Number.parseInt(id, 10);
  if (!Number.isInteger(templateId) || templateId <= 0 || String(templateId) !== id) notFound();

  const [template, variables, senders, person] = await Promise.all([
    getTemplate(templateId),
    templateVariables(),
    listActiveSenders(),
    defaultPreviewPerson(),
  ]);
  if (!template) notFound();

  const defaultSenderId = senders.some((s) => s.id === user.id) ? user.id : (senders[0]?.id ?? null);

  return (
    <TemplateEditor
      // A fresh editor when another template opens (state is kept across router.refresh()).
      key={template.id}
      template={{
        id: template.id,
        name: template.name,
        isMaster: template.isMaster,
        changed: changedLabel(template, user),
        updatedAt: template.updatedAt.toISOString(),
        steps: template.steps,
      }}
      variables={variables}
      senders={senders}
      defaultSenderId={defaultSenderId}
      defaultPerson={person}
    />
  );
}
