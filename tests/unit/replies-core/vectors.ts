import type { AutoReason, ClassifyInput, Nature } from "@/core/replies/types";

/**
 * The research's test vectors (docs/dev/research/replies-and-auto-replies.md Appendix B), ported unchanged, with the
 * `linked` flag taken from each vector's "Kind after linking" column (M4-DESIGN §3.4 rule 14). `nature`/`reason` are
 * the expectations under the M4 rules: V08 and V21 are linked without a strong signal, so they become POSSIBLE
 * (rule 3); every other vector keeps the research's answer.
 */

export const A = "pp.4f1c9a0b7e2d4c6a8b0e1f23@send.polygonparadise.com";
export const O = "pp.9a8b7c6d5e4f3a2b1c0d9e8f@send.polygonparadise.com";
export const SA = "3D models for your shop";
export const SO = "3D-modeller til butikken deres";

export type Vector = {
  id: string;
  in: ClassifyInput;
  nature: Nature;
  /** Expected autoReason; undefined = not checked (the research gives none). */
  reason?: AutoReason | null;
  /** Expected firstLines(extractNewText(stripped, body)). */
  first?: string;
  /** The research's nature before rule 3, when M4 changes it. */
  researchNature?: Nature;
};

const thread = (id: string): [string, string][] => [
  ["In-Reply-To", `<${id}>`],
  ["References", `<${id}>`],
];

export const vectors: Vector[] = [
  { id: "V01 Gmail human reply", nature: "REPLY", reason: null, first: "Hi Ali, sounds interesting. Could you send prices for 10 busts?",
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [["From", "Anna Berg <anna@firma.de>"], ...thread(A), ["Content-Type", "multipart/alternative; boundary=\"000000000000abc\""]],
      strippedText: null,
      bodyPlain: "Hi Ali,\nsounds interesting. Could you send prices for 10 busts?\n\nBest, Anna\n\nOn Mon, Sep 21, 2026 at 10:15 AM Ali Khan <\nali@send.polygonparadise.com> wrote:\n\n> Hi Anna,\n> I make print-ready 3D models...\n" } },
  { id: "V02 Outlook human reply (de)", nature: "REPLY", reason: null, first: "Hallo Ali, ja, gerne. Schicken Sie mir bitte ein Angebot.",
    in: { linked: true, subject: `AW: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["Thread-Topic", SA], ["Thread-Index", "AQHbK3r1abcdEFGH"], ["Content-Language", "de-DE"]],
      bodyPlain: "Hallo Ali,\n\nja, gerne. Schicken Sie mir bitte ein Angebot.\n\nViele Grüße\nAnna Berg\n\nVon: Ali Khan <ali@send.polygonparadise.com>\nGesendet: Montag, 21. September 2026 10:15\nAn: Anna Berg <anna@firma.de>\nBetreff: 3D models for your shop\n\nHi Anna, ..." } },
  { id: "V03 Microsoft 365 OOF (en)", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: `Automatic reply: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"], ["Thread-Topic", SA]],
      strippedText: "I am out of the office until 5 October with limited access to email." } },
  { id: "V04 Outlook OOF (de)", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: `Automatische Antwort: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"]],
      strippedText: "Vielen Dank für Ihre Nachricht. Ich bin bis einschließlich 2. Oktober nicht im Büro. In dringenden Fällen wenden Sie sich bitte an info@firma.de." } },
  { id: "V05 Outlook OOF (nb)", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: `Automatisk svar: ${SO}`, fromEmail: "ole@butikk.no", envelopeSender: "", sentSubjects: [SO],
      headers: [["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"]],
      strippedText: "Takk for e-posten. Jeg er på ferie til og med 12. oktober og har begrenset tilgang til e-post." } },
  { id: "V06 Gmail vacation, own subject (nb)", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: "Ferie", fromEmail: "ole@butikk.no", envelopeSender: "ole@butikk.no", sentSubjects: [SO],
      headers: [...thread(O), ["Auto-Submitted", "auto-replied"], ["X-Autoreply", "yes"]],
      strippedText: "Hei! Jeg er på ferie til 12. oktober. Når jeg er tilbake svarer jeg deg." } },
  { id: "V07 Sieve vacation (RFC 5230)", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: `Auto: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "<>", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "auto-replied"]], strippedText: "I'm away until Monday." } },
  { id: "V08 German webmail OOF, no headers", nature: "POSSIBLE", researchNature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "info@shop-beispiel.de", envelopeSender: "info@shop-beispiel.de", sentSubjects: [SA],
      headers: [], strippedText: "Vielen Dank für Ihre Nachricht.\nVom 20.09. bis 04.10. bin ich im Urlaub. Ihre E-Mail wird nicht weitergeleitet. Ab dem 05.10. bin ich wieder erreichbar." } },
  { id: "V09 Human mentions absence", nature: "POSSIBLE", reason: "out-of-office",
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: thread(A), strippedText: "Hi Ali, I'm out of the office this week, but yes, we're interested. Please call me on Monday." } },
  { id: "V10 Zendesk acknowledgement", nature: "AUTO", reason: "helpdesk-ack",
    in: { linked: false, subject: `[Firma Support] ${SA}`, fromEmail: "support@firma.de", envelopeSender: "bounce@zendesk.example", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"], ["X-Mailer", "Zendesk Mailer"], ["X-Zendesk-Email-Id", "01J8ZK0000000000"]],
      strippedText: "Your request (48213) has been received and is being reviewed by our support staff.\n\nTo add additional comments, reply to this email." } },
  { id: "V11 Zendesk agent (human) reply", nature: "POSSIBLE", reason: "auto-reply",
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "support@firma.de", envelopeSender: "bounce@zendesk.example", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "auto-generated"], ["X-Auto-Response-Suppress", "All"], ["X-Mailer", "Zendesk Mailer"]],
      strippedText: "Hi Ali, thanks. Our product lead Jonas would like to see samples of your busts." } },
  { id: "V12 Freshdesk-style acknowledgement", nature: "AUTO", reason: "helpdesk-ack",
    in: { linked: false, subject: `Ticket Received - ${SA} - [#5821]`, fromEmail: "help@firma.de", envelopeSender: "help@firma.de", sentSubjects: [SA],
      headers: [], strippedText: "Thank you for contacting us. A ticket has been created (#5821) and we will get back to you shortly." } },
  { id: "V13 Gmail DSN (multipart/report)", nature: "BOUNCE", reason: "dsn",
    in: { linked: true, subject: "Delivery Status Notification (Failure)", fromEmail: "mailer-daemon@googlemail.com", fromName: "Mail Delivery Subsystem", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"000000000000f00\""], ["Auto-Submitted", "auto-replied"]],
      bodyPlain: "** Address not found **\n\nYour message wasn't delivered to anna@firma.de because the address couldn't be found, or is unable to receive mail." } },
  { id: "V14 Exchange Online NDR", nature: "BOUNCE", reason: "dsn",
    in: { linked: true, subject: `Undeliverable: ${SA}`, fromEmail: "postmaster@firma.onmicrosoft.com", fromName: "Microsoft Outlook", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"_000_\""], ["Auto-Submitted", "auto-replied"]],
      bodyPlain: "Delivery has failed to these recipients or groups:\n\nanna@firma.de\nThe email address you entered couldn't be found.\n\nDiagnostic information for administrators:\n\nGenerating server: AM0PR01MB0000.eurprd01.prod.outlook.com\n\nanna@firma.de\nRemote Server returned '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'\n\nOriginal message headers:\n\nMessage-ID: <" + A + ">" } },
  { id: "V15 Exim bounce with Auto-Submitted (order test)", nature: "BOUNCE", reason: "dsn",
    in: { linked: true, subject: "Mail delivery failed: returning message to sender", fromEmail: "mailer-daemon@mx.hoster.de", fromName: "Mail Delivery System", envelopeSender: "",
      headers: [["Auto-Submitted", "auto-generated"], ["X-Failed-Recipients", "anna@firma.de"], ["Content-Type", "text/plain; charset=utf-8"]],
      bodyPlain: "This message was created automatically by mail delivery software.\n\nA message that you sent could not be delivered to one or more of its recipients. This is a permanent error. The following address(es) failed:\n\n  anna@firma.de\n    Unrouteable address" } },
  { id: "V16 Postfix bounce", nature: "BOUNCE", reason: "dsn",
    in: { linked: false, subject: "Undelivered Mail Returned to Sender", fromEmail: "mailer-daemon@mail.firma.de", fromName: "Mail Delivery System", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"8E1F2\""]],
      bodyPlain: "This is the mail system at host mail.firma.de.\n\nI'm sorry to have to inform you that your message could not\nbe delivered to one or more recipients." } },
  { id: "V17 German NDR, text only, no report", nature: "BOUNCE", reason: "dsn",
    in: { linked: true, subject: `Unzustellbar: ${SA}`, fromEmail: "postmaster@firma.de", envelopeSender: "",
      headers: [["Content-Type", "text/plain; charset=iso-8859-1"]],
      bodyPlain: "Ihre Nachricht konnte nicht zugestellt werden an:\n\nanna@firma.de\nDas Postfach existiert nicht." } },
  { id: "V18 Delay DSN", nature: "BOUNCE", reason: "delay",
    in: { linked: true, subject: "Delivery Status Notification (Delay)", fromEmail: "mailer-daemon@googlemail.com", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=delivery-status; boundary=\"b1\""]],
      bodyPlain: "** Message not delivered yet **\n\nFinal-Recipient: rfc822; anna@firma.de\nAction: delayed\nStatus: 4.4.1\nWill continue to try." } },
  { id: "V19 Read receipt (MDN)", nature: "AUTO", reason: "read-receipt",
    in: { linked: true, subject: `Gelesen: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "",
      headers: [["Content-Type", "multipart/report; report-type=disposition-notification; boundary=\"mdn\""]],
      bodyPlain: "Ihre Nachricht wurde am 22.09.2026 09:02 gelesen." } },
  { id: "V20 Challenge-response (en)", nature: "AUTO", reason: "challenge",
    in: { linked: true, subject: "Please confirm your message to anna@firma.de", fromEmail: "verify@mailguard.example", envelopeSender: "",
      headers: [["Auto-Submitted", "auto-replied"]],
      strippedText: "I use a challenge-response system to block spam. To confirm you are human, click the link below:\nhttps://mailguard.example/c/8f2" } },
  { id: "V21 Challenge-response (de), no headers", nature: "POSSIBLE", researchNature: "AUTO", reason: "challenge",
    in: { linked: true, subject: "Bitte bestätigen Sie Ihre E-Mail an info@firma.de", fromEmail: "noreply@spamschutz.example", envelopeSender: "noreply@spamschutz.example",
      headers: [], strippedText: "Ihre Nachricht wurde zurückgehalten. Bitte bestätigen Sie, dass Sie kein Roboter sind: https://spamschutz.example/v/1" } },
  { id: "V22 Colleague reply (different address, headers)", nature: "REPLY", reason: null,
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "jonas@firma.de", envelopeSender: "jonas@firma.de", sentSubjects: [SA],
      headers: [["In-Reply-To", "<CAFwd123@mail.gmail.com>"], ["References", `<${A}> <CAFwd123@mail.gmail.com>`]],
      strippedText: "Hi Ali, Anna forwarded me your email. We're interested in a set of dragon busts." } },
  { id: "V23 Colleague new email, no headers", nature: "REPLY", reason: null,
    in: { linked: false, subject: "Your 3D offer", fromEmail: "jonas@firma.de", envelopeSender: "jonas@firma.de",
      headers: [], strippedText: "Hi, my colleague Anna showed me your email. Do you also do busts?" } },
  { id: "V24 Known person, new email, no headers", nature: "REPLY", reason: null,
    in: { linked: true, subject: "Question", fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", headers: [], strippedText: "Do you also make figurines?" } },
  { id: "V25 Reply to catch-all / retired address", nature: "REPLY", reason: null, first: "Hei Ali, ja takk, send gjerne priser.",
    in: { linked: true, subject: `SV: ${SO}`, fromEmail: "ole@butikk.no", envelopeSender: "ole@butikk.no", sentSubjects: [SO],
      headers: thread(O), bodyPlain: "Hei Ali,\nja takk, send gjerne priser.\n\nDen man. 21. sep. 2026 kl. 10:15 skrev Ali Khan <ali@send.polygonparadise.com>:\n> Hei Ole," } },
  { id: "V26 Recovered from Logs, no text", nature: "POSSIBLE", reason: null,
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "anna@firma.de", headers: [["Message-Id", "<x@firma.de>"]], bodyAvailable: false, sentSubjects: [SA] } },
  { id: "V27 Recovered from Logs, auto subject", nature: "POSSIBLE", reason: "out-of-office",
    in: { linked: true, subject: `Automatic reply: ${SA}`, fromEmail: "anna@firma.de", headers: [], bodyAvailable: false, sentSubjects: [SA] } },
  { id: "V28 Human reply with Auto-Submitted: no", nature: "REPLY", reason: null,
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["Auto-Submitted", "no"]], strippedText: "Yes please, send the catalogue." } },
  { id: "V29 Outlook human reply with XARS RN, NRN", nature: "REPLY", reason: null,
    in: { linked: true, subject: `RE: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["X-Auto-Response-Suppress", "RN, NRN"]], strippedText: "Thanks Ali, what are your rates?" } },
  { id: "V30 Human text with only XARS All", nature: "POSSIBLE", reason: "auto-reply",
    in: { linked: true, subject: `RE: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: [...thread(A), ["X-Auto-Response-Suppress", "All"]], strippedText: "Thanks Ali, what are your rates?" } },
  { id: "V31 CRM autoresponder (bulk + list + noreply)", nature: "AUTO", reason: "auto-reply",
    in: { linked: false, subject: "Thanks for contacting Firma!", fromEmail: "noreply@firma.de", envelopeSender: "bounces@crm.example",
      headers: [["Precedence", "bulk"], ["List-Unsubscribe", "<https://crm.example/u/1>"]],
      strippedText: "We received your message and will get back to you within 48 hours." } },
  { id: "V32 French OOF with X-Autoreply", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: `Réponse automatique : ${SA}`, fromEmail: "claire@boutique.fr", envelopeSender: "claire@boutique.fr", sentSubjects: [SA],
      headers: [["X-Autoreply", "yes"]], strippedText: "Je suis absente du bureau jusqu'au 5 octobre. Pour toute urgence, contactez contact@boutique.fr." } },
  { id: "V33 Spanish OOF, subject only", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: "Fuera de la oficina", fromEmail: "luis@tienda.es", envelopeSender: "luis@tienda.es", sentSubjects: [SA],
      headers: [], strippedText: "Estoy fuera de la oficina hasta el 10 de octubre. Para asuntos urgentes, contacte con info@tienda.es." } },
  { id: "V34 Polish OOF", nature: "AUTO", reason: "out-of-office",
    in: { linked: true, subject: `Automatyczna odpowiedź: ${SA}`, fromEmail: "jan@sklep.pl", envelopeSender: "", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"]], strippedText: "Jestem na urlopie do 3 października. W pilnych sprawach proszę pisać na biuro@sklep.pl." } },
  { id: "V35 Dutch human reply (Gmail nl)", nature: "REPLY", reason: null, first: "Ja graag, stuur de prijzen.",
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "pieter@winkel.nl", envelopeSender: "pieter@winkel.nl", sentSubjects: [SA],
      headers: thread(A), bodyPlain: "Ja graag, stuur de prijzen.\n\nOp ma 21 sep 2026 om 10:15 schreef Ali Khan <ali@send.polygonparadise.com>:\n\n> Hoi Pieter," } },
  { id: "V36 Nynorsk OOF, own subject, no headers", nature: "AUTO", reason: "out-of-office",
    in: { linked: false, subject: "Fråværsmelding", fromEmail: "kari@butikk.no", envelopeSender: "kari@butikk.no", sentSubjects: [SO],
      headers: [], strippedText: "Eg er ikkje på kontoret før 14. oktober." } },
  { id: "V37 Human subject mentions holiday", nature: "POSSIBLE", reason: "auto-reply",
    in: { linked: true, subject: "Before our holiday - yes, interested!", fromEmail: "anna@firma.de", envelopeSender: "anna@firma.de", sentSubjects: [SA],
      headers: thread(A), strippedText: "Yes please send details before Friday." } },
  { id: "V38 Left the company (auto)", nature: "AUTO", reason: "left-company",
    in: { linked: true, subject: `Automatic reply: ${SA}`, fromEmail: "anna@firma.de", envelopeSender: "", sentSubjects: [SA],
      headers: [["Auto-Submitted", "auto-generated"]], strippedText: "Anna Berg is no longer with Firma GmbH. Please contact info@firma.de." } },
  { id: "V39 Successor writes (human, left-company words)", nature: "POSSIBLE", reason: "left-company",
    in: { linked: true, subject: `Re: ${SA}`, fromEmail: "jonas@firma.de", envelopeSender: "jonas@firma.de", sentSubjects: [SA],
      headers: thread(A), strippedText: "Hi Ali, Anna is no longer with us - I took over purchasing and would like a quote." } },
  { id: "V40 Swedish human reply, Outlook header block", nature: "REPLY", reason: null, first: "Hej Ali! Låter bra, skicka gärna en offert.",
    in: { linked: true, subject: `SV: ${SA}`, fromEmail: "erik@butik.se", envelopeSender: "erik@butik.se", sentSubjects: [SA],
      headers: thread(A), bodyPlain: "Hej Ali!\nLåter bra, skicka gärna en offert.\n\nSkickat från min iPhone\n\nFrån: Ali Khan <ali@send.polygonparadise.com>\nSkickat: den 21 september 2026 10:15\nTill: Erik <erik@butik.se>\nÄmne: 3D models for your shop" } },
];

/** The research's quote-stripping vectors: body-plain in, expected firstLines(extractNewText(null, body)) out. */
export const quoteVectors: Array<[string, string, string]> = [
  ["Q01 Gmail fr", "Oui, merci !\n\nLe lun. 21 sept. 2026 à 10:15, Ali Khan <ali@send.polygonparadise.com> a écrit :\n> Bonjour Claire,", "Oui, merci !"],
  ["Q02 Gmail pl", "Tak, proszę o cennik.\n\npon., 21 wrz 2026 o 10:15 Ali Khan <ali@send.polygonparadise.com> napisał(a):\n> Dzień dobry,", "Tak, proszę o cennik."],
  ["Q03 Gmail es wrapped", "Sí, envíeme precios.\n\nEl lun, 21 sept 2026 a las 10:15, Ali Khan (<\nali@send.polygonparadise.com>) escribió:\n> Hola Luis,", "Sí, envíeme precios."],
  ["Q04 Gmail it", "Sì, grazie.\n\nIl giorno lun 21 set 2026 alle ore 10:15 Ali Khan <ali@send.polygonparadise.com> ha scritto:\n> Buongiorno,", "Sì, grazie."],
  ["Q05 Thunderbird nb", "Ja takk.\n\nDen 21.09.2026 10:15, skrev Ali Khan:\n> Hei Ole,", "Ja takk."],
  ["Q06 Apple Mail de", "Gerne!\n\nVon meinem iPhone gesendet\n\n> Am 21.09.2026 um 10:15 schrieb Ali Khan <ali@send.polygonparadise.com>:\n>\n> Hallo Anna,", "Gerne!"],
  ["Q07 Outlook fr block", "Bonjour Ali,\nMerci, envoyez le catalogue.\n\nDe : Ali Khan <ali@send.polygonparadise.com>\nEnvoyé : lundi 21 septembre 2026 10:15\nÀ : Claire <claire@boutique.fr>\nObjet : 3D models for your shop", "Bonjour Ali, Merci, envoyez le catalogue."],
  ["Q08 Outlook classic en", "Please call me.\n\n-----Original Message-----\nFrom: Ali Khan [mailto:ali@send.polygonparadise.com]\nSent: Monday, September 21, 2026 10:15 AM", "Please call me."],
  ["Q09 Outlook classic de", "Bitte anrufen.\n\n-----Ursprüngliche Nachricht-----\nVon: Ali Khan\nGesendet: Montag, 21. September 2026 10:15", "Bitte anrufen."],
  ["Q10 Outlook web underscores (nb)", "Hei, send gjerne priser.\n\n________________________________\nFra: Ali Khan <ali@send.polygonparadise.com>\nSendt: mandag 21. september 2026 10:15\nTil: Ole <ole@butikk.no>\nEmne: 3D-modeller til butikken deres", "Hei, send gjerne priser."],
  ["Q11 Bottom-posted", "On Mon, Sep 21, 2026 at 10:15 AM Ali Khan <ali@send.polygonparadise.com> wrote:\n> Hi Anna,\n> would you like samples?\n\nYes, please send two.", "Yes, please send two."],
  ["Q12 Gmail forward with comment", "Jonas, see below - interesting?\n\n---------- Forwarded message ---------\nFrom: Ali Khan <ali@send.polygonparadise.com>\nDate: Mon, Sep 21, 2026 at 10:15 AM", "Jonas, see below - interesting?"],
  ["Q13 Gmail de forward", "Schau mal.\n\n---------- Weitergeleitete Nachricht ---------\nVon: Ali Khan <ali@send.polygonparadise.com>\nDate: Mo., 21. Sept. 2026 um 10:15 Uhr", "Schau mal."],
  ["Q14 Signature dash-dash", "Sounds good.\n-- \nAnna Berg | Firma GmbH | +49 30 1234567", "Sounds good."],
  ["Q15 Human 'wrote' in text is kept", "My colleague wrote: we need 20 pieces.\nCan you do that?", "My colleague wrote: we need 20 pieces. Can you do that?"],
];

/** A vector by its number ("V03"). */
export function vector(id: string): Vector {
  const v = vectors.find((x) => x.id.startsWith(`${id} `));
  if (!v) throw new Error(`No vector ${id}`);
  return v;
}
