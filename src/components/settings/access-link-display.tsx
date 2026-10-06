"use client";

import { CopyField } from "@/components/copy-text";
import { PUBLIC_ADDRESS_SETUP_TEXT } from "./public-address-text";
import type { AccessLinkResult } from "./types";

/**
 * Shown with an office-only link while APP_PUBLIC_URL is empty (M3-DESIGN §5.9), in the one public-address sentence
 * (M6-DESIGN §5.2): "For a link that works anywhere, follow the Cloudflare guide (…), then run setup.bat again (and
 * update.bat if the app runs as a Windows service)."
 */
export const PUBLIC_ADDRESS_HINT = `For a link that works anywhere, ${PUBLIC_ADDRESS_SETUP_TEXT.charAt(0).toLowerCase()}${PUBLIC_ADDRESS_SETUP_TEXT.slice(1)}`;

/** Shows a fresh invite/reset link with copy buttons and plain instructions. */
export function AccessLinkDisplay({ result }: { result: AccessLinkResult }) {
  const lifetime = result.purpose === "INVITE" ? "3 days" : "24 hours";
  return (
    <div className="grid gap-4">
      <p className="text-sm">
        Send this link yourself (WhatsApp or email). It works once and expires in {lifetime} ({result.expiresText}).
      </p>
      <div className="grid gap-1.5">
        <p className="text-sm font-medium">
          {result.primary.kind === "public" ? "Link that works anywhere" : "Link for the office network"}
        </p>
        <CopyField value={result.primary.url} label={result.primary.kind === "public" ? "link that works anywhere" : "office network link"} />
        {result.primary.kind === "office" && !result.officeIsLocalOnly ? (
          <p className="text-xs text-muted-foreground">
            It only opens on the office network. {PUBLIC_ADDRESS_HINT}
          </p>
        ) : null}
      </div>
      {result.office ? (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">Same link for office computers</p>
          <CopyField value={result.office} label="office network link" />
          <p className="text-xs text-muted-foreground">Use this one if the person sits in the office.</p>
        </div>
      ) : null}
      {result.officeIsLocalOnly ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          This link uses &ldquo;localhost&rdquo;, which only works on this PC. To get a link for other computers, open
          the app at the PC&apos;s office address (Settings › System shows it) and make the link there. Making a new
          link cancels this one.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        The app never emails this link for you, and it won&apos;t be shown again. If it gets lost, make a new one from
        the person&apos;s menu.
      </p>
    </div>
  );
}
