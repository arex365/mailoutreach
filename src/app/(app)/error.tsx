"use client";

import { ErrorScreen } from "@/components/error-screens";

/** Something failed while showing a signed-in page: a plain message inside the app's frame. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen error={error} retry={retry} />;
}
