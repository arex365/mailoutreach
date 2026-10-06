/**
 * Test fixture (SHARED-FROM-DESIGN §7.8): the full source of one reply-test email as a test mailbox shows it (Gmail
 * "Show original", Outlook.com "View message source"), for the pasted-original tests (`parseTestOriginal`,
 * `parseDmarcResult`, `saveReplyTestOriginal`, the end-to-end test). Shaped like the real thing: folded
 * Authentication-Results (Gmail: 7-space continuation lines and `header.i=@d`; Outlook.com: 1-space continuations,
 * `header.d=d`, `smtp.mailfrom=<domain only>`, `dmarc=… action=…`, and its Return-Path far below the message headers),
 * a DKIM-Signature, List-Unsubscribe, From, Reply-To, Message-Id and a short body with the footer.
 *
 *   testOriginal({ from: "Arslan from Polygon Paradise <contact@example.com>", messageId: sent.messageId, provider: "gmail" })
 *
 * Every address is on example.com / *.example or the given ones; nothing here is real mail.
 */

export type TestOriginalOptions = {
  /** The From line as sent, e.g. "Arslan from Polygon Paradise <contact@example.com>" (a bare address works too). */
  from: string;
  /** Our Message-ID (angle brackets optional), e.g. "pp.1a2b3c@send.example.com"; its domain is the sending domain. */
  messageId: string;
  /** "gmail" (default) or "outlook": which mailbox's "show original" shape. */
  provider?: "gmail" | "outlook";
  /**
   * The envelope sender (Return-Path and SPF's smtp.mailfrom). Default `bounce+…@<the Message-ID's domain>` (Mailgun's
   * shape). null = neither a Return-Path header nor an SPF result.
   */
  returnPath?: string | null;
  /** false: no Return-Path header, but the SPF result's smtp.mailfrom still shows the envelope sender (default true). */
  returnPathHeader?: boolean;
  /** The receiving mailbox's DMARC result for the From domain; null leaves it out. Default "pass". */
  dmarc?: "pass" | "fail" | "none" | "bestguesspass" | "temperror" | "permerror" | null;
  /** The DKIM signer (d=). Default: the From address's domain. null = the email carries no signature. */
  dkimD?: string | null;
  /** The receiving mailbox's result for that signature (default "pass"). */
  dkim?: "pass" | "fail" | "neutral" | "permerror";
  /**
   * The whole List-Unsubscribe value; null = no header. Default: a mailto on the Message-ID's domain
   * (`u+…@send.example.com`) and an https link on its tracking host.
   */
  listUnsubscribe?: string | null;
  /** The test mailbox (To:). Default tess@gmail.com (gmail) / tess@outlook.com (outlook). */
  to?: string;
  /** The Reply-To header (shared-From mode: the sender's own address); null or absent = none. */
  replyTo?: string | null;
  /** Header lines put at the very top (newest first), e.g. an extra hop's Authentication-Results. */
  extraHeaders?: Array<[string, string]>;
  /** Default Sun, 27 Sep 2026 17:00:02 UTC. */
  date?: Date;
  /** "\r\n" for a CRLF paste; default "\n". */
  newline?: "\n" | "\r\n";
};

const MAILGUN_IP = "159.135.228.4";
const MAILGUN_HOST = "m228-4.mailgun.net";

function bare(v: string): string {
  const m = /<([^<>]+)>\s*$/.exec(v);
  return (m ? m[1]! : v).trim();
}

function domainOf(address: string): string {
  const b = bare(address);
  return b.slice(b.lastIndexOf("@") + 1).toLowerCase();
}

/** RFC 5322 date, e.g. "Sun, 27 Sep 2026 17:00:02 +0000". */
function rfcDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/** The whole original as one pasted text (headers, a blank line, the body). */
export function testOriginal(o: TestOriginalOptions): string {
  const provider = o.provider ?? "gmail";
  const nl = o.newline ?? "\n";
  const messageId = o.messageId.trim().replace(/^<|>$/g, "");
  const sendingDomain = domainOf(messageId);
  const fromDomain = domainOf(o.from);
  const to = o.to ?? (provider === "gmail" ? "tess@gmail.com" : "tess@outlook.com");
  const [toLocal, toDomain] = [to.slice(0, to.lastIndexOf("@")), domainOf(to)];
  const returnPath = o.returnPath === undefined ? `bounce+1a2b3c.4d5e6f-${toLocal}=${toDomain}@${sendingDomain}` : o.returnPath;
  const dkimD = o.dkimD === undefined ? fromDomain : o.dkimD;
  const dkimResult = o.dkim ?? "pass";
  const dmarc = o.dmarc === undefined ? "pass" : o.dmarc;
  const listUnsubscribe =
    o.listUnsubscribe === undefined
      ? `<mailto:u+na6tmy3ege4tgnldmyytqojqmvqtoylf@${sendingDomain}?subject=unsubscribe>, <https://email.${sendingDomain}/u/H4sIAAAAAAAA_fake>`
      : o.listUnsubscribe;
  const date = rfcDate(o.date ?? new Date(Date.UTC(2026, 8, 27, 17, 0, 2)));
  const sentDate = rfcDate(new Date((o.date ?? new Date(Date.UTC(2026, 8, 27, 17, 0, 2))).getTime() - 1000));

  const headers: string[] = (o.extraHeaders ?? []).map(([n, v]) => `${n}: ${v}`);
  const dkimSignature = dkimD
    ? [
        `DKIM-Signature: a=rsa-sha256; v=1; c=relaxed/relaxed; d=${dkimD}; q=dns/txt; s=pdk1; t=1790528401;`,
        " h=Content-Type: Mime-Version: Subject: From: Reply-To: To: Date: Message-Id: List-Unsubscribe;",
        " bh=RmFrZUJvZHlIYXNoRmFrZUJvZHlIYXNo=; b=RmFrZVNpZ25hdHVyZUZha2VTaWduYXR1cmU=",
      ].join("\n")
    : null;
  const messageHeaders = [
    ...(listUnsubscribe !== null ? [`List-Unsubscribe: ${listUnsubscribe}`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
    `Received: by 7d3f2a1b0c9e with HTTP id 66f6e8a1b2c3d4e5f6a7b8c9; ${sentDate}`,
    `Date: ${sentDate}`,
    "Mime-Version: 1.0",
    "Subject: Reply test from Polygon Paradise Outreach",
    `From: ${o.from}`,
    ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []),
    `To: ${to}`,
    `Message-Id: <${messageId}>`,
    'Content-Type: multipart/alternative; boundary="fakeboundary"',
  ];

  if (provider === "gmail") {
    const clauses: string[] = [];
    if (dkimD) clauses.push(`dkim=${dkimResult} header.i=@${dkimD} header.s=pdk1 header.b=AbCd1234`);
    if (returnPath) {
      clauses.push(`spf=pass (google.com: domain of ${returnPath} designates ${MAILGUN_IP} as permitted sender) smtp.mailfrom="${returnPath}"`);
    }
    if (dmarc) clauses.push(`dmarc=${dmarc} (p=NONE sp=NONE dis=NONE) header.from=${fromDomain}`);
    const results = clauses.length ? `mx.google.com;\n       ${clauses.join(";\n       ")}` : "mx.google.com; none";
    headers.push(
      `Delivered-To: ${to}`,
      `Received: by 2002:a05:7300:5b8a:b0:1a2:3b4c:5d6e with SMTP id r10csp1234567dyb;\n        ${date}`,
      "X-Google-Smtp-Source: AGHT+IFakeFakeFakeFakeFakeFake",
      `X-Received: by 2002:a05:6214:1c8d:b0:6f5:3e2a:1b2c with SMTP id 6a1803df08f44-6f5c1b2a3d4mr1234567f.12.1790528402;\n        ${date}`,
      "ARC-Seal: i=1; a=rsa-sha256; t=1790528402; cv=none;\n        d=google.com; s=arc-20240605;\n        b=RmFrZUFyY1NlYWw=",
      "ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.com; s=arc-20240605;\n        h=to:subject:message-id:reply-to:from:date:mime-version:dkim-signature;\n        bh=RmFrZUJvZHlIYXNo=; fh=RmFrZUZo=;\n        b=RmFrZUFyY01lc3NhZ2VTaWduYXR1cmU=",
      `ARC-Authentication-Results: i=1; ${results}`,
      ...(returnPath && o.returnPathHeader !== false ? [`Return-Path: <${returnPath}>`] : []),
      `Received: from ${MAILGUN_HOST} (${MAILGUN_HOST}. [${MAILGUN_IP}])\n        by mx.google.com with UTF8SMTPS id 6a1803df08f44-6f5c1b2a3d4si1234567f.123.2026.09.27.10.00.02\n        for <${to}>\n        (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384 bits=256/256);\n        ${date}`,
      ...(returnPath
        ? [`Received-SPF: pass (google.com: domain of ${returnPath} designates ${MAILGUN_IP} as permitted sender) client-ip=${MAILGUN_IP};`]
        : []),
      `Authentication-Results: ${results}`,
      ...(dkimSignature ? [dkimSignature] : []),
      `X-Mailgun-Sending-Ip: ${MAILGUN_IP}`,
      "X-Mailgun-Sid: WyJmYWtlIiwidGVzdCJd",
      ...messageHeaders,
    );
  } else {
    const spf = returnPath
      ? `spf=pass (sender IP is ${MAILGUN_IP})\n smtp.mailfrom=${domainOf(returnPath)}; `
      : `spf=none (sender IP is ${MAILGUN_IP});\n `;
    const dkimPart = dkimD
      ? `dkim=${dkimResult} (${dkimResult === "pass" ? "signature was verified" : "signature did not verify"})\n header.d=${dkimD};`
      : "dkim=none (message not signed)\n header.d=none;";
    const dmarcPart = dmarc ? `dmarc=${dmarc} action=none\n header.from=${fromDomain};` : "";
    headers.push(
      `Received: from DM6PR11MB1234.namprd11.prod.outlook.com (2603:10b6:5:1b0::12)\n by SA1PR11MB5678.namprd11.prod.outlook.com with HTTPS; ${date}`,
      `Received: from BN9PR03CA0123.namprd03.prod.outlook.com (2603:10b6:408:fe::8)\n by DM6PR11MB1234.namprd11.prod.outlook.com (2603:10b6:5:1b0::12) with Microsoft\n SMTP Server (version=TLS1_2, cipher=TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384) id\n 15.20.8989.12; ${date}`,
      `Authentication-Results: ${spf}${dkimPart}${dmarcPart}compauth=pass reason=100`,
      ...(returnPath
        ? [
            `Received-SPF: Pass (protection.outlook.com: domain of ${domainOf(returnPath)}\n designates ${MAILGUN_IP} as permitted sender) receiver=protection.outlook.com;\n client-ip=${MAILGUN_IP}; helo=${MAILGUN_HOST}; pr=C`,
          ]
        : []),
      `Received: from ${MAILGUN_HOST} (${MAILGUN_IP}) by\n BN9PR03CA0123.mail.protection.outlook.com (10.167.8.12) with Microsoft SMTP\n Server (version=TLS1_3, cipher=TLS_AES_256_GCM_SHA384) id 15.20.8989.12 via\n Frontend Transport; ${date}`,
      ...(dkimSignature ? [dkimSignature] : []),
      ...messageHeaders,
      ...(returnPath && o.returnPathHeader !== false ? [`Return-Path: ${returnPath}`] : []),
      `X-MS-Exchange-Organization-ExpirationStartTime: 27 Sep 2026 17:00:03.1234\n (UTC)`,
      "X-MS-Exchange-Organization-Network-Message-Id: 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
      "X-MS-Exchange-Organization-AuthSource: BN9PR03CA0123.namprd03.prod.outlook.com",
      "X-MS-Exchange-Organization-AuthAs: Anonymous",
      "X-MS-Exchange-Organization-SCL: 1",
    );
  }

  const body = [
    "",
    "--fakeboundary",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hi,",
    "",
    'This is a test from the Polygon Paradise outreach app. Please reply to this email with a short message such as "Got it".',
    "",
    "If it landed in spam, move it to your inbox first, then reply.",
    "",
    "--fakeboundary--",
    "",
  ];
  return [...headers, ...body].join("\n").replace(/\n/g, nl);
}
