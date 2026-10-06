"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { saveFooterAction } from "@/app/(app)/settings/footer/actions";
import { footerPreview, validateFooter, type FooterFieldErrors, type FooterValues } from "./footer-format";

const OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";

/**
 * The email footer form (M3-DESIGN §5.6): company name, address, unsubscribe line and portfolio link,
 * with a live preview of the text and HTML footer ("[unsubscribe link]" stands in for Mailgun's
 * personal link). "Save footer" is the page's primary action.
 */
export function FooterForm({ initial }: { initial: FooterValues }) {
  const id = useId();
  const router = useRouter();
  const [values, setValues] = useState<FooterValues>(initial);
  const [errors, setErrors] = useState<FooterFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const preview = footerPreview(values);

  function set<K extends keyof FooterValues>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const checked = validateFooter(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      setFormError("Some details need fixing. Check the highlighted fields.");
      return;
    }
    setErrors({});
    setFormError(null);
    startTransition(async () => {
      try {
        const res = await saveFooterAction(checked.value);
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v?.[0]])) as FooterFieldErrors);
          setFormError(res.error);
          return;
        }
        setValues(res.data);
        toast.success(res.message ?? "Footer saved.");
        router.refresh();
      } catch {
        setFormError(OFFLINE);
      }
    });
  }

  const describe = (key: keyof FooterValues) => (errors[key] ? `${id}-${key}-error` : `${id}-${key}-hint`);

  return (
    <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" noValidate>
      <div className="grid content-start gap-4">
        <Field label="Company name" htmlFor={`${id}-companyName`} hint="Shown in every email's footer." error={errors.companyName}>
          <Input
            id={`${id}-companyName`}
            value={values.companyName}
            onChange={(e) => set("companyName", e.target.value)}
            aria-invalid={errors.companyName ? true : undefined}
            aria-describedby={describe("companyName")}
          />
        </Field>
        <Field label="Address" htmlFor={`${id}-address`} hint="Your postal address, on one line (the law asks for it in marketing emails)." error={errors.address}>
          <Input
            id={`${id}-address`}
            value={values.address}
            onChange={(e) => set("address", e.target.value)}
            aria-invalid={errors.address ? true : undefined}
            aria-describedby={describe("address")}
          />
        </Field>
        <Field
          label="Unsubscribe line"
          htmlFor={`${id}-unsubscribeText`}
          hint="The words before the unsubscribe link, for example “If you'd rather not hear from us, unsubscribe here:”."
          error={errors.unsubscribeText}
        >
          <Input
            id={`${id}-unsubscribeText`}
            value={values.unsubscribeText}
            onChange={(e) => set("unsubscribeText", e.target.value)}
            aria-invalid={errors.unsubscribeText ? true : undefined}
            aria-describedby={describe("unsubscribeText")}
          />
        </Field>
        <Field label="Portfolio link" htmlFor={`${id}-portfolioUrl`} hint="Used by {{portfolio_url}} in your templates. Starts with https://." error={errors.portfolioUrl}>
          <Input
            id={`${id}-portfolioUrl`}
            type="url"
            inputMode="url"
            value={values.portfolioUrl}
            onChange={(e) => set("portfolioUrl", e.target.value)}
            aria-invalid={errors.portfolioUrl ? true : undefined}
            aria-describedby={describe("portfolioUrl")}
          />
        </Field>
        <FormError message={formError} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save footer"}
          </Button>
        </div>
      </div>

      <section aria-labelledby={`${id}-preview`} className="grid content-start gap-3">
        <h3 id={`${id}-preview`} className="text-sm font-medium">
          Preview
        </h3>
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Plain text</span>
          <pre className="rounded-lg border border-border bg-background p-3 text-xs leading-relaxed break-words whitespace-pre-wrap">{preview.text}</pre>
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">HTML</span>
          <div
            className="rounded-lg border border-border bg-background p-3 text-xs leading-relaxed break-words text-muted-foreground"
            // The footer HTML is built from escaped text only (footerHtml escapes every field).
            dangerouslySetInnerHTML={{ __html: preview.html }}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Mailgun turns the unsubscribe link into a personal link for each person, which works even while this PC is off.
        </p>
      </section>
    </form>
  );
}
