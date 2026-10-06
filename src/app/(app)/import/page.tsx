import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/page-header";
import { ImportStepper } from "@/components/import/stepper";
import { RecentImports } from "@/components/import/recent-imports";
import { UploadStep } from "@/components/import/upload-step";
import { listRecentImports } from "@/server/services/imports/sessions";

export const metadata: Metadata = { title: "Import" };

export default async function ImportPage() {
  const user = await requireUser();
  const recent = await listRecentImports(10);
  return (
    <div>
      <PageHeader
        title="Import"
        description="Add companies and people from a spreadsheet, or paste rows from Excel or Google Sheets."
      />
      <div className="grid gap-8 px-4 pb-10 md:px-6">
        <ImportStepper current={1} />
        <UploadStep />
        <RecentImports items={recent} timeZone={user.timeZone} />
      </div>
    </div>
  );
}
