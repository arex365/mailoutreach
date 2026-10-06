import { NotFoundScreen } from "@/components/error-screens";

/** A signed-in page asked for something that doesn't exist (e.g. an import that was started over). */
export default function AppNotFound() {
  return <NotFoundScreen />;
}
