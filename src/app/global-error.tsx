"use client";

import { ErrorScreen } from "@/components/error-screens";
import "./globals.css";

/**
 * Last resort when even the app's outer frame failed to show. It replaces the whole page, so it
 * brings its own <html>, <body> and styles (dark, like the rest of the app).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="grid min-h-full place-items-center">
        <title>Something went wrong · Outreach</title>
        <main id="main" className="w-full">
          <ErrorScreen error={error} retry={retry} />
        </main>
      </body>
    </html>
  );
}
