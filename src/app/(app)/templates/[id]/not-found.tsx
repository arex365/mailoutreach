import Link from "next/link";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/page-header";

/** /templates/<id> for a template that was deleted (or a mistyped link). */
export default function TemplateNotFound() {
  return (
    <div>
      <PageHeader title="Templates" />
      <div className="px-4 md:px-6">
        <EmptyState
          icon={<FileText className="size-6" aria-hidden />}
          title="This template doesn't exist any more."
          description="Someone may have deleted it, or the link is old. Campaigns that used it keep their own copy of the text."
          actions={
            <Button variant="outline" asChild>
              <Link href="/templates">Go to Templates</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
