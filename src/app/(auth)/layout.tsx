import { Logo } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-8">
        <Logo subtitle="Outreach" />
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
