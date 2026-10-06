import type { Metadata } from "next";
import { NotFoundScreen } from "@/components/error-screens";

export const metadata: Metadata = { title: "Page not found" };

/** Any address the app doesn't know. "Go to Contacts" asks signed-out visitors to sign in first. */
export default function RootNotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center">
      <div className="w-full">
        <NotFoundScreen />
      </div>
    </main>
  );
}
