import { cleanMailText } from "./phrases";

/**
 * The new text of a reply and its "first lines" (research replies-and-auto-replies §7, M4-DESIGN §3.10). Mailgun's
 * stripped-text is used when present; otherwise our own cut of body-plain: at the first attribution line ("On … wrote:"
 * in eleven languages), "Original Message" or forward separator, or Outlook header block. Quoted "> " lines go, and the
 * text stops at a "-- " signature or a mobile footer ("Sent from my iPhone"). Pure and browser-safe.
 */

/** Only this much of a message is read (the stored body-plain is at most 16,000 characters). */
export const NEW_TEXT_SOURCE_MAX = 16_000;

const WROTE = "(?:wrote|schrieb|skrev|a écrit|escribió|escribio|ha scritto|schreef|napisał\\(a\\)|napisała|napisał|escreveu)";
/** Attribution line ("On … wrote:", "Am … schrieb …:", "Den … skrev …:", "… napisał(a):"); tested on 1–3 joined lines. */
export const RE_ATTRIBUTION = new RegExp(`^(?!\\s*>)(?=.*[\\d@]).{0,300}?(?:^|[\\s,])${WROTE}(?:\\s.{0,160})?\\s?:\\s*$`, "iu");
/**
 * An attribution starts with a lead word ("On", "Am", "Den", "Le", "El", "Il giorno", "Op", "W dniu", "På"), a short
 * weekday ("man.", "pon.,") followed by a digit, or a digit (Apple Mail nb: "21. sep. 2026 kl. 10:15 skrev …").
 */
export const RE_ATTRIBUTION_START = /^\s*(?:(?:on|am|den|le|el|il giorno|il|op|w dniu|dnia|på|em)\s|\p{L}{2,5}\.?,?\s+\d|\d)/iu;
/** "-----Original Message-----" in eleven languages. */
export const RE_ORIGINAL =
  /^\s*-{2,}\s*(?:original message|ursprüngliche nachricht|originalnachricht|opprinnelig melding|opprinneleg melding|originalmelding|ursprungligt meddelande|oprindelig meddelelse|oorspronkelijk bericht|message d'origine|message original|mensaje original|messaggio originale|oryginalna wiadomość|wiadomość oryginalna)\s*-{2,}\s*$/iu;
/** "---------- Forwarded message ---------" in eleven languages. */
export const RE_FORWARD =
  /^\s*-{2,}\s*(?:forwarded message|weitergeleitete nachricht|videresendt melding|vidaresendt melding|vidarebefordrat meddelande|videresendt meddelelse|doorgestuurd bericht|message transféré|mensaje reenviado|messaggio inoltrato|wiadomość przekazana dalej|przekazana wiadomość)\s*-{2,}\s*$/iu;
/** Apple Mail's "Begin forwarded message:". */
export const RE_APPLE_FORWARD =
  /^\s*(?:begin forwarded message|anfang der weitergeleiteten nachricht|start på videresendt melding|början på vidarebefordrat meddelande|start på videresendt besked|begin doorgestuurd bericht|début du message réexpédié|inicio del mensaje reenviado|inizio messaggio inoltrato|początek przekazanej wiadomości)\s*:\s*$/iu;
const HDR = (words: string) => new RegExp(`^\\s*\\*?(?:${words})\\*?\\s?:\\s?\\*?`, "iu");
/** The "From:" line of an Outlook header block. */
export const RE_HDR_FROM = HDR("from|von|fra|från|van|de|da|od");
/** The "Sent:" / "Date:" line of an Outlook header block. */
export const RE_HDR_SENT = HDR("sent|date|gesendet|datum|sendt|dato|skickat|verzonden|envoyé|enviado|fecha|inviato|data|wysłano|wysłane");
/** The "To:" / "Cc:" line of an Outlook header block. */
export const RE_HDR_TO = HDR("to|an|til|till|aan|à|a|para|do|cc|kopie|kopi|kopia");
/** The "Subject:" line of an Outlook header block. */
export const RE_HDR_SUBJECT = HDR("subject|betreff|emne|ämne|onderwerp|objet|asunto|oggetto|temat");
/** Outlook web's "________________" line before the header block. */
export const RE_UNDERSCORES = /^\s*_{10,}\s*$/;
/** RFC 3676 §4.3 signature separator "-- ". */
export const RE_SIG = /^-- ?$/;
/** Mobile footers ("Sent from my iPhone", "Von meinem iPhone gesendet", …). */
export const RE_MOBILE =
  /^\s*(?:sent from my (?:iphone|ipad|android|mobile|phone|samsung\b.*)|sent from outlook for (?:ios|android)|get outlook for (?:ios|android)|von meinem (?:iphone|ipad|smartphone|samsung\b.*) gesendet|gesendet von (?:meinem )?(?:iphone|ipad|outlook für (?:ios|android))|sendt fra (?:min |mi )?(?:iphone|ipad|samsung\b.*|outlook for (?:ios|android))|skickat från min (?:iphone|ipad)|verzonden vanaf mijn (?:iphone|ipad)|envoyé de mon (?:iphone|ipad)|enviado desde mi (?:iphone|ipad)|inviato da (?:iphone|ipad|il mio iphone)|wysłane z (?:iphone'?a|mojego iphone'?a))\s*$/iu;
/** A sign-off line, optionally followed by one name ("Best, Anna"). Never applied to the first line. */
export const RE_SIGNOFF =
  /^(?:best|best regards|kind regards|regards|many thanks|thanks|thank you|cheers|br|mvh|med vennlig hilsen|vennlig hilsen|venleg helsing|hilsen|viele grüße|beste grüße|liebe grüße|mit freundlichen grüßen|freundliche grüße|lg|vg|mfg|med venlig hilsen|venlig hilsen|med vänliga hälsningar|vänliga hälsningar|hälsningar|mvh|met vriendelijke groet|vriendelijke groet|groeten|cordialement|bien à vous|bien cordialement|saludos|un saludo|atentamente|cordiali saluti|saluti|pozdrawiam|z poważaniem)[\s,.!]*(?:\p{L}+[.!]?)?\s*$/iu;

/** Returns the index of the first line that starts quoted or forwarded material, or -1. */
export function findCut(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (RE_ORIGINAL.test(l) || RE_FORWARD.test(l) || RE_APPLE_FORWARD.test(l)) return i;
    if (RE_ATTRIBUTION_START.test(l)) {
      for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
        const win = lines.slice(i, i + span);
        if (win.some((w) => !w.trim())) break; // wrapped attributions are contiguous lines
        if (RE_ATTRIBUTION.test(win.join(" "))) return i;
      }
    }
    const from = RE_HDR_FROM.test(l) ? i : RE_UNDERSCORES.test(l) && RE_HDR_FROM.test(lines[i + 1] ?? "") ? i + 1 : -1;
    if (from >= 0) {
      const next = lines.slice(from + 1, from + 5);
      const hits = [RE_HDR_SENT, RE_HDR_TO, RE_HDR_SUBJECT].filter((re) => next.some((n) => re.test(n))).length;
      if (hits >= 2) return i;
    }
  }
  return -1;
}

/**
 * The new text of a reply: Mailgun's stripped-text when it has any text, else our own cut of body-plain. Quoted lines
 * are dropped; bottom-posted replies (nothing above the cut) keep the text below it; the text ends at a signature
 * separator or a mobile footer. Newlines are kept, runs of blank lines become one. "" when there is no text.
 */
export function extractNewText(strippedText: string | null | undefined, bodyPlain: string | null | undefined): string {
  const src = strippedText && strippedText.trim() ? strippedText : (bodyPlain ?? "");
  let lines = cleanMailText(src.slice(0, NEW_TEXT_SOURCE_MAX)).replace(/\r\n?/g, "\n").split("\n");
  const cut = findCut(lines);
  const quoted = (l: string) => /^\s*>/.test(l);
  let head = cut >= 0 ? lines.slice(0, cut) : lines;
  if (cut >= 0 && !head.some((l) => l.trim() && !quoted(l))) head = lines.slice(cut + 1); // bottom-posting
  lines = head.filter((l) => !quoted(l));
  const end = lines.findIndex((l) => RE_SIG.test(l) || RE_MOBILE.test(l));
  if (end >= 0) lines = lines.slice(0, end);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A first line that is only a greeting ("Hi Ali,", "Dear Mr. Khan,", "Hallo Anna!", "Hei Ole,", "Bonjour Ali,"): a
 * greeting word and at most three name words, nothing else.
 */
export const RE_GREETING_ONLY =
  /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening|day)|hallo|hej|hei|moin|servus|liebe|lieber|sehr geehrte[rs]?|guten (?:tag|morgen|abend)|bonjour|salut|hola|buenos días|buenas tardes|buongiorno|ciao|salve|gentile|dzień dobry|witam|goedemorgen|goedemiddag|goedendag|beste|god morgen|god dag)(?:\s+[\p{L}.'’-]+){0,3}\s*[,!:]?$/iu;
/** Sign-offs that are also a plain thanks ("Thanks!", "Thank you Ali."): they can start a reply as well as end it. */
export const RE_THANKS_LINE = /^(?:many thanks|thanks|thank you|cheers)\b/iu;

/** A line with something to say: a question, or a sentence of three words or more ("Please send the catalogue."). */
function isSentence(line: string): boolean {
  if (RE_SIGNOFF.test(line)) return false;
  return /\?\s*$/u.test(line) || (/[.!]\s*$/u.test(line) && line.split(/\s+/).length >= 3);
}

/**
 * Whether the sign-off at `i` (never the first line) ends the text. Not when only a greeting comes before it ("Hi Ali,
 * / Thanks! / We want 20 pieces…": the thanks is part of the message), and not for a plain thanks that more sentences
 * follow ("Great. / Thanks! / Can you send prices?"): then the text goes on to the next sign-off, if any.
 */
function endsAt(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  if (i === 0 || !RE_SIGNOFF.test(line)) return false;
  if (i === 1 && RE_GREETING_ONLY.test(lines[0]!)) return false;
  if (RE_THANKS_LINE.test(line) && lines.slice(i + 1).some(isSentence)) return false;
  return true;
}

/**
 * The "first lines" shown on the timeline and the waiting-list card (M4-DESIGN §3.10): up to `maxLines` non-empty
 * lines joined with spaces, stopping at a sign-off line after the first ("Best, Anna"), at most `maxChars` characters
 * (cut with "…"). A short thanks right after the greeting, or followed by more of the message, is kept (`endsAt`), so
 * "Hi Ali, / Thanks! / We want 20 pieces." shows the whole message, not only "Hi Ali,".
 */
export function firstLines(newText: string, maxLines = 3, maxChars = 300): string {
  const lines = (newText ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const stop = lines.findIndex((_l, i) => endsAt(lines, i));
  const out = (stop > 0 ? lines.slice(0, stop) : lines).slice(0, maxLines).join(" ");
  return out.length > maxChars ? out.slice(0, maxChars - 1).trimEnd() + "…" : out;
}
