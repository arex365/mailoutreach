import type { Metadata } from "next";
import Link from "next/link";
import { FlaskConical, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOwner } from "@/lib/auth/dal";
import { PUBLIC_ADDRESS_TEXTS } from "@/core/mailgun/routes";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { CopyField } from "@/components/copy-text";
import { Notice } from "@/components/campaigns/notice";
import { SettingsTitle } from "@/components/settings/settings-title";
import { CheckWithMailgun } from "@/components/settings/sending/check-with-mailgun";
import { ConnectionForm } from "@/components/settings/sending/connection-form";
import { FromAddressCard } from "@/components/settings/sending/from-address-card";
import { GoLiveCard } from "@/components/settings/sending/go-live-card";
import { PauseAllButton } from "@/components/settings/sending/pause-all-button";
import { PauseCard } from "@/components/settings/sending/pause-card";
import { SendingModeForm } from "@/components/settings/sending/sending-mode-form";
import { TestListEditor } from "@/components/settings/sending/test-list-editor";
import { loadSendingPage } from "./load";

export const metadata: Metadata = { title: "Sending & Mailgun" };

/**
 * Settings › Sending & Mailgun (Owner, M3-DESIGN §5.2, M6-DESIGN §5.2): the fake-mode banner, the pause card (with
 * Resume, the page's primary action while paused), the Mailgun connection ("Save and connect" is primary while not
 * connected), the From address (SHARED-FROM-DESIGN §3.1; its Save stays outline), the check with Mailgun (#outage, with older domains it couldn't check), the sending mode, the test list, the Go
 * live card (#go-live; its dialog's Go live is the one orange button while it is open), "Pause all sending" and the
 * addresses Mailgun needs.
 */
export default async function SendingSettingsPage() {
  const user = await requireOwner();
  const data = await loadSendingPage(user);

  return (
    <div>
      <SettingsTitle title="Sending & Mailgun" description="How emails leave the app, and the switches that protect your sending domain." />
      <div className="grid gap-6">
        {data.fakeBanner ? (
          <Notice tone="warning">
            <p className="flex items-start gap-2">
              <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
              {data.fakeBanner}
            </p>
          </Notice>
        ) : null}

        {data.pause ? <PauseCard view={data.pause} /> : null}

        <Card>
          <CardHeader>
            <CardTitle>Mailgun connection</CardTitle>
            <CardDescription>The app sends through Mailgun with your own sending domain and key.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.practiceCopy ? (
              <p className="text-sm">The practice copy never talks to Mailgun, so there is nothing to connect here.</p>
            ) : (
              <ConnectionForm view={data.connection} />
            )}
          </CardContent>
        </Card>

        {/* SHARED-FROM-DESIGN §3.1: the From address every campaign email shows, right after the connection. */}
        <FromAddressCard view={data.fromAddress} />

        {data.checkWithMailgun ? (
          // #outage: the dashboard's "follow-ups on hold" item links here, to the outage lines and "Continue follow-ups".
          <Card id="outage" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>Check with Mailgun</CardTitle>
              <CardDescription>
                {/* Own-mailbox mode (review REPLIES-09): replies never pass through Mailgun, so none can be missed here. */}
                {data.ownMailbox
                  ? "The app asks Mailgun every hour, and after the PC was off, for bounces, unsubscribes and complaints it missed."
                  : "The app asks Mailgun every hour, and after the PC was off, for bounces, unsubscribes, complaints and replies it missed."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CheckWithMailgun {...data.checkWithMailgun} />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Sending mode</CardTitle>
            <CardDescription>New campaigns use this mode. Each campaign keeps the mode it was launched with.</CardDescription>
          </CardHeader>
          <CardContent>
            <SendingModeForm
              current={data.mode}
              options={data.modeOptions}
              testList={data.testList}
              activeCampaigns={data.activeCampaigns}
              goLive={data.goLiveOn}
              ownMailbox={data.ownMailbox}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Test list</CardTitle>
            <CardDescription>{data.testListDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <TestListEditor addresses={data.testList} warnings={data.testListWarnings} hint={data.testListHint} empty={data.testListEmpty} />
          </CardContent>
        </Card>

        <GoLiveCard view={data.goLive} />

        {data.pause ? null : (
          <Card>
            <CardHeader>
              <CardTitle>Pause all sending</CardTitle>
              <CardDescription>Stops every campaign at once, including dry runs, until you resume.</CardDescription>
            </CardHeader>
            <CardContent>
              <PauseAllButton />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>For Mailgun</CardTitle>
            <CardDescription>
              Apply recommended settings registers these for you. They&apos;re here in case you need to type them into Mailgun by hand.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {/* Own-mailbox mode (MAIN-DOMAIN-DESIGN O8, O21): no route stores replies, and remote access is optional. */}
            {data.webhookUrl ? (
              <>
                <div className="grid gap-1.5">
                  <p className="text-sm font-medium">Webhook address</p>
                  <CopyField value={data.webhookUrl} label="webhook address" />
                </div>
                {data.inboundUrl ? (
                  <div className="grid gap-1.5">
                    <p className="text-sm font-medium">Address for stored replies</p>
                    <CopyField value={data.inboundUrl} label="address for stored replies" />
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm">{data.ownMailbox ? OWN_MAILBOX_TEXTS.applyNoPublicAddress : PUBLIC_ADDRESS_TEXTS.missing}</p>
            )}
            <div>
              <Button asChild variant="outline">
                <Link href="/campaigns/outbox">
                  <Inbox aria-hidden />
                  Open the dry-run outbox
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
