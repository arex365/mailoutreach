/**
 * The practice copy's made-up data (PLAN.md A1, B6.5). Every company, person and address here
 * is invented: company domains all end in ".example" (a name reserved for examples, so no real
 * company can ever own one), and creators use obviously fake "…demo" Instagram handles and
 * Gmail addresses. The practice copy never sends anything.
 */

export const DEMO_PASSWORD = "practice-only-password";

export type DemoUserKey = "owner" | "ali";
export type ListKey = "de" | "no" | "ww" | "ig";
export type DemoStatus = "NOT_CONTACTED" | "CONTACTED" | "REPLIED" | "CLIENT" | "NOT_INTERESTED" | "DO_NOT_CONTACT";
export type DemoPriority = "HIGH" | "NORMAL" | "LOW";

export type DemoVerification = {
  status: "VALID" | "INVALID" | "RISKY" | "CATCH_ALL" | "UNKNOWN";
  risk: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  daysAgo: number;
};

export type DemoPerson = {
  name?: string;
  role?: string;
  email?: string;
  verification?: DemoVerification;
  bouncedDaysAgo?: number;
  unsubscribedDaysAgo?: number;
  repliedDaysAgo?: number;
  notes?: string;
};

export type DemoCompany = {
  name: string;
  website?: string;
  country?: string;
  niche: string;
  lists: ListKey[];
  status?: DemoStatus;
  priority?: DemoPriority;
  tags?: string[];
  people: DemoPerson[];
  /** Fields from the old tool, kept as custom fields. */
  custom?: Partial<Record<"followers" | "est_revenue" | "platforms", string>>;
  /** "Last contacted" date from the old tool, in days before today. */
  lastContactDaysAgo?: number;
  personalLine?: string;
  notes?: string;
  addedBy?: DemoUserKey;
  firstContactedBy?: DemoUserKey;
};

export const DEMO_USERS = [
  {
    key: "owner" as DemoUserKey,
    name: "Demo Owner",
    email: "demo@example.com",
    role: "OWNER" as const,
    timeZone: "Asia/Karachi",
    createdDaysAgo: 50,
  },
  {
    key: "ali" as DemoUserKey,
    name: "Ali Demo",
    email: "ali@example.com",
    role: "MEMBER" as const,
    timeZone: "Asia/Karachi",
    createdDaysAgo: 45,
  },
];

export const DEMO_LISTS: { key: ListKey; name: string; description: string }[] = [
  { key: "de", name: "German 3D Companies", description: "Practice data: made-up German printing services and studios." },
  { key: "no", name: "Norway 3D Companies", description: "Practice data: made-up Norwegian printing services and studios." },
  { key: "ww", name: "Worldwide Directory", description: "Practice data: made-up companies from around the world." },
  { key: "ig", name: "Instagram Creators", description: "Practice data: made-up creators with Instagram profiles." },
];

export const DEMO_CUSTOM_FIELDS = [
  { key: "followers", label: "Followers" },
  { key: "est_revenue", label: "Est. revenue" },
  { key: "platforms", label: "Platforms" },
] as const;

/** When the old-tool lists were "imported" into the practice copy. */
export const DEMO_IMPORT_DAYS_AGO = 40;

/** A creator: an Instagram profile as the website, a Gmail address (or none). */
function creator(
  name: string,
  handle: string,
  country: string | undefined,
  followers: string,
  person: DemoPerson | null,
  extra: Partial<DemoCompany> = {},
): DemoCompany {
  const { custom, ...rest } = extra;
  return {
    name,
    website: `https://www.instagram.com/${handle}/`,
    country,
    niche: "Creator",
    lists: ["ig"],
    people: person ? [{ role: "Creator", ...person }] : [],
    ...rest,
    custom: { followers, platforms: "Instagram", ...custom },
  };
}

export const DEMO_COMPANIES: DemoCompany[] = [
  // ───────────── German 3D Companies ─────────────
  {
    name: "Werkstatt Nord 3D GmbH",
    website: "https://www.werkstatt-nord-3d.example",
    country: "Germany",
    niche: "3D printing service",
    lists: ["de"],
    priority: "HIGH",
    tags: ["resin", "big-shop"],
    people: [
      { name: "Jonas Becker", role: "Head of production", email: "jonas.becker@werkstatt-nord-3d.example", verification: { status: "VALID", risk: "LOW", daysAgo: 20 } },
      { email: "info@werkstatt-nord-3d.example" },
    ],
    custom: { est_revenue: "€2–5M", platforms: "Own shop" },
    personalLine: "Your matte grey test prints of a harbour crane show how fine your resin layers are.",
  },
  {
    name: "Druckwerk Süd UG (haftungsbeschränkt)",
    website: "druckwerk-sued.example",
    country: "Deutschland",
    niche: "Resin printing",
    lists: ["de"],
    status: "CONTACTED",
    lastContactDaysAgo: 12,
    people: [{ email: "kontakt@druckwerk-sued.example" }],
  },
  {
    name: "Müller Additiv GmbH & Co. KG",
    website: "https://mueller-additiv.example/",
    country: "DE",
    niche: "Large-format printing",
    lists: ["de"],
    status: "REPLIED",
    priority: "HIGH",
    tags: ["warm-lead", "large-format"],
    lastContactDaysAgo: 20,
    firstContactedBy: "owner",
    people: [
      { name: "Anna Müller", role: "Managing director", email: "anna.mueller@mueller-additiv.example", repliedDaysAgo: 18 },
      { name: "Kai Vogel", role: "Purchasing", email: "k.vogel@mueller-additiv.example" },
    ],
    notes: "Asked for a price list for 30 cm statues. Send samples after the trade fair.",
  },
  {
    name: "Figurenschmiede Rheinland",
    website: "https://figurenschmiede-rheinland.example",
    country: "Germany",
    niche: "Figurines & collectibles",
    lists: ["de"],
    priority: "HIGH",
    people: [{ name: "Lena Hoffmann", role: "Art director", email: "lena@figurenschmiede-rheinland.example" }],
    custom: { followers: "12.4k", platforms: "Etsy, own shop" },
  },
  {
    name: "Polymer Atelier Leipzig",
    website: "polymer-atelier.example",
    country: "Germany",
    niche: "3D printing service",
    lists: ["de"],
    priority: "LOW",
    people: [{ email: "info@polymer-atelier.example" }],
  },
  {
    name: "Großformat Druck Bremen AG",
    website: "https://www.grossformat-bremen.example",
    country: "Germany",
    niche: "Large-format printing",
    lists: ["de"],
    status: "CLIENT",
    tags: ["big-shop", "large-format"],
    lastContactDaysAgo: 150,
    firstContactedBy: "owner",
    people: [
      { name: "Markus Schulz", role: "Sales", email: "markus.schulz@grossformat-bremen.example" },
      { email: "vertrieb@grossformat-bremen.example" },
    ],
    custom: { est_revenue: "€10M+" },
    notes: "Client since spring. Orders busts for trade-fair stands.",
  },
  {
    name: "Harzer Miniaturen",
    website: "https://harzer-miniaturen.example",
    country: "Germany",
    niche: "Tabletop miniatures",
    lists: ["de"],
    people: [{ name: "Tobias Wolf", role: "Owner" }],
    notes: "Only a contact form on their website. Find an email address.",
  },
  {
    name: "Schichtwerk Hamburg",
    website: "https://schichtwerk-hamburg.example",
    country: "Germany",
    niche: "3D printing service",
    lists: ["de"],
    tags: ["fdm"],
    people: [
      { name: "Sven Kraus", role: "Owner", email: "sven@schichtwerk-hamburg.example", verification: { status: "CATCH_ALL", risk: "LOW", daysAgo: 20 } },
      { email: "info@schichtwerk-hamburg.example" },
    ],
  },
  {
    name: "Resinhaus Köln",
    website: "https://resinhaus-koeln.example",
    country: "Germany",
    niche: "Resin printing",
    lists: ["de"],
    status: "NOT_INTERESTED",
    lastContactDaysAgo: 75,
    people: [{ name: "Julia Neumann", role: "Studio lead", email: "julia.neumann@resinhaus-koeln.example" }],
    notes: "Said they model everything in-house. Try again next year.",
  },
  {
    name: "Bavaria Print Lab",
    website: "bavaria-printlab.example",
    country: "Germany",
    niche: "3D printing service",
    lists: ["de"],
    people: [{ email: "hello@bavaria-printlab.example" }],
  },
  {
    name: "Sammlerstücke Berlin",
    website: "https://sammlerstuecke-berlin.example",
    country: "Germany",
    niche: "Figurines & collectibles",
    lists: ["de"],
    status: "CONTACTED",
    priority: "HIGH",
    tags: ["warm-lead"],
    lastContactDaysAgo: 5,
    people: [
      { name: "Felix Braun", role: "Product manager", email: "felix.braun@sammlerstuecke-berlin.example" },
      { name: "Clara Richter", role: "Purchasing", email: "clara.richter@sammlerstuecke-berlin.example" },
    ],
    custom: { followers: "38k", est_revenue: "€1–2M", platforms: "Kickstarter, own shop" },
  },
  {
    name: "Prototyp Manufaktur Stuttgart",
    website: "https://prototyp-manufaktur.example",
    country: "Germany",
    niche: "Prototyping",
    lists: ["de"],
    priority: "LOW",
    people: [{ email: "anfrage@prototyp-manufaktur.example" }],
  },
  {
    name: "Elbe Figuren Studio",
    website: "https://elbe-figuren.example",
    country: "Germany",
    niche: "Figurines & collectibles",
    lists: ["de"],
    people: [],
  },
  {
    name: "Druckerei Weber 3D",
    website: "https://druckerei-weber.example",
    country: "Germany",
    niche: "Large-format printing",
    lists: ["de"],
    status: "CONTACTED",
    lastContactDaysAgo: 45,
    people: [
      { name: "Stefan Weber", role: "Owner", email: "stefan@druckerei-weber.example" },
      { email: "info@druckerei-weber.example" },
    ],
  },
  {
    name: "Modellbau Fischer",
    website: "https://modellbau-fischer.example",
    country: "Germany",
    niche: "Scale models",
    lists: ["de"],
    tags: ["needs-samples"],
    people: [{ name: "Paul Fischer", role: "Owner", email: "paul@modellbau-fischer.example", bouncedDaysAgo: 30 }],
  },
  {
    name: "Pixelguss Dresden",
    website: "https://pixelguss.example",
    country: "Germany",
    niche: "Resin printing",
    lists: ["de"],
    priority: "LOW",
    people: [],
  },
  {
    name: "Nordlicht Drucktechnik",
    website: "https://nordlicht-drucktechnik.example",
    country: "Germany",
    niche: "Large-format printing",
    lists: ["de"],
    people: [{ email: "kontakt@nordlicht-drucktechnik.example" }],
  },
  {
    name: "Tischkrieger Miniaturen",
    website: "https://tischkrieger.example",
    country: "Germany",
    niche: "Tabletop miniatures",
    lists: ["de"],
    status: "CONTACTED",
    lastContactDaysAgo: 26,
    people: [{ name: "Lukas Zimmermann", role: "Founder", email: "lukas@tischkrieger.example" }],
    custom: { followers: "9.1k", platforms: "Patreon, MyMiniFactory" },
    personalLine: "Your monthly sets of desert raiders have a very consistent sculpt style.",
  },
  {
    name: "Kunstharz Kollektiv",
    website: "https://kunstharz-kollektiv.example",
    country: "Germany",
    niche: "Figurines & collectibles",
    lists: ["de"],
    people: [{ email: "info@kunstharz-kollektiv.example" }],
  },
  {
    name: "Schwarzwald Statuen",
    website: "https://schwarzwald-statuen.example",
    country: "Germany",
    niche: "Busts & statues",
    lists: ["de"],
    priority: "HIGH",
    people: [{ name: "Marie Schäfer", role: "Owner", email: "marie@schwarzwald-statuen.example" }],
    personalLine: "Your life-size carved owl made me wonder how it would look as a printed statue.",
  },
  {
    name: "Druckzentrum Hannover",
    website: "https://druckzentrum-hannover.example",
    country: "Germany",
    niche: "3D printing service",
    lists: ["de"],
    status: "DO_NOT_CONTACT",
    lastContactDaysAgo: 95,
    people: [
      { name: "Elias Hartmann", role: "Production planner", email: "e.hartmann@druckzentrum-hannover.example" },
      { email: "info@druckzentrum-hannover.example" },
    ],
    notes: "Asked us not to email again.",
  },
  {
    name: "Voxelwerk München",
    website: "https://voxelwerk-muenchen.example",
    country: "Germany",
    niche: "3D printing service",
    lists: ["de", "ww"],
    tags: ["resin", "fdm"],
    people: [{ name: "Sophie Lange", role: "Customer projects", email: "sophie.lange@voxelwerk-muenchen.example" }],
  },

  // ───────────── Norway 3D Companies ─────────────
  {
    name: "Fjordprint AS",
    website: "https://fjordprint.example",
    country: "Norway",
    niche: "3D printing service",
    lists: ["no"],
    status: "CONTACTED",
    priority: "HIGH",
    lastContactDaysAgo: 9,
    people: [
      { name: "Ingrid Hansen", role: "Managing director", email: "ingrid@fjordprint.example" },
      { email: "post@fjordprint.example" },
    ],
  },
  {
    name: "Nordkapp Figurer",
    website: "https://nordkapp-figurer.example",
    country: "Norge",
    niche: "Figurines & collectibles",
    lists: ["no"],
    people: [{ name: "Kari Berg", role: "Owner", email: "kari@nordkapp-figurer.example" }],
    personalLine: "Your troll figurines with moss-textured bases would print beautifully at larger sizes.",
  },
  {
    name: "Trollskog Studio",
    website: "https://trollskog-studio.example",
    country: "Norway",
    niche: "Figurines & collectibles",
    lists: ["no"],
    people: [{ email: "post@trollskog-studio.example" }],
    custom: { followers: "5.3k" },
  },
  {
    name: "Bergen Storformat AS",
    website: "https://bergen-storformat.example",
    country: "NO",
    niche: "Large-format printing",
    lists: ["no"],
    status: "REPLIED",
    lastContactDaysAgo: 14,
    firstContactedBy: "ali",
    people: [{ name: "Erik Johansen", role: "Sales", email: "erik.johansen@bergen-storformat.example", repliedDaysAgo: 12 }],
    notes: "Interested in printed mascots for a shopping centre. Ali is following up.",
  },
  {
    name: "Lofoten Lag AS",
    website: "https://lofoten-lag.example",
    country: "Norway",
    niche: "3D printing service",
    lists: ["no"],
    people: [{ name: "Håkon Nilsen", role: "Owner" }],
  },
  {
    name: "Oslo Resin Verksted",
    website: "https://oslo-resin.example",
    country: "Norway",
    niche: "Resin printing",
    lists: ["no"],
    people: [
      { name: "Nora Larsen", role: "Studio lead", email: "nora@oslo-resin.example" },
      { email: "post@oslo-resin.example", unsubscribedDaysAgo: 40 },
    ],
  },
  {
    name: "Vikingmodell AS",
    website: "https://vikingmodell.example",
    country: "Norway",
    niche: "Tabletop miniatures",
    lists: ["no"],
    priority: "LOW",
    people: [{ name: "Magnus Olsen", role: "Founder", email: "magnus@vikingmodell.example" }],
    custom: { platforms: "Etsy" },
  },
  {
    name: "Tromsø 3D-print",
    website: "https://tromso-3dprint.example",
    country: "Norway",
    niche: "3D printing service",
    lists: ["no"],
    people: [{ email: "firmapost@tromso-3dprint.example" }],
  },
  {
    name: "Nordlys Samleobjekter",
    website: "https://nordlys-samleobjekter.example",
    country: "Norway",
    niche: "Figurines & collectibles",
    lists: ["no"],
    status: "CLIENT",
    lastContactDaysAgo: 200,
    firstContactedBy: "owner",
    people: [{ name: "Sigrid Dahl", role: "Product manager", email: "sigrid.dahl@nordlys-samleobjekter.example" }],
    notes: "Ordered a set of six creature figurines. Happy with the files.",
  },
  {
    name: "Stavanger Prototyp AS",
    website: "https://stavanger-prototyp.example",
    country: "Norway",
    niche: "Prototyping",
    lists: ["no"],
    status: "CONTACTED",
    lastContactDaysAgo: 33,
    people: [{ email: "post@stavanger-prototyp.example" }],
  },

  // ───────────── Worldwide Directory ─────────────
  {
    name: "Brightline Large Format Inc.",
    website: "https://www.brightline-largeformat.example",
    country: "USA",
    niche: "Large-format printing",
    lists: ["ww"],
    priority: "HIGH",
    people: [
      { name: "Megan Carter", role: "Operations manager", email: "megan.carter@brightline-largeformat.example" },
      { email: "info@brightline-largeformat.example" },
    ],
    custom: { est_revenue: "$5–10M" },
  },
  {
    name: "Pinecrest Collectibles LLC",
    website: "https://pinecrest-collectibles.example",
    country: "United States",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    status: "CONTACTED",
    tags: ["warm-lead"],
    lastContactDaysAgo: 3,
    people: [{ name: "Daniel Brooks", role: "Product development", email: "dan@pinecrest-collectibles.example" }],
    custom: { followers: "61k", platforms: "Kickstarter, Amazon" },
  },
  {
    name: "Mesa Miniatures Co.",
    website: "https://mesa-miniatures.example",
    country: "US",
    niche: "Tabletop miniatures",
    lists: ["ww"],
    people: [{ email: "hello@mesa-miniatures.example" }],
  },
  {
    name: "Harbor 3D Print Shop",
    website: "https://harbor3d-printshop.example",
    country: "United States",
    niche: "3D printing service",
    lists: ["ww"],
    status: "NOT_INTERESTED",
    lastContactDaysAgo: 90,
    people: [{ name: "Chris Nguyen", role: "Owner", email: "chris@harbor3d-printshop.example" }],
  },
  {
    name: "Ironclad Statues",
    website: "https://ironclad-statues.example",
    country: "USA",
    niche: "Busts & statues",
    lists: ["ww"],
    priority: "HIGH",
    people: [{ name: "Rachel Kim", role: "Creative director", email: "rachel@ironclad-statues.example" }],
    personalLine: "Your bronze-look bust of a sea captain is exactly the kind of piece we model.",
  },
  {
    name: "Thameside Printworks Ltd",
    website: "https://thameside-printworks.example",
    country: "UK",
    niche: "Large-format printing",
    lists: ["ww"],
    people: [
      { name: "Oliver Hughes", role: "Studio manager", email: "oliver.hughes@thameside-printworks.example" },
      { email: "enquiries@thameside-printworks.example" },
    ],
  },
  {
    name: "Kestrel Figures Ltd",
    website: "https://kestrel-figures.example",
    country: "United Kingdom",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    status: "REPLIED",
    tags: ["warm-lead"],
    lastContactDaysAgo: 7,
    firstContactedBy: "ali",
    people: [{ name: "Amelia Clarke", role: "Founder", email: "amelia@kestrel-figures.example", repliedDaysAgo: 6 }],
  },
  {
    name: "Polderprint BV",
    website: "https://polderprint.example",
    country: "Netherlands",
    niche: "3D printing service",
    lists: ["ww"],
    people: [{ email: "info@polderprint.example" }],
  },
  {
    name: "Atelier Figurine Lumière SARL",
    website: "https://atelier-lumiere.example",
    country: "France",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    people: [{ name: "Camille Laurent", role: "Owner", email: "camille@atelier-lumiere.example" }],
  },
  {
    name: "Estudio Resina SL",
    website: "https://estudio-resina.example",
    country: "Spain",
    niche: "Resin printing",
    lists: ["ww"],
    people: [{ email: "info@estudio-resina.example" }],
  },
  {
    name: "Statuaria Digitale SRL",
    website: "https://statuaria-digitale.example",
    country: "Italy",
    niche: "Busts & statues",
    lists: ["ww"],
    status: "CONTACTED",
    lastContactDaysAgo: 60,
    people: [{ name: "Marco Bianchi", role: "Owner", email: "marco@statuaria-digitale.example" }],
  },
  {
    name: "Wydruk 3D Kraków Sp. z o.o.",
    website: "https://wydruk3d-krakow.example",
    country: "Poland",
    niche: "3D printing service",
    lists: ["ww"],
    people: [{ email: "kontakt@wydruk3d-krakow.example" }],
  },
  {
    name: "Svea Storformat AB",
    website: "https://svea-storformat.example",
    country: "Sweden",
    niche: "Large-format printing",
    lists: ["ww"],
    people: [{ name: "Johan Lindqvist", role: "Sales", email: "johan@svea-storformat.example" }],
  },
  {
    name: "Hygge Figurer ApS",
    website: "https://hygge-figurer.example",
    country: "Denmark",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    priority: "LOW",
    people: [],
  },
  {
    name: "Sakura Garage Kits",
    website: "https://sakura-garagekits.example",
    country: "Japan",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    priority: "HIGH",
    people: [{ name: "Yuki Tanaka", role: "Sculpt team lead", email: "yuki@sakura-garagekits.example" }],
    custom: { followers: "120k", platforms: "Own shop, events" },
  },
  {
    name: "Southern Cross Printing Pty Ltd",
    website: "https://southern-cross-printing.example",
    country: "Australia",
    niche: "Large-format printing",
    lists: ["ww"],
    people: [{ email: "sales@southern-cross-printing.example" }],
  },
  {
    name: "Maple Resin Works",
    website: "https://maple-resin-works.example",
    country: "Canada",
    niche: "Resin printing",
    lists: ["ww"],
    people: [
      { name: "Liam Tremblay", role: "Owner", email: "liam@maple-resin-works.example", verification: { status: "INVALID", risk: "HIGH", daysAgo: 15 } },
    ],
  },
  {
    name: "Estatuetas Brasil Ltda",
    website: "https://estatuetas-brasil.example",
    country: "Brazil",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    people: [{ name: "Beatriz Souza", role: "Designer", email: "beatriz@estatuetas-brasil.example" }],
  },
  {
    name: "Alpenfigur GmbH",
    website: "https://alpenfigur.example",
    country: "Austria",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    people: [{ email: "office@alpenfigur.example" }],
  },
  {
    name: "Helvetia Druck 3D AG",
    website: "https://helvetia-druck3d.example",
    country: "Switzerland",
    niche: "3D printing service",
    lists: ["ww"],
    status: "CONTACTED",
    lastContactDaysAgo: 28,
    people: [{ name: "Nina Keller", role: "Projects", email: "nina.keller@helvetia-druck3d.example" }],
  },
  {
    name: "Revontuli Prints Oy",
    website: "https://revontuli-prints.example",
    country: "Finland",
    niche: "3D printing service",
    lists: ["ww"],
    priority: "LOW",
    people: [{ email: "info@revontuli-prints.example" }],
  },
  {
    name: "Desert Bloom Props",
    website: "https://desert-bloom-props.example",
    country: "USA",
    niche: "Cosplay props",
    lists: ["ww"],
    people: [{ name: "Sofia Ramirez", role: "Owner", email: "sofia@desert-bloom-props.example" }],
    custom: { followers: "22k", platforms: "Etsy, Instagram" },
  },
  {
    name: "Seoul Figure Lab",
    website: "https://seoul-figurelab.example",
    country: "South Korea",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    people: [{ name: "Minjun Park", role: "Producer", email: "minjun@seoul-figurelab.example" }],
  },
  {
    name: "Nomad Figure Collective",
    website: "https://nomad-figures.example",
    niche: "Figurines & collectibles",
    lists: ["ww"],
    addedBy: "ali",
    people: [{ name: "Robin Ellis", role: "Coordinator", email: "robin@nomad-figures.example" }],
    notes: "No country known yet, so the default time zone is used until someone sets one.",
  },

  // ───────────── Instagram Creators ─────────────
  creator("Anna Sculpts", "anna.sculpts.demo", "Germany", "48.2k", { name: "Anna Weiss", email: "anna.sculpts.demo@gmail.com" }, {
    status: "CONTACTED",
    lastContactDaysAgo: 15,
    custom: { platforms: "Instagram, Patreon" },
  }),
  creator("Tinyforge", "tinyforge.demo", "USA", "12k", { name: "Mark Ellison", email: "tinyforge.demo@gmail.com" }, {
    custom: { platforms: "Instagram, Etsy" },
  }),
  creator("Resin Rituals", "resin.rituals.demo", "UK", "86k", { name: "Priya Shah", email: "resin.rituals.demo@gmail.com" }, {
    priority: "HIGH",
    custom: { platforms: "Instagram, YouTube" },
    personalLine: "Your time-lapse of a dragon skull curing in resin was a great look at your process.",
  }),
  creator("Painted Peaks", "painted.peaks.demo", "Norway", "7.8k", { name: "Emma Solberg", email: "painted.peaks.demo@gmail.com" }),
  creator("Dragon Loft", "dragon.loft.demo", "USA", "31k", null, {
    notes: "No email on the profile. Try the link in their bio.",
  }),
  creator("Miniwerk", "miniwerk.demo", "Germany", "15.5k", { name: "Leon Busch", email: "miniwerk.demo@gmail.com", repliedDaysAgo: 3 }, {
    status: "REPLIED",
    lastContactDaysAgo: 4,
    firstContactedBy: "ali",
    custom: { platforms: "Instagram, MyMiniFactory" },
  }),
  creator("The Bust Bureau", "the.bust.bureau.demo", "UK", "54k", { name: "Hannah Price", email: "thebustbureau.demo@gmail.com" }, {
    custom: { platforms: "Instagram, Patreon", est_revenue: "$100–250k" },
  }),
  creator("Plastic Pantheon", "plastic.pantheon.demo", "Brazil", "19k", { name: "Lucas Ferreira", email: "plastic.pantheon.demo@gmail.com" }),
  creator("Critter Casts", "critter.casts.demo", "Australia", "9.4k", { name: "Mia Johnson", email: "crittercasts.demo@gmail.com" }, {
    custom: { platforms: "Instagram, Etsy" },
  }),
  creator("Moonlit Minis", "moonlit.minis.demo", "Canada", "27k", { name: "Ella Moon" }),
  creator("Pixel to Plastic", "pixel.to.plastic.demo", "Japan", "73k", { name: "Kenji Mori", email: "pixeltoplastic.demo@gmail.com" }, {
    custom: { est_revenue: "$100–250k" },
  }),
  creator("Cosplay Cove", "cosplay.cove.demo", "USA", "140k", { name: "Jess Taylor", email: "cosplaycove.demo@gmail.com" }, {
    status: "NOT_INTERESTED",
    priority: "HIGH",
    lastContactDaysAgo: 50,
    custom: { platforms: "Instagram, TikTok, YouTube" },
  }),
  creator("Gilded Gremlin", "gilded.gremlin.demo", "UK", "4.2k", { name: "Tom Harlow", email: "gildedgremlin.demo@gmail.com" }, {
    priority: "LOW",
  }),
  creator("Fjord Figures", "fjord.figures.demo", "Norway", "11k", { name: "Ola Eide", email: "fjordfigures.demo@gmail.com" }, {
    lists: ["ig", "no"],
  }),
  creator("Kaiju Kitchen", "kaiju.kitchen.demo", "USA", "33k", { name: "Sam Lee", email: "kaijukitchen.demo@gmail.com" }, {
    status: "CONTACTED",
    lastContactDaysAgo: 22,
  }),
  creator("Statue Stories", "statue.stories.demo", "Italy", "6.1k", null),
  creator("Wyrm Works", "wyrm.works.demo", "Denmark", "18k", { name: "Freya Lund", email: "wyrmworks.demo@gmail.com" }, {
    custom: { platforms: "Instagram, Kickstarter" },
  }),
  creator("Little Legends", "little.legends.demo", "Germany", "25k", { name: "Noah Fischer", email: "littlelegends.demo@gmail.com" }, {
    status: "CONTACTED",
    lastContactDaysAgo: 110,
  }),
  creator("Ember and Ink", "ember.and.ink.demo", "France", "8.9k", { name: "Chloe Martin", email: "emberandink.demo@gmail.com" }),
  creator("Brushbound", "brushbound.demo", "Sweden", "14k", { name: "Isak Berg", email: "brushbound.demo@gmail.com" }, {
    status: "DO_NOT_CONTACT",
    lastContactDaysAgo: 65,
    notes: "Asked not to be contacted by studios.",
  }),
  creator("Shelf Monsters", "shelf.monsters.demo", "USA", "41k", { name: "Olivia Grant", email: "shelfmonsters.demo@gmail.com" }, {
    lists: ["ig", "ww"],
    custom: { platforms: "Instagram, Etsy" },
  }),
  creator("Tabletop Tales", "tabletop.tales.demo", "Canada", "16k", { name: "Ben Carter", email: "tabletoptales.demo@gmail.com" }),
  creator("Clay to Print", "clay.to.print.demo", undefined, "3.5k", { name: "Lea Novak", email: "claytoprint.demo@gmail.com" }, {
    priority: "LOW",
    addedBy: "ali",
  }),
  creator("Hollow Hill Minis", "hollow.hill.minis.demo", "Ireland", "21k", { name: "Grace O'Neill", email: "hollowhillminis.demo@gmail.com" }, {
    lists: ["ig", "ww"],
  }),
];
