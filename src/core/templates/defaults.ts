/**
 * The default sequences from PLAN.md A7, word for word. A fresh database gets them once
 * (ensureDefaultTemplates in src/server/services/templates.ts). Pure data.
 */

export type DefaultTemplateStep = {
  step: number;
  enabled: boolean;
  subject: string | null;
  body: string;
  delayDays: number;
};

export type DefaultTemplate = { name: string; isMaster: boolean; steps: DefaultTemplateStep[] };

const lines = (...parts: string[]) => parts.join("\n");

export const MASTER_SEQUENCE: DefaultTemplate = {
  name: "Master sequence",
  isMaster: true,
  steps: [
    {
      step: 0,
      enabled: true,
      subject: "{Print-ready 3D models|3D models} for {{company}}",
      body: lines(
        "{Hi|Hello} {{first_name|there}},",
        "",
        "{{personal_line|}}",
        "",
        "I'm {{sender_name}} from Polygon Paradise. We make print-ready 3D models: character figurines, animals and creatures, busts and statues. Every file is clean and watertight, so there's no repair work before printing.",
        "",
        "If you need new designs for your range, or a custom model for a client, we can do the modelling for you.",
        "",
        "Would it help if I sent two or three examples close to what you make?",
        "",
        "{{sender_signature}}",
      ),
      delayDays: 0,
    },
    {
      step: 1,
      enabled: true,
      subject: null,
      body: lines(
        "Hi {{first_name|there}},",
        "",
        "Here are a few of our recent models, in case they're useful: {{portfolio_url}}",
        "",
        "Is any of this close to what you make?",
        "",
        "{{sender_signature}}",
      ),
      delayDays: 3,
    },
    {
      step: 2,
      enabled: true,
      subject: null,
      body: lines(
        "Hi {{first_name|there}},",
        "",
        "One idea: you could start with a single model, like one figurine or one bust, and see how the file prints on your machines before ordering more.",
        "",
        "Is there a design you've been wanting to add to your range?",
        "",
        "{{sender_signature}}",
      ),
      delayDays: 4,
    },
    {
      step: 3,
      enabled: false,
      subject: null,
      body: lines(
        "Hi {{first_name|there}},",
        "",
        "I'll leave it here so I don't crowd your inbox. If print-ready models become useful for you later, just reply to this email and I'll send examples and prices.",
        "",
        "Would it be alright to check back in a few months?",
        "",
        "{{sender_signature}}",
      ),
      delayDays: 7,
    },
  ],
};

export const CREATORS_SEQUENCE: DefaultTemplate = {
  name: "Creators",
  isMaster: false,
  steps: [
    {
      step: 0,
      enabled: true,
      subject: "Print-ready 3D models",
      body: lines(
        "{Hi|Hello} {{first_name|there}},",
        "",
        "{{personal_line|}}",
        "",
        "I'm {{sender_name}} from Polygon Paradise. We turn characters and creatures into print-ready 3D models, clean and watertight, ready to print as figurines, busts or statues.",
        "",
        "If you'd ever like one of your designs as a printable model, we can do the modelling for you.",
        "",
        "Would you like to see a couple of examples?",
        "",
        "{{sender_signature}}",
      ),
      delayDays: 0,
    },
    {
      step: 1,
      enabled: true,
      subject: null,
      body: lines(
        "Hi {{first_name|there}},",
        "",
        "Here are some recent models, so you can see the style and detail: {{portfolio_url}}",
        "",
        "Is there a character of yours you'd like to see as a figurine?",
        "",
        "{{sender_signature}}",
      ),
      delayDays: 4,
    },
  ],
};

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [MASTER_SEQUENCE, CREATORS_SEQUENCE];

/** Starting text for a new template's first email and for "+ Add follow-up". */
export const NEW_FIRST_EMAIL_BODY = lines("{Hi|Hello} {{first_name|there}},", "", "", "", "{{sender_signature}}");
export const NEW_FOLLOW_UP_BODY = lines("Hi {{first_name|there}},", "", "", "", "{{sender_signature}}");

/** Suggested wait before each follow-up (follow-up 1, 2, 3), as in the master sequence. */
export const DEFAULT_FOLLOW_UP_DELAYS = [3, 4, 7] as const;
