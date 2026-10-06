import type { Metadata } from "next";
import os from "node:os";
import Link from "next/link";
import { headers } from "next/headers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOwner } from "@/lib/auth/dal";
import { parseTunnelState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { databaseFilePath, publicUrl } from "@/server/env";
import { isFakeMode } from "@/server/mailgun/base-url";
import { getSetting } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import { getWorkerStatus } from "@/server/worker-status";
import { cleanRequestHost, isLocalOnlyHost } from "@/server/services/users";
import { CopyField } from "@/components/copy-text";
import { AccessOffSwitch } from "@/components/settings/access-off-switch";
import { PUBLIC_ADDRESS_SETUP_TEXT } from "@/components/settings/public-address-text";
import { RemoteAccessCard } from "@/components/settings/remote-access-card";
import { DetailRow, SettingsTitle } from "@/components/settings/settings-title";
import { workerStatusText } from "@/components/settings/worker-status-text";
import { cn } from "@/lib/utils";
import pkg from "../../../../../package.json";
import { CheckNowButton } from "./check-now-button";

export const metadata: Metadata = { title: "System" };

/** IPv4 addresses of this PC on the office network (never loopback). */
function officeAddresses(port: string): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(`http://${a.address}:${port}`);
    }
  }
  return [...new Set(out)];
}

/** How to change the public address with the services installed (M6-DESIGN §5.2 "System"). */
const CHANGE_PUBLIC_ADDRESS =
  "Works from anywhere, through Cloudflare. To change it, run setup.bat again, then update.bat if the app runs as a Windows service, then click Apply recommended settings.";

/**
 * Settings › System (Owner): is everything running, remote access (with the "We don't use Cloudflare Access" switch,
 * M6-DESIGN §2.8), where things live. No secrets here. No orange button (M6-DESIGN §5.1 R1).
 */
export default async function SystemSettingsPage() {
  const user = await requireOwner();
  const h = await headers();
  const host = cleanRequestHost(h.get("x-forwarded-host") ?? h.get("host"));
  const now = new Date();
  const worker = await getWorkerStatus(now);
  const status = workerStatusText(worker, now, user.timeZone);
  const pub = publicUrl();

  let publicHost: string | null = null;
  try {
    publicHost = pub ? new URL(pub).host.toLowerCase() : null;
  } catch {
    publicHost = null;
  }
  const viaTunnel = Boolean(host && publicHost && host === publicHost);
  const hostPort = host?.match(/:(\d{1,5})$/)?.[1];
  const port = (!viaTunnel && hostPort) || process.env.PORT || "3000";
  const lan = officeAddresses(port);
  const current = host ? `${viaTunnel ? "https" : "http"}://${host}` : null;
  const dbFile = databaseFilePath().replace(/\//g, "\\");
  const tunnel = (await readTyped(STATE_KEYS.tunnel, parseTunnelState)).value;
  const fakeMode = isFakeMode();
  const accessOff = (await getSetting("remoteAccess.accessOff")) === true;

  return (
    <div>
      <SettingsTitle title="System" description="Whether the app's background parts are running, and where things live on the office PC." />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Background sender</CardTitle>
            <CardDescription>It sends emails, runs imports and makes the daily backup, even when no browser is open.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", status.running ? "bg-success" : "bg-destructive")}
              />
              <span className={status.running ? "text-foreground" : "text-destructive"}>{status.text}</span>
            </p>
            {status.hint ? <p className="text-sm text-muted-foreground">{status.hint}</p> : null}
          </CardContent>
        </Card>

        <RemoteAccessCard
          tunnel={tunnel}
          publicUrl={pub}
          timeZone={user.timeZone}
          now={now}
          fakeMode={fakeMode}
          accessOff={accessOff}
          action={<CheckNowButton />}
          accessControl={<AccessOffSwitch accessOff={accessOff} />}
        />

        <Card>
          <CardHeader>
            <CardTitle>Addresses</CardTitle>
            <CardDescription>Where your team opens the app.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Public address" hint={pub ? CHANGE_PUBLIC_ADDRESS : undefined}>
                {pub ? <span className="break-all font-mono text-xs">{pub}</span> : `Not set yet. ${PUBLIC_ADDRESS_SETUP_TEXT}`}
              </DetailRow>
              <DetailRow
                label="Office address"
                hint="Office computers open the app at this address. It only works on the office network."
              >
                {lan.length > 0 ? (
                  <div className="grid gap-1.5">
                    {lan.map((url) => (
                      <CopyField key={url} value={url} label={`office address ${url}`} />
                    ))}
                  </div>
                ) : (
                  <span>http://&lt;this PC&apos;s address&gt;:{port}</span>
                )}
              </DetailRow>
              {current ? (
                <DetailRow
                  label="You're using"
                  hint={
                    isLocalOnlyHost(host ?? "")
                      ? "This address only works on this PC. Invite and reset links made here use it, so make them from the office address instead."
                      : undefined
                  }
                >
                  <span className="break-all font-mono text-xs">{current}</span>
                </DetailRow>
              ) : null}
              {pub ? (
                <DetailRow label="For Mailgun" hint="Apply recommended settings (Settings › Domain checklist) tells Mailgun these addresses.">
                  <div className="grid gap-1 font-mono text-xs break-all">
                    <span>{pub}/api/webhooks/mailgun/events</span>
                    <span>{pub}/api/webhooks/mailgun/inbound</span>
                  </div>
                </DetailRow>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>This installation</CardTitle>
            <CardDescription>The app&apos;s version, and where its data lives on the office PC.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="App version">{pkg.version}</DetailRow>
              <DetailRow label="Node.js">{process.versions.node}</DetailRow>
              <DetailRow
                label="Database file"
                hint="Everything the app knows lives in this one file. Backups are copies of it."
              >
                <span className="break-all font-mono text-xs">{dbFile}</span>
              </DetailRow>
              <DetailRow label="Backups">
                <Button asChild variant="outline" size="sm">
                  <Link href="/settings/backups">Open Backups</Link>
                </Button>
              </DetailRow>
              <DetailRow label="Dry-run outbox" hint="Every email a dry-run campaign would have sent. Nothing in it left this PC.">
                <Button asChild variant="outline" size="sm">
                  <Link href="/campaigns/outbox">Open the outbox</Link>
                </Button>
              </DetailRow>
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
