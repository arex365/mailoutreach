/**
 * The pure parts of the manual-check seed (scripts/seed-m6-manual.ts): the address rule every seeded address must
 * pass, the made-up company names, and the long values the screen checks need (review SCREENS-04/05/06/08/12 and the
 * wizard's Review step). Real data has 60-character company names, 50-character website hosts, long email addresses
 * and campaigns named after their list, and a phone screen must cut or wrap them, never scroll sideways; the seed puts
 * one of each where tests/playwright/screens.spec.ts and settings.spec.ts look. No I/O here, so
 * tests/unit/ops/seed-m6-values.test.ts checks these values without running the seed.
 */

/** Only addresses that can't belong to anyone: example.com and its subdomains, and *.example (RFC 2606). */
export function isSafeAddress(address: string): boolean {
  const domain = (address.trim().toLowerCase().split("@")[1] ?? "").replace(/\.$/, "");
  return domain === "example.com" || domain.endsWith(".example.com") || domain.endsWith(".example");
}

const PLACES = ["Nord", "Alpen", "Rhein", "Fjord", "Polar", "Delta", "Hansa", "Elbe", "Isar", "Main", "Weser", "Havel"] as const;
const PLACES_2 = ["Donau", "Mosel", "Saar", "Ruhr", "Lahn", "Spree", "Fulda", "Ems", "Inn", "Lech", "Nahe", "Tauber"] as const;
const KINDS = ["Figurenwerk", "Miniaturen", "Modellbau", "Druckhaus", "Resin Studio", "Print Lab", "Maker Works", "Formfabrik", "Atelier", "Werkstatt", "Kunstguss", "Prototyp"] as const;
const ALL_PLACES = [...PLACES, ...PLACES_2];

/** How many different made-up company names there are. */
export const MADE_UP_NAME_COUNT = ALL_PLACES.length * KINDS.length;

/** The `i`-th made-up company name ("Nord Figurenwerk", "Alpen Figurenwerk", …), each one once. */
export function madeUpCompanyName(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i >= MADE_UP_NAME_COUNT) throw new Error("Out of made-up company names.");
  return `${ALL_PLACES[i % ALL_PLACES.length]} ${KINDS[Math.floor(i / ALL_PLACES.length)]}`;
}

/** Its *.example domain: "nord-figurenwerk.example". */
export function madeUpDomain(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`;
}

/**
 * The long values (every address on *.example):
 *  - `company`: a 61-character name with a 50-character website host, whose person has a 49-character address. It is
 *    one of the prospects of the draft "Germany Q4" (ready and live: the wizard's six steps), it sorts onto Contacts'
 *    first page (by name: only "Alpen …" comes before it), and in the live state its AI line is approved (AI lines ›
 *    Approved shows its card with the long host);
 *  - `runningCampaign`: the live state's running dry run (Campaigns opens on the Running tab), 81 characters;
 *  - `draftCampaign`: a second draft in the live state (Campaigns › Drafts), 79 characters;
 *  - `testAddress`: the busy state's third test-list address (Settings › Sending & Mailgun › Test list), 43 characters;
 *  - `teammate`: a switched-off Member in the busy state (Settings › Team), a 34-character address.
 */
export const LONG_VALUES = {
  company: {
    name: "Architekturbüro Müller-Schmidt Modellbau und Figurenwerkstatt",
    domain: "architekturbuero-mueller-schmidt-modellbau.example",
    country: "DE",
    niche: "Architectural models",
    person: { name: "Katharina Müller-Schmidt", email: "katharina.mueller-schmidt@mueller-schmidt.example" },
  },
  runningCampaign: "Spring figures for tabletop studios in Germany, Austria and Switzerland (dry run)",
  draftCampaign: "Architecture and model-making studios, second round after the autumn trade fair",
  testAddress: "tia.tester-mailbox@inbox-three-long.example",
  teammate: { name: "Muhammad Ali Hassan", email: "muhammad.ali.hassan@studio.example" },
} as const;
