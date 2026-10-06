import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/page-header";

/** A draft link that no longer works (deleted, or a typo in the address). */
export default function CampaignSetupNotFound() {
  return (
    <div className="px-4 pt-10 md:px-6">
      <EmptyState
        title="This campaign doesn't exist any more"
        description="It may have been deleted. Your other campaigns are on the Campaigns page."
        actions={
          <Button variant="outline" asChild>
            <Link href="/campaigns">Go to Campaigns</Link>
          </Button>
        }
      />
    </div>
  );
}
