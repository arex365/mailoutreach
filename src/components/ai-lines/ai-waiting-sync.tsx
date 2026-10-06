"use client";

import { useEffect } from "react";
import { publishAiWaiting } from "@/components/shell/nav-items";

/** Hands the Waiting count the AI lines page just rendered to the sidebar's badge (after every review and refresh). */
export function AiWaitingSync({ count }: { count: number }) {
  useEffect(() => {
    publishAiWaiting(count);
  }, [count]);
  return null;
}
