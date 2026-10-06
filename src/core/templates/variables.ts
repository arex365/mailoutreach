/**
 * The variables a template can use (PLAN.md B6.3, SPEC §5). Browser-safe: the editor's
 * one-click buttons, the live warnings and the renderer all read this one list.
 * Custom fields from imports are added at runtime (their keys are lowercase snake_case).
 */

export type TemplateVariable = {
  /** What goes between the braces, e.g. "first_name" → {{first_name}}. */
  name: string;
  /** Button label, e.g. "First name" (a custom field's own label, e.g. "Est. revenue"). */
  label: string;
  /** One short sentence for the button's tooltip. */
  description: string;
  /** True for custom fields from imports. */
  custom: boolean;
};

export const STANDARD_VARIABLES: readonly TemplateVariable[] = [
  {
    name: "first_name",
    label: "First name",
    description: "The person's first name. Empty for a General inbox address, so give it a fallback: {{first_name|there}}.",
    custom: false,
  },
  {
    name: "contact_name",
    label: "Full name",
    description: "The person's full name. Empty for a General inbox address.",
    custom: false,
  },
  { name: "company", label: "Company", description: "The company's name.", custom: false },
  { name: "website", label: "Website", description: "The company's website, for example acme.de.", custom: false },
  { name: "country", label: "Country", description: "The company's country, for example Germany.", custom: false },
  { name: "niche", label: "Niche", description: "The company's niche, for example Tabletop miniatures.", custom: false },
  {
    name: "personal_line",
    label: "Personal line",
    description: "The approved personal line (the person's own line when they have one). Use {{personal_line|}} so it can be empty.",
    custom: false,
  },
  { name: "sender_name", label: "Sender name", description: "The name of the teammate who sends the campaign.", custom: false },
  {
    name: "sender_signature",
    label: "Signature",
    description: "The sender's signature from their profile.",
    custom: false,
  },
  { name: "portfolio_url", label: "Portfolio link", description: "The portfolio link set in Settings.", custom: false },
];

export const STANDARD_VARIABLE_NAMES: ReadonlySet<string> = new Set(STANDARD_VARIABLES.map((v) => v.name));

/** Lowercase snake_case, starting with a letter: "first_name", "est_revenue". */
export function isValidVariableName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name);
}

/** Standard variables first, then custom fields (sorted by label), without duplicates or invalid keys. */
export function mergeVariables(custom: ReadonlyArray<{ key: string; label: string }>): TemplateVariable[] {
  const out: TemplateVariable[] = [...STANDARD_VARIABLES];
  const seen = new Set(STANDARD_VARIABLE_NAMES);
  const extra = custom
    .filter((f) => isValidVariableName(f.key) && !seen.has(f.key))
    .sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));
  for (const f of extra) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    out.push({
      name: f.key,
      label: f.label.trim() || f.key,
      description: `The "${f.label.trim() || f.key}" column from your imports (empty when a company has no value).`,
      custom: true,
    });
  }
  return out;
}
