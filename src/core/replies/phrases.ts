/**
 * The word and header lists the reply classifier reads (docs/dev/research/replies-and-auto-replies.md Appendix A,
 * M4-DESIGN §3.4). The lists are the research's, unchanged, except that the subject prefixes are split into
 * multi-word phrases (strong) and single words (strong only before ":" or " -", §3.4 rule 5). Pure and browser-safe;
 * every regex is built once when the module loads.
 *
 * Matching is case-insensitive after NFC normalisation, with no-break spaces (U+00A0, U+202F, U+2007) turned into
 * plain spaces, so French "Réponse automatique :" matches with any kind of space before the colon.
 */

/** NFC, and no-break spaces as plain spaces. Newlines are kept. */
export function cleanMailText(s: string): string {
  return s.normalize("NFC").replace(/[   ]/g, " ");
}

/** `cleanMailText`, then every run of whitespace (newlines too) as one space, trimmed. */
export function flattenMailText(s: string): string {
  return cleanMailText(s).replace(/\s+/g, " ").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A phrase list as one case-insensitive regex. Spaces in a phrase match any run of whitespace, and the phrase must
 * stand as whole words (Unicode-aware: JavaScript's `\b` only knows ASCII letters). `anchored` phrases must start the
 * text (after spaces and an optional "["); `follow` is an extra lookahead the phrase must be followed by.
 */
export function phrases(list: readonly string[], opts: { anchored?: boolean; follow?: string } = {}): RegExp {
  const alt = list.map((p) => escapeRegex(p).replace(/ /g, "\\s+")).join("|");
  const lead = opts.anchored ? "^\\s*(?:\\[\\s*)?" : "(?:^|[^\\p{L}\\p{N}])";
  const tail = opts.follow ?? "(?=$|[^\\p{L}\\p{N}])";
  return new RegExp(`${lead}(?:${alt})${tail}`, "iu");
}

/** First token of a structured header value: comments "(…)" and ";params" removed, lowercased. */
export function headerToken(v: string): string {
  return (v.replace(/\([^)]*\)/g, " ").split(";")[0] ?? "").trim().toLowerCase();
}

/** A header value that says yes: anything but no / false / 0 / none. */
export function headerTruthy(v: string): boolean {
  return !/^(?:no|false|0|none)$/i.test(headerToken(v));
}

// ───────────────────────── subjects ─────────────────────────

/** Reply/forward prefixes, repeated ("Re: AW: Fwd:"), with optional counters ("Re[2]:"). */
export const REPLY_PREFIX =
  /^(?:\s*(?:re|aw|antw|antwort|sv|vs|odp|r|rif|réf|ref|fw|fwd|wg|tr|rv|doorst|enc)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*)+/iu;

/** The subject without its reply/forward prefixes, whitespace collapsed. */
export function stripReplyPrefixes(s: string): string {
  return flattenMailText(s).replace(REPLY_PREFIX, "").trim();
}

/** Two subjects are the same thread subject once reply prefixes are removed (case-insensitive). */
export function sameSubject(a: string, b: string): boolean {
  return stripReplyPrefixes(a).toLocaleLowerCase("und") === stripReplyPrefixes(b).toLocaleLowerCase("und");
}

/** Research §3.1: out-of-office and auto-reply subjects in eleven languages (the research's list, unchanged). */
const AUTO_SUBJECT_LIST: readonly string[] = [
  // en
  "automatic reply", "auto reply", "auto-reply", "autoreply", "auto response", "auto-response", "automatic response",
  "automated response", "automated reply", "out of office", "out of the office", "out-of-office", "ooo",
  "away from the office", "away from office", "vacation reply", "vacation response",
  // de
  "automatische antwort", "autom. antwort", "automatische rückantwort", "abwesenheitsnotiz", "abwesenheitsmeldung",
  "abwesenheitsnachricht", "abwesenheit", "abwesend", "nicht im büro", "außer haus", "ausser haus",
  // no (bokmål, nynorsk), sv, da
  "automatisk svar", "automatiskt svar", "autosvar", "fraværsmelding", "fråværsmelding", "fravær", "fråvær",
  "fraværsbesked", "frånvaro", "frånvaromeddelande", "ikke på kontoret", "ikkje på kontoret", "inte på kontoret",
  "ej på kontoret",
  // nl
  "automatisch antwoord", "automatisch bericht", "afwezigheidsbericht", "afwezigheidsmelding", "afwezig",
  "niet op kantoor", "buiten kantoor",
  // fr
  "réponse automatique", "reponse automatique", "réponse auto", "message d'absence", "absence du bureau",
  "absent du bureau", "absente du bureau", "hors du bureau", "absence", "absent", "absente",
  // es
  "respuesta automática", "respuesta automatica", "fuera de la oficina", "fuera de oficina", "ausencia", "ausente",
  // it
  "risposta automatica", "risposta non al computer", "fuori sede", "fuori ufficio", "assenza", "assente",
  // pl
  "automatyczna odpowiedź", "odpowiedź automatyczna", "autoodpowiedź", "poza biurem", "nieobecność", "nieobecny", "nieobecna",
];

/** A phrase of more than one word ("automatic reply", "auto-reply", "autom. antwort"). */
const isMultiWord = (p: string) => /[\s\-.']/.test(p);

/** Multi-word auto subjects: the research's list minus the single words. */
export const AUTO_SUBJECT_PHRASES: readonly string[] = AUTO_SUBJECT_LIST.filter(isMultiWord);
/** Single-word auto subjects ("absence", "abwesend", "fravær", "ooo", "autoreply", …). */
export const AUTO_SUBJECT_WORDS: readonly string[] = AUTO_SUBJECT_LIST.filter((p) => !isMultiWord(p));

/** Strong (§3.4 rule 5): a multi-word auto phrase at the start of the subject. */
export const AUTO_SUBJECT_PREFIX = phrases(AUTO_SUBJECT_PHRASES, { anchored: true });
/** A single auto word at the start of the subject, followed by anything (medium on its own). */
export const AUTO_SUBJECT_WORD = phrases(AUTO_SUBJECT_WORDS, { anchored: true });
/**
 * Strong (§3.4 rule 5): a single auto word at the start of the subject followed by ":" (a space before it allowed, as
 * French writes it) or " -". "Abwesend: bis 5.10." is automatic; "Absence of prices on your site" is not.
 */
export const AUTO_SUBJECT_WORD_STRONG = phrases(AUTO_SUBJECT_WORDS, { anchored: true, follow: "(?=\\s*[:：]|\\s+[-–—])" });
/** RFC 5230 §5.3 / RFC 3834 §3.1.5 "Auto: " (strong). */
export const AUTO_COLON_PREFIX = /^\s*auto\s*:/i;
/** Medium: a holiday word anywhere in a subject that isn't ours. */
export const OOF_SUBJECT_WORD = phrases([
  "vacation", "holiday", "holidays", "annual leave", "on leave", "urlaub", "ferien", "ferie", "semester", "vakantie",
  "vacances", "congé", "congés", "vacaciones", "urlop", "permisjon", "elternzeit",
]);
/** Read-receipt subjects (research §4.5); only counted with a null sender or a "Disposition:" line. */
export const READ_RECEIPT_SUBJECT = phrases(
  [
    "read:", "not read:", "gelesen:", "nicht gelesen:", "lest:", "ikke lest:", "läst:", "læst:", "gelezen:", "lu :", "lu:",
    "leído:", "letto:", "przeczytano:", "przeczytana:",
  ],
  { anchored: true },
);

// ───────────────────────── delivery failures ─────────────────────────

/** Delay notices: the other server is still trying. */
export const DELAY_SUBJECT = new RegExp(
  "^\\s*(?:delivery status notification \\(delay\\)|delivery delayed|delayed mail|warning: message \\S+ delayed|" +
    "warning: could not send message|zustellung verzögert|übermittlung verzögert|levering forsinket|leverans försenad|" +
    "vertraagde bezorging|remise différée|entrega retrasada|recapito ritardato|opóźnione doręczenie)",
  "iu",
);
/** Delivery-failure subjects (research §4.3). On their own they are not enough (§3.4 rule 8). */
export const BOUNCE_SUBJECT = phrases(
  [
    "undeliverable", "undelivered mail returned to sender", "undelivered mail", "undelivered message",
    "delivery status notification (failure)", "delivery status notification", "mail delivery failed",
    "mail delivery failure", "delivery failure", "delivery failed", "delivery has failed", "returned mail",
    "failure notice", "message not delivered", "nondeliverable", "non-deliverable", "non-delivery",
    // localised (UNVERIFIED)
    "unzustellbar", "nicht zustellbar", "unzustellbare nachricht", "zustellung fehlgeschlagen",
    "übermittlungsstatusbenachrichtigung (fehler)", "kan ikke leveres", "kunne ikke leveres", "ikke levert",
    "levering mislyktes", "kan inte levereras", "ej levererbart", "olevererbart", "ikke leveret", "levering mislykkedes",
    "onbestelbaar", "niet bezorgd", "bezorging mislukt", "non remis", "message non remis", "échec de la remise",
    "impossible de remettre", "no se puede entregar", "no entregado", "error de entrega", "non recapitabile",
    "mancato recapito", "recapito non riuscito", "niedostarczalne", "nie można dostarczyć", "niedostarczona",
  ],
  { anchored: true },
);
/** Local parts of mail-system senders. */
export const BOUNCE_LOCALPART = /^(?:mailer[-_.]?daemon|postmaster|mail[-_.]?daemon|mdaemon|double[-_]?bounce)$/i;
/** Display names of mail-system senders. */
export const BOUNCE_DISPLAY = /^(?:mail delivery (?:system|subsystem|service)|mail administrator|mailer[- ]daemon|postmaster)$/i;
/** "Action: delayed" in a delivery-status report. */
export const DSN_ACTION_DELAYED = /^\s*action\s*:\s*delayed\b/imu;
const DSN_FIELD_SOURCE =
  "^\\s*(final-recipient|original-recipient|reporting-mta|remote-mta|diagnostic-code|action|status|arrival-date|last-attempt-date)\\s*:";

/** The delivery-status field names found at the start of a line ("final-recipient", "status", …), lowercased. */
export function dsnFieldNames(text: string): Set<string> {
  const re = new RegExp(DSN_FIELD_SOURCE, "gimu");
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[1]!.toLowerCase());
  return out;
}

/** Human explanations in delivery-failure notices. */
export const BOUNCE_PROSE = phrases([
  "delivery has failed to these recipients or groups", "your message wasn't delivered", "your message was not delivered",
  "your message couldn't be delivered", "your message could not be delivered",
  "this message was created automatically by mail delivery software",
  "i'm sorry to have to inform you that your message could not be delivered",
  "could not be delivered to one or more recipients", "delivery to the following recipient failed",
  "delivery to the following recipients failed", "address not found", "unrouteable address",
  "recipient address rejected", "user unknown", "mailbox unavailable", "no such user",
  // localised (UNVERIFIED)
  "die nachricht konnte nicht zugestellt werden", "ihre nachricht konnte nicht zugestellt werden",
  "die zustellung an folgende empfänger oder gruppen ist fehlgeschlagen", "meldingen kunne ikke leveres",
  "meldingen din kunne ikke leveres",
]);
/** "The server is still trying" wording. */
export const DELAY_PROSE = phrases([
  "will continue to try", "still being retried", "delivery is delayed", "delivery has been delayed",
  "has not yet been delivered", "no action is required on your part", "zustellung verzögert",
]);

// ───────────────────────── automatic-reply bodies ─────────────────────────

/** "This is an automatic reply" (strong) in eleven languages. */
export const AUTO_STATEMENT = phrases([
  "this is an automatic reply", "this is an automatic response", "this is an automated reply", "this is an automated response",
  "this is an automated message", "this is an auto-reply", "this is an autoreply", "this message was automatically generated",
  "this is an automatically generated",
  "dies ist eine automatische antwort", "dies ist eine automatisch generierte", "dies ist eine automatisch erstellte",
  "diese nachricht wurde automatisch", "automatisch generierte nachricht", "automatisch erzeugte nachricht",
  "dette er et automatisk svar", "dette er eit automatisk svar", "dette er en automatisk generert",
  "denne e-posten er automatisk generert", "denne meldingen er automatisk generert",
  "detta är ett automatiskt svar", "detta är ett automatiskt genererat", "detta meddelande är automatiskt genererat",
  "denne besked er automatisk genereret", "dette er en automatisk genereret",
  "dit is een automatisch antwoord", "dit is een automatisch gegenereerd", "dit bericht is automatisch gegenereerd",
  "ceci est une réponse automatique", "ceci est un message automatique", "ce message a été généré automatiquement",
  "message généré automatiquement",
  "esta es una respuesta automática", "este es un mensaje automático", "este mensaje ha sido generado automáticamente",
  "mensaje generado automáticamente",
  "questa è una risposta automatica", "questo è un messaggio automatico", "messaggio generato automaticamente",
  "questo messaggio è stato generato automaticamente",
  "to jest automatyczna odpowiedź", "to jest wiadomość automatyczna", "ta wiadomość została wygenerowana automatycznie",
  "wiadomość wygenerowana automatycznie",
]);
/** "I'm away" statements (medium). */
export const ABSENCE = phrases([
  // en
  "i am out of the office", "i'm out of the office", "i am currently out of the office", "i'm currently out of the office",
  "i will be out of the office", "i'll be out of the office", "i am out of office", "i'm out of office", "i am away",
  "i'm away", "i am currently away", "i'm currently away", "i will be away", "i am on vacation", "i'm on vacation",
  "i am on holiday", "i'm on holiday", "i am on annual leave", "i'm on annual leave", "i am on leave", "i'm on leave",
  "i am on parental leave", "i am on maternity leave", "i am currently travelling", "i am currently traveling",
  "i am not in the office", "i'm not in the office", "i am away from the office", "i'm away from the office",
  // de
  "ich bin nicht im büro", "ich bin derzeit nicht im büro", "ich bin zurzeit nicht im büro", "ich bin momentan nicht im büro",
  "ich bin aktuell nicht im büro", "ich bin im urlaub", "ich befinde mich im urlaub", "ich bin abwesend",
  "ich bin derzeit abwesend", "ich bin nicht erreichbar", "ich bin derzeit nicht erreichbar", "ich bin außer haus",
  "ich bin ausser haus", "bin ich nicht im büro", "bin ich nicht erreichbar", "bin ich abwesend", "bin ich im urlaub",
  // no bokmål
  "jeg er ikke på kontoret", "jeg er for tiden ikke på kontoret", "jeg er p.t. ikke på kontoret", "jeg er på ferie",
  "jeg har ferie", "jeg er borte", "jeg er fraværende", "jeg er ute av kontoret", "er jeg ikke på kontoret",
  "er jeg på ferie", "er jeg borte", "er jeg fraværende",
  // no nynorsk
  "eg er ikkje på kontoret", "eg er på ferie", "eg har ferie", "eg er borte", "eg er fråverande",
  "er eg ikkje på kontoret", "er eg på ferie", "er eg borte",
  // sv
  "jag är inte på kontoret", "jag är på semester", "jag har semester", "jag är borta", "jag är ledig",
  "jag är frånvarande", "är jag inte på kontoret", "är jag på semester", "är jag ledig",
  // da
  "jeg holder ferie", "jeg er ikke til stede", "holder jeg ferie",
  // nl
  "ik ben niet op kantoor", "ik ben momenteel niet op kantoor", "ik ben afwezig", "ik ben momenteel afwezig",
  "ik ben met vakantie", "ik ben op vakantie", "ik ben niet aanwezig", "ben ik afwezig", "ben ik niet aanwezig",
  "ben ik met vakantie", "ben ik niet op kantoor",
  // fr
  "je suis absent", "je suis absente", "je suis actuellement absent", "je suis actuellement absente", "je serai absent",
  "je serai absente", "je suis en congé", "je suis en congés", "je suis en vacances", "je suis hors du bureau",
  "je ne suis pas au bureau", "je suis en déplacement",
  // es
  "estoy fuera de la oficina", "me encuentro fuera de la oficina", "estaré fuera de la oficina", "estoy de vacaciones",
  "estaré ausente", "estoy ausente", "me encuentro de vacaciones", "no estoy en la oficina",
  // it
  "sono fuori ufficio", "sono fuori sede", "sono attualmente fuori ufficio", "sarò fuori ufficio", "sarò assente",
  "sono assente", "sono in ferie", "sono in vacanza", "non sono in ufficio",
  // pl
  "jestem poza biurem", "obecnie przebywam poza biurem", "przebywam poza biurem", "jestem na urlopie",
  "przebywam na urlopie", "jestem nieobecny", "jestem nieobecna", "będę nieobecny", "będę nieobecna",
  "nie ma mnie w biurze",
]);
/** Details that go with an absence statement ("for urgent matters", "upon my return"); counted only with one. */
export const ABSENCE_COMPANION = phrases([
  "limited access to email", "limited access to e-mail", "limited access to my email", "for urgent matters",
  "for urgent enquiries", "for urgent inquiries", "in urgent cases", "if your matter is urgent", "upon my return",
  "on my return", "when i return", "returning on", "i will be back", "i'll be back", "back in the office",
  "your email will not be forwarded", "your message will not be forwarded",
  "in dringenden fällen", "bei dringenden anliegen", "in dringenden angelegenheiten", "nach meiner rückkehr",
  "bin ich wieder", "wieder im büro", "wieder erreichbar", "eingeschränkt erreichbar",
  "ihre e-mail wird nicht weitergeleitet", "ihre nachricht wird nicht weitergeleitet",
  "i hastesaker", "ved hastesaker", "når jeg er tilbake", "når eg er tilbake", "tilbake på kontoret",
  "begrenset tilgang til e-post", "avgrensa tilgang til e-post",
  "i brådskande ärenden", "vid brådskande ärenden", "när jag är tillbaka", "tillbaka på kontoret",
  "begränsad tillgång till e-post", "i hastende tilfælde", "i presserende sager", "når jeg er tilbage",
  "tilbage på kontoret", "begrænset adgang til e-mail",
  "voor dringende zaken", "in dringende gevallen", "na mijn terugkomst", "weer aanwezig", "weer op kantoor",
  "beperkt bereikbaar", "uw e-mail wordt niet doorgestuurd",
  "pour toute urgence", "en cas d'urgence", "à mon retour", "de retour le", "je serai de retour",
  "accès limité à mes e-mails", "accès limité à ma messagerie",
  "para asuntos urgentes", "en caso de urgencia", "a mi regreso", "a mi vuelta", "volveré el", "estaré de vuelta",
  "acceso limitado al correo",
  "per urgenze", "in caso di urgenza", "al mio rientro", "rientrerò il", "accesso limitato alla posta",
  "w pilnych sprawach", "w sprawach pilnych", "po moim powrocie", "po powrocie", "ograniczony dostęp do poczty",
]);
/** "No longer with the company" wording (medium; left-company with a strong signal). */
export const LEFT_COMPANY = phrases([
  "no longer with", "no longer works", "no longer employed", "has left the company", "has left the organisation",
  "has left the organization", "this mailbox is no longer monitored", "this email address is no longer in use",
  "this address is no longer monitored",
  "nicht mehr im unternehmen", "nicht mehr bei uns tätig", "nicht mehr für uns tätig", "hat das unternehmen verlassen",
  "dieses postfach wird nicht mehr", "diese e-mail-adresse wird nicht mehr", "diese adresse ist nicht mehr aktiv",
  "har sluttet", "jobber ikke lenger", "er ikke lenger ansatt", "denne e-postadressen er ikke lenger i bruk",
  "eg har slutta", "jobbar ikkje lenger", "har slutat", "arbetar inte längre", "arbejder ikke længere", "er fratrådt",
  "is niet meer werkzaam", "werkt niet meer bij", "is uit dienst", "ne fait plus partie", "a quitté l'entreprise",
  "ya no trabaja", "ha dejado la empresa", "non lavora più", "non fa più parte", "nie pracuje już",
  "nie jest już pracownikiem",
]);

// ───────────────────────── help desks, challenge-response ─────────────────────────

/** `X-Mailer` values of help-desk systems (research §2.8). */
export const HELPDESK_XMAILER = /zendesk|freshdesk|freshservice|help ?scout|zoho ?desk|kayako|osticket|otrs|znuny|zammad|servicenow|hubspot/i;
/** Help-desk header names (only `X-Zendesk-*` is documented). */
export const HELPDESK_HEADER_NAME = /^x-(?:zendesk|freshdesk|helpscout|zammad|otrs|kayako)-/i;
/** A ticket number: "[#5821]", "(#5821)", "#5821", "Ticket 5821", "Anfrage Nr. 5821". */
export const TICKET_ID =
  /(?:\[#?\s?\d{3,}\]|\(#\d{3,}\)|#\d{3,}\b|\b(?:ticket|case|request|anfrage|sak|ärende|sag|zgłoszenie)\s*(?:#|nr\.?|no\.?|number|nummer|numero)?\s*[:#]?\s*\d{3,}\b)/iu;
/** Acknowledgement subjects ("Request received", "Anfrage erhalten"); counted with a ticket number or a [tag]. */
export const ACK_SUBJECT = phrases([
  "request received", "ticket received", "ticket created", "request created", "case created", "we received your",
  "anfrage erhalten", "anfrage eingegangen", "ticket erstellt", "henvendelse mottatt", "sak opprettet",
  "ärende mottaget", "ärende skapat", "henvendelse modtaget", "verzoek ontvangen", "demande reçue",
  "solicitud recibida", "richiesta ricevuta", "zgłoszenie przyjęte",
]);
/** Acknowledgement wording in the first lines ("we have received your…"). */
export const ACK_BODY = phrases([
  "has been received and is being reviewed", "your request has been received", "we have received your",
  "we've received your", "a ticket has been created", "ticket has been created", "your ticket number",
  "wir haben ihre anfrage erhalten", "wir haben ihre nachricht erhalten", "wir haben ihre e-mail erhalten",
  "ihre anfrage ist bei uns eingegangen", "vi har mottatt din henvendelse", "vi har mottatt henvendelsen",
  "vi har mottagit ditt", "vi har modtaget din", "we hebben uw bericht ontvangen", "we hebben je bericht ontvangen",
  "nous avons bien reçu votre", "hemos recibido su", "abbiamo ricevuto la sua", "otrzymaliśmy twoją wiadomość",
  "otrzymaliśmy państwa",
]);
/** Zendesk's default acknowledgement sentence (enough on its own). */
export const ACK_ZENDESK = /has been received and is being reviewed/i;
/** Challenge-response wording ("please confirm you are human"). */
export const CHALLENGE = phrases([
  "confirm you are human", "confirm that you are human", "confirm you're human", "verify you are human",
  "verify that you are human", "prove you are human", "not a robot", "sender verification",
  "please verify your message", "please confirm your message", "your message is being held",
  "your message has been held", "awaiting your confirmation", "awaiting verification", "challenge-response",
  "challenge response", "approved senders list",
  "absenderbestätigung", "absenderverifizierung", "bestätigen sie, dass sie ein mensch sind",
  "bestätigen sie, dass sie kein roboter sind", "bitte bestätigen sie ihre nachricht", "bitte bestätigen sie ihre e-mail",
  "ihre nachricht wurde zurückgehalten", "bekreft at du er et menneske", "avsenderverifisering", "captcha",
]);
/** Local parts of addresses nobody reads ("noreply", "do-not-reply", "mailer"). */
export const NOREPLY_LOCALPART = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|autoresponder|auto[-_.]?reply|mailer)$/i;
/** A web link. */
export const URL_RE = /https?:\/\/\S+/i;
