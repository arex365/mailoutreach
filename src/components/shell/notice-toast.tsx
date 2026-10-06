"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/** One-off messages a redirect can pass in the URL (`?notice=owner-only`, from requireOwner). */
export const NOTICE_TEXTS: Readonly<Record<string, string>> = {
  "owner-only": "Only the Owner can open that page.",
};

/**
 * The sentence for a `?notice=` value, or null for an unknown or missing one. Only the table's own keys count: the
 * value comes from the address bar, and `constructor`, `__proto__` or `valueOf` would otherwise find Object's built-ins
 * (a function or an object as the toast's title breaks the page).
 */
export function noticeText(notice: string | null | undefined): string | null {
  if (!notice || !Object.hasOwn(NOTICE_TEXTS, notice)) return null;
  const text = NOTICE_TEXTS[notice];
  return typeof text === "string" ? text : null;
}

/**
 * Shows a one-off message passed in the URL (`?notice=owner-only`) as a toast, then tidies the URL (the rest of the
 * query and the hash stay). Mounted by the dashboard (where Members land from an Owner-only page, M6-DESIGN §4.5) and
 * by Contacts.
 */
export function NoticeToast({ notice }: { notice: string | null }) {
  const router = useRouter();
  useEffect(() => {
    if (!notice) return;
    const text = noticeText(notice);
    if (text) toast.info(text, { id: `notice-${notice}` });
    const url = new URL(window.location.href);
    if (!url.searchParams.has("notice")) return;
    url.searchParams.delete("notice");
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  }, [notice, router]);
  return null;
}
