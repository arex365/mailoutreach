# Research (M4 preparation, verified 2026-09-23): desktop pop-ups, follow-up threading, follow-up timing

Collected before the Milestone 4 design ("Sequences and replies"). Sources are official or primary unless a line says
"vendor-reported". Re-verify anything marked UNVERIFIED before relying on it. Nothing here needs real email: the threading
checks in B4 are for the Owner's first real test after Mailgun is set up. They never run during the build or in tests.

## Summary

**A. Pop-ups.**
- Chrome, Edge and Firefox on Windows can show `new Notification(...)` from a normal tab, including a background or
  minimised tab. Four conditions: a secure context (https, or `localhost`/`127.0.0.1`, but never `http://192.168.x.x`),
  permission asked from a click, `Notification.permission === "granted"`, and the tab still running.
- Phones are different. On Android Chrome the constructor always throws, so only a service worker's `showNotification()`
  works. On iOS the API exists only in a web app added to the Home Screen. On both, a page in the background stops
  running, so polling can't trigger anything.
- Recommendation: desktop only, no service worker, no push. Poll every 20 s while visible. While hidden, poll every
  60 s only if pop-ups are on in this browser; otherwise pause, as PLAN says. Deduplicate with `tag` plus a per-user
  "last shown id" in `localStorage`.
- Keep two settings. The pop-up types go in `User.notifyPrefs` on the server. The "on in this browser" switch goes in
  `localStorage`, because permission belongs to the browser and address, not to the user.

**B. Threading.**
- Every client we care about puts the follow-up in the same conversation when three things hold: the subject is exactly
  `Re: <first subject as sent>`, `In-Reply-To` is the previous email's Message-ID, and `References` lists all earlier
  IDs oldest first, each in `<>`.
- Gmail and Thunderbird rely on the headers. Gmail since 2019 also needs the same subject, and Thunderbird ignores the
  subject by default. Outlook/Exchange groups by the subject with its prefix removed (an MD5 of the upper-cased topic)
  when there is no usable Thread-Index. So the subject is what counts for Outlook, and we should not send Thread-Index.
- Gmail's sender guidelines say not to use "Re:" "unless the messages are actual replies". An in-thread follow-up to our
  own delivered first email is a real reply. A "Re:" on a first email, or on a message the person never received, is not.
- Two traps. A first subject that starts with 1–3 letters and ": " (for example "Art: …") breaks Outlook grouping.
  A Mailgun-rewritten Message-ID, which M3 stores lowercased, may not match what the person received.

**C. Timing.**
- Add the delay as calendar days in the company's zone, using Temporal `ZonedDateTime.add({ days })`. This keeps the
  local clock time across DST. Then apply `nextWindowOpen`.
- With the PLAN sequence (+3, +4, +7) and a Mon–Fri window, follow-up 1 falls only on Mon, Thu or Fri. Monday gets the
  follow-ups for Wednesday, Thursday and Friday first emails.
- Vendor data (not independent) puts the first follow-up at about 3 days and later gaps at 3–7 days. The PLAN gaps sit
  inside that range.

---

## Part A: Browser desktop pop-ups

### A1. Facts

**The API and its states**
- Constructor: `new Notification(title, options)`. Options include `body`, `icon`, `tag`, `renotify`,
  `requireInteraction`, `silent`, `data`, `timestamp` and `navigate`. It throws `TypeError` if `renotify` is true and
  `tag` is empty, and when called inside a service worker. It "throws a `TypeError` when called in nearly all mobile
  browsers. You must register a service worker and use `ServiceWorkerRegistration.showNotification()` instead."
  — https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification
- `Notification.requestPermission()` returns a Promise of `"granted"`, `"denied"` or `"default"`. `"default"` means the
  decision is unknown, and the app "will act as if permission was denied". The deprecated callback form is only needed
  for Safari before 15. — https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
- User gesture: "Must request permission only in response to a user gesture". Firefox enforces this from version 72
  (Firefox Android from 79). "Safari has enforced this for some time."
  — https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API ;
  mdn/browser-compat-data `api/Notification.json`
- Chrome has shown a "quieter" notification prompt since Chrome 80, and a permission chip next to the lock icon since
  Chrome 98. Repeated dismissals put the permission "under embargo", so no prompt appears.
  (UNVERIFIED: the exact count of about three dismissals and how long the embargo lasts.)
  — https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html ,
  https://developer.chrome.com/blog/permissions-chip , https://issues.chromium.org/issues/40512312
- Chrome (Android and desktop) now automatically revokes notification permission for "sites when there is very low user
  engagement and a high volume of notifications being sent". "This feature does not revoke notifications for any
  installed web apps." A daily-used team tool sending few pop-ups should not qualify (UNVERIFIED for our usage pattern).
  — https://blog.google/chromium/automatic-notification-permission/
- The Permissions API can watch the state: `navigator.permissions.query({ name: "notifications" })` returns `state`
  (`granted`, `denied` or `prompt`) and fires `change`. — https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query

**Secure context**
- Potentially trustworthy origins are `https`, `wss` and `file`, loopback `127.0.0.0/8` and `::1`, `localhost` and
  `*.localhost`. Private LAN IPs over `http://` are not on the list. Feature-detect with `window.isSecureContext`.
  — https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts ;
  Chromium's list: https://www.chromium.org/Home/chromium-security/prefer-secure-origins-for-powerful-new-features/
- The Notifications API needs a secure context in Chrome from 62 and Firefox from 67 (browser-compat-data). The office
  address `http://192.168.x.x:3000` therefore gets no pop-ups. `http://localhost:3000` on the PC itself and the https
  tunnel address both work.
- (UNVERIFIED: exact insecure-origin behaviour per browser.) Whether `Notification` is `undefined` or
  `requestPermission()` quietly resolves `"denied"` varies. Branch on `isSecureContext` first and don't rely on either.
- Chrome's `--unsafely-treat-insecure-origin-as-secure` flag exists for developers. Don't ask staff to use it.
  — Chromium page above

**Support per platform** (mdn/browser-compat-data, `api/Notification.json`,
https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Notification.json)

| Feature | Chrome/Edge desktop | Firefox desktop | Chrome Android | Safari iOS |
|---|---|---|---|---|
| `Notification` interface | yes | yes | partial: "can only be sent from a service worker" | 16.4, only in a web app saved to the Home Screen |
| `new Notification()` | yes | yes | "always throws a TypeError" | throws `ReferenceError` unless Home Screen web app |
| `tag` | yes | yes (26) | yes | "can be set, but has no effect" (Safari) |
| `renotify` | 50 (experimental) | no | mirror | no |
| `requireInteraction` | 47 / Edge 17 | 117, Windows only | mirror | no |
| `navigate` option | no | preview | no | 18.4 (experimental) |
| click event | yes | yes | yes | 16.4 |

- iOS: web push and notifications need a Home Screen web app with a manifest `display` of `standalone` or `fullscreen`,
  and permission requested "in response to direct user interaction". Push travels through Apple Push Notification service
  with Push API, Notifications API and Service Workers "all working together".
  — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Next.js 16's own PWA guide (local: `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md`) shows the
  push route. It needs a service worker, VAPID keys, the `web-push` package, and stored subscriptions per device.

**Background tabs on Windows**
- Page Visibility: `document.visibilityState` is `"visible"` or `"hidden"`. The page is hidden when its tab is in the
  background, its window is minimised or the screen is off. `visibilitychange` fires on each change.
  — https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- Throttling in Chrome 88+ has three levels:
  - Hidden tabs check chained timers "once per second".
  - "Intensive throttling" runs timers "once per minute". It applies only when all of these hold: the page has been
    hidden for more than 5 minutes, the chain count is 5 or more, the page has been silent for at least 30 s, and WebRTC
    is not in use. A `setTimeout` polling chain qualifies.
  - Source: https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Edge applies the same once-per-minute throttling (policy `IntensiveWakeUpThrottlingEnabled`).
  — https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/intensivewakeupthrottlingenabled
- Firefox and Chrome also use budget-based throttling in background tabs. — MDN Page Visibility page above
- Edge sleeping tabs are on by default and pause JavaScript and timers. The default timeout is 7,200 s (2 h); users can
  choose 30 s to 12 h. "Microsoft Edge uses heuristics to avoid putting tabs to sleep that do useful work in the
  background, such as display notifications, play sound, and stream video." The policy `SleepingTabsBlockedForUrls`
  exempts sites. (UNVERIFIED: whether our tab counts as one that shows notifications, and the exact label of Edge's
  per-user "never put these sites to sleep" list.)
  — https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/sleepingtabsenabled ,
  https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/sleepingtabstimeout
- Chrome Memory Saver deactivates unused tabs, which reload when opened. It exempts "Active audio or video", "Screen
  share", "Page notifications", "Active downloads", "Partially filled forms", "Pinned tabs" and "Connected devices".
  The Performance settings have an "Always keep these sites active" list.
  — https://support.google.com/chrome/answer/12929150
- Windows "Do not disturb" shows banners only for "alarms, reminders, and apps of your choice". "Other notifications are
  sent directly to the notification center". It can switch on by itself: at set times, "When duplicating the display",
  "When playing a game", "When using an app in full-screen mode", and "For the first hour after a Windows feature
  update". A browser can be added as a priority app.
  — https://support.microsoft.com/en-us/windows/notifications-and-do-not-disturb-in-windows-feeca47f-0baf-5680-16f0-8801db1a8466
- Firefox 111 release notes: "Windows native notifications are now enabled."
  — https://www.firefox.com/en-US/firefox/111.0/releasenotes/
- (UNVERIFIED) Chrome and Edge show web notifications as native Windows notifications, so they obey Do not disturb and
  the per-app switches in Settings › System › Notifications.

**Clicks, replacing and cross-tab coordination**
- Click: "The default behavior is to move the focus to the viewport of the notification's related browsing context".
  Call `preventDefault()` to stop it. — https://developer.mozilla.org/en-US/docs/Web/API/Notification/click_event
- Tag: a new notification with the same `tag` replaces the old one. If the old one is already shown, it is closed and
  the new one appears. — https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API
- The same page says most browsers dismiss a notification after about 4 s and the tray behaviour varies, so don't rely on
  either.
- Service-worker notifications are handled by `notificationclick` using `clients.matchAll({type:"window"})`, then
  `client.focus()` or `clients.openWindow(url)`.
  — https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event
- Web Locks (`navigator.locks.request`) is scoped to one origin across tabs and needs a secure context. It has been
  Baseline since March 2022. — https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- (UNVERIFIED) On Windows, Chrome marks a window that other windows fully cover as hidden ("native window occlusion").
  Use `document.hasFocus()` as well as `visibilityState` when deciding whether the user is looking at the app.

### A2. Recommended design for M4

**Where pop-ups are offered.** The Settings › Notifications panel shows exactly one of these states:

| Condition | What the user sees |
|---|---|
| `!window.isSecureContext` (office `http://192.168…`) | "Not available on this address" text (wording below); no button |
| phone or tablet (`matchMedia("(pointer: coarse)")` and no fine pointer), or `!("Notification" in window)` | "Pop-ups work on a computer only. On your phone, check the bell." |
| permission `default` | Button **Turn on pop-ups**. Its click handler calls `requestPermission()` directly, with no `await` before it |
| permission `granted` | Switch **Pop-ups in this browser** (on/off), button **Send a test pop-up**, and the type checkboxes |
| permission `denied` | "Your browser is blocking pop-ups from this app" and how to allow them (wording below) |

- Also show a one-time dismissible hint under the bell: "Get a pop-up when someone replies? Turn it on". Show it only in
  a secure context while permission is `default`.
- If `new Notification()` throws (an Android-like browser that looks like a desktop), catch the error, store
  `unsupported` for this device and show the phone text.
- Don't build a service worker, a manifest or push in M4. Pop-ups exist so a person at the office PC sees a reply while
  working in another window. A service worker only helps on phones, where the page isn't running in the background
  anyway. Push would add VAPID keys, subscription storage and outbound calls to Google, Mozilla and Apple push servers,
  and iOS would still need Home Screen installation.

**Polling (replaces "pauses while hidden" in B6.14 when pop-ups are on).**
- Visible: poll `GET /api/notifications/summary` every 20 s, as PLAN says. Use a `setTimeout` chain with ±2 s jitter.
- Hidden, and pop-ups on in this browser (permission `granted` and the local switch on): poll every 60 s. Chrome and
  Edge clamp a hidden tab's chained timers to once a minute after 5 minutes anyway, so 60 s is what actually runs.
  A person waits at most about a minute for a reply pop-up.
- Hidden, and pop-ups off: pause, as PLAN says.
- On `visibilitychange` to visible, poll at once.
- Cost: one small authenticated GET per minute per hidden tab through the tunnel. That is negligible and no SSE is
  needed, so the reasons in B6.14 still hold.
- Several tabs: every tab may poll. Duplicates are stopped by the `localStorage` high-water mark and by `tag` (below).
  Web Locks (`navigator.locks.request("pp-popups", …)`) could elect one tab to show pop-ups, but it isn't needed for
  a team this size.

**Summary endpoint shape (M4 proposal).**
- Request: `GET /api/notifications/summary?after=<lastId>`.
- Response: `{ unread, latestId, popups: [{ id, type, title, body, link, mode }] }`.
- `popups` holds only notifications with `id > after`, of types the user picked for pop-ups, created in the last
  10 minutes, at most 5. The 10-minute limit stops a burst of old pop-ups when a laptop wakes up or a sleeping tab comes
  back.
- The first poll after page load only records `latestId`, so opening the app never pops old items.

**Showing a pop-up (client).**
- Show one only when `document.visibilityState === "hidden" || !document.hasFocus()`. Otherwise the bell badge and the
  in-page toast are enough.
- Read `pp.popups.last.<userId>` from `localStorage` (try/catch), skip ids at or below it, then write the new maximum.
- Call `new Notification(title, { body, tag: "pp-n-" + id, icon: "/icon-192.png", data: { link } })`. The `tag` stops a
  second tab showing the same one again.
- If more than 3 are new, show one pop-up instead: "5 new notifications" with tag `pp-n-batch`, linking to
  /notifications.
- Leave `renotify` unset: Firefox and Safari don't support it, and Chrome throws without a tag. Leave
  `requireInteraction` false: it only works on Windows in Firefox, and Windows keeps missed items in its notification
  centre anyway.
- Label dry-run and test notifications "Dry run:" and "Test:" (B6.5 table). Keep the body free of email text; pop-ups
  can show on shared or locked screens. Reply example: title "New reply from Figurenwerk GmbH", body
  "Anna Schmidt replied to “3D models for Figurenwerk”".
- Click: leave the default (it focuses the tab), then `n.close()` and navigate client-side to `data.link`.
  Use `window.location.assign` if the router isn't mounted. The target page marks the item read, as the bell does.

**Preferences storage.**
- Server, per user (`User.notifyPrefs`, already in B4): `{ popupTypes: ["reply"] }`. The default is replies only,
  because SPEC.md asks for "Optional browser desktop notifications for new replies". Offered types are reply,
  complaint and health (Owner), outage hold, and campaign finished.
- Per browser (`localStorage` key `pp.popups.on.<userId>`: `"on"` or `"off"`, keyed by user because two people may
  share a PC profile). The pop-up switch lives here because permission is per origin and browser profile, not per app
  user. `https://<tunnel host>` and `http://localhost:3000` are separate origins, each with its own permission and its
  own `localStorage`.
- Watch `navigator.permissions.query({name:"notifications"})` `change` events so the Settings panel updates when the
  user changes the permission from the lock icon.

**Wording** (plain words, matching A6 style; `{https}` is `APP_PUBLIC_URL`).
- Not available on this address: "Pop-ups can't work on this address. Browsers only allow them on the secure address
  ({https}) or on the office PC itself. Open {https} and turn them on there."
- Phone: "Pop-ups work on a computer only. On your phone, check the bell."
- Blocked: "Your browser is blocking pop-ups from this app. Click the icon to the left of the address, set Notifications
  to Allow, then reload this page."
- After **Send a test pop-up**: "Did you see it? If not, check Windows Settings › System › Notifications. Do not
  disturb must be off, or your browser must be on the priority list. Your browser must also be switched on in the list
  of apps."
- Tip under the switch: "Pop-ups only arrive while this app is open in a tab. Pin the tab so the browser keeps it
  running." Pinned tabs are exempt from Chrome Memory Saver. For Edge, the tip adds the site to the list of sites never
  put to sleep.

**Tests (no real browser notifications needed).**
- Unit-test the pure decision function
  `(secure, hasApi, coarsePointer, permission, localSwitch, hidden, focused) → state/interval/show`.
- Test the high-water-mark dedupe and the "first poll only records" rule.
- Test the summary endpoint's filters: `after`, types, 10-minute limit, cap of 5.
- Test that clicking a notification calls `close` and navigates, with a mocked `Notification`.

---

## Part B: Follow-up threading in real mail clients

### B1. Facts

**RFC 5322** (https://www.rfc-editor.org/rfc/rfc5322.html)
- §3.6.4: "every message SHOULD have a 'Message-ID:' field", and "reply messages SHOULD have 'In-Reply-To:' and
  'References:' fields".
- In-Reply-To "will contain the contents of the 'Message-ID:' field of the message to which this one is a reply (the
  'parent message')".
- References "will contain the contents of the parent's 'References:' field (if any) followed by the contents of the
  parent's 'Message-ID:' field (if any)". "The 'References:' field may be used to identify a 'thread' of conversation."
- Syntax: `in-reply-to = "In-Reply-To:" 1*msg-id CRLF`, `references = "References:" 1*msg-id CRLF` and
  `msg-id = [CFWS] "<" id-left "@" id-right ">" [CFWS]`. There is no CFWS inside the brackets. "Semantically, the angle
  bracket characters are not part of the msg-id". The generator "MUST guarantee that the msg-id is unique".
- §2.1.1: each line "MUST be no more than 998 characters, and SHOULD be no more than 78 characters". §2.2.3: a long
  field may be folded by inserting CRLF before any whitespace, preferably at "higher-level syntactic breaks". For
  `References` that means between IDs.
- §3.6.5: a reply subject "MAY start with the string 'Re: '… followed by the contents of the 'Subject:' field body of
  the original message. If this is done, only one instance of the literal string 'Re: ' ought to be used".

**Length limit.** RFC 5537 §3.4.4 (Netnews, the only RFC with a rule): "If the resulting References header field would,
after unfolding, exceed 998 characters … it MUST be trimmed … except that the first message identifier and the last two
MUST NOT be removed." — https://www.rfc-editor.org/rfc/rfc5537.html

**Generic threading algorithm.** RFC 5256 (IMAP THREAD=REFERENCES) uses the References IDs, or the first In-Reply-To ID
when References is missing. It then merges threads by "base subject", which is the subject decoded from RFC 2047 with
`re:`, `fw:`, `fwd:`, `[blob]` and `(fwd)` removed. — https://www.rfc-editor.org/rfc/rfc5256.html

**Gmail**
- Help: "A conversation breaks off into a new conversation when the subject line changes, or the conversation gets to
  more than 100 emails."
- For automated mail, Gmail may group messages with "The same recipients, senders, or subjects", "A reference header with
  the same IDs as a previous message" or "Sent within one week of a previous message".
- Source: https://support.google.com/mail/answer/5900
- 2019 change: "if you receive two emails with the same subject from the same sender, these emails will not be threaded
  together unless one explicitly references the other". Threading needs identical subjects plus reference headers that
  cite IDs from earlier in the thread.
  — https://workspaceupdates.googleblog.com/2019/03/threading-changes-in-gmail-conversation-view.html
- Gmail API: to join a thread, "The References and In-Reply-To headers must be set in compliance with the RFC 2822
  standard" and "The Subject headers must match". — https://developers.google.com/workspace/gmail/api/guides/threads
- (UNVERIFIED in Google's docs, though universally observed) Gmail ignores a leading "Re:" when comparing subjects.

**Outlook, Outlook.com and Microsoft 365 (Exchange)**
- Support: "A conversation includes all messages in the same thread with the same subject line."
  — https://support.microsoft.com/en-us/outlook/mail/view-email-messages-by-conversation-in-outlook
- EWS: "Exchange defines conversations based on the Message-ID value of the first email message in a thread. All replies
  and related messages reference the original message's Message-ID header in their References and In-Reply-To headers."
- The same EWS page says ConversationTopic is "a normalized form of the subject", the same as `Thread-Topic`, and
  ConversationIndex is the same as `Thread-Index`. "If the subject of the email thread changes, Exchange applies a new
  ConversationTopic value and new ConversationIndex values to the new conversation."
  — https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-work-with-conversations-by-using-ews-in-exchange
- [MS-OXOMSG] PidTagConversationId: if ConversationIndexTracking is TRUE and a valid 22+ byte ConversationIndex exists,
  the ID is its GUID. "Otherwise, if the PidTagConversationTopic property … is set", the ID is the MD5 of up to 255
  upper-cased UTF-16 characters of the topic.
  — https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxomsg/f8e4a5fa-cb73-4eca-b174-72e1fda821a6
- [MS-OXCMAIL] Conversation Topic: readers copy `Thread-Topic`. With only a `Subject`, the topic is the normalized
  subject. Conversation Index: readers copy `Thread-Index` if it decodes as base64, and ignore it otherwise.
  — https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/0c6ea518-0f18-414d-a8cb-38a0dd7e693a ,
  https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/1f362c6a-468b-4113-934f-9e18392c2299
- Subject normalization: "If the string contained in PR_SUBJECT begins with one to three non-numeric characters followed
  by a colon and a space, then the string together with the colon and the blank becomes the prefix. Numbers, blanks, and
  punctuation characters are not valid prefix characters."
  — https://learn.microsoft.com/en-us/office/client-developer/outlook/mapi/pidtagnormalizedsubject-canonical-property
- What this means: mail from outside, like ours, carries no Thread-Index, so Outlook groups by the normalized subject.
  "Re: X" and "X" both give "X" and land in one conversation. A first subject "Art: new models" is normalized to
  "new models", but "Re: Art: new models" only loses "Re: " and becomes "Art: new models". That starts a different
  conversation.
- (UNVERIFIED) Whether Exchange Online also uses References/In-Reply-To for internet mail when subjects differ. It
  doesn't matter to us, because we send matching subjects and correct headers.

**Apple Mail**
- "By default, Mail groups together email messages that are part of the same 'conversation' (or thread)" (View ›
  Organize by Conversation). Viewing settings include "Include related messages", which shows those located in other
  mailboxes. — https://support.apple.com/guide/mail/view-conversations-mail35700 ,
  https://support.apple.com/en-gb/guide/mail/cpmlprefview/mac
- (UNVERIFIED: Apple documents no algorithm) Commonly reported to use References/In-Reply-To together with the subject.
  Our headers plus the same subject cover both.

**Thunderbird**
- Default prefs in `mailnews/mailnews.js`:
  - `mail.strict_threading = true`: "if true, don't thread by subject at all".
  - `mail.thread_without_re = false`: "only thread by subject if Re:".
  - `mail.correct_threading = true`.
- So by default Thunderbird threads only on References/In-Reply-To.
- Source: https://raw.githubusercontent.com/mozilla/releases-comm-central/master/mailnews/mailnews.js

**Is "Re:" deceptive or harmful?**
- Gmail sender guidelines, "Message formatting requirements and guidelines": "Message headers and message content should
  be accurate, and not misleading or deceptive". Also: "don't send messages with subject lines starting with Re: or Fwd:
  unless the messages are actual replies or forwards". — https://support.google.com/a/answer/81126
- FTC CAN-SPAM guide (applies to US recipients): "Don't use deceptive subject lines. The subject line must accurately
  reflect the content of the message." "The law makes no exception for business-to-business email."
  — https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- Yahoo Sender Hub: don't use "deceptive subject lines to hide, forge or misrepresent the sender or origin".
  — https://senders.yahooinc.com/best-practices/
- The Outlook.com postmaster page reviewed covers only the May 2025 SPF/DKIM/DMARC rule for senders above 5,000 a day.
  No official Microsoft wording on "Re:" was found. — https://substrate.office.com/ip-domain-management-snds/postmaster
- Conclusion (fact and reasoning): our follow-up is a real reply in the thread of an email this person was actually sent,
  and its `In-Reply-To` proves that. So it meets the letter of Gmail's rule. The rule forbids "Re:" on a first email, and
  it would be misleading on a follow-up whose previous email never reached the person.
- No official source was found that measures a spam-filter effect of "Re:" on a genuine in-thread follow-up. Vendor
  claims both ways are UNVERIFIED.

### B2. What our follow-up should look like

Follow-up 1 (step 1), as sent through Mailgun:

```
From:        Ali from Polygon Paradise <ali@send.example.com>      (the campaign's sender snapshot, unchanged)
To:          anna@figurenwerk.de                                     (the same person)
Subject:     Re: 3D models for Figurenwerk                           ("Re: " + step-0 subject exactly as this person received it)
Message-ID:  <pp.9f2c…@send.example.com>                             (new, unique)
In-Reply-To: <pp.1a2b…@send.example.com>                             (step 0's Message-ID)
References:  <pp.1a2b…@send.example.com>
```

Follow-up 2 (step 2):

```
Subject:     Re: 3D models for Figurenwerk                           (still one "Re: ", never "Re: Re: ")
In-Reply-To: <pp.9f2c…@send.example.com>                             (step 1's Message-ID, the immediate parent)
References:  <pp.1a2b…@send.example.com> <pp.9f2c…@send.example.com> (oldest first, single spaces)
```

Mailgun fields: `h:In-Reply-To=<id>` and `h:References=<id1> <id2>` with brackets (mailgun-sending.md: keep the bracketed
form for these). Existing M3 helpers: `nextReferences()` in `src/server/services/sending/addresses.ts` stores bare
space-separated IDs, so add the `<>` when building the fields.

- **Length.** Our IDs are about 45–60 characters with brackets (`pp.` + 24 hex + `@` + sending domain). Four steps give
  about 180 characters, and even ten give about 600. That is always under the 998 hard limit, so one line is valid; it is
  over the 78 "SHOULD", which is allowed. Don't insert CRLF into the `h:` value yourself. If the unfolded field would
  ever pass 998 characters, trim per RFC 5537 (keep the first and the last two). (UNVERIFIED: whether Mailgun folds long
  custom headers when it builds the MIME.)
- **Body.** A short reply with no quoted original, no "On … wrote:" block and no "Fwd". This follows PLAN A5.11. The same
  footer and unsubscribe handling as the first email. In a threaded client the first email sits just above. With
  conversation view off (a Gmail setting; View › Show as Conversations in Outlook), the follow-up stands alone. The
  templates should therefore make sense on their own. The A7 defaults do.
- **Don't send `Thread-Index` or `Thread-Topic`.** Outlook groups by the normalized subject anyway. A wrong or
  inconsistent Thread-Index could split the conversation, and there's nothing to gain.
- **Only follow a real, sent parent.** The step N+1 row is created by `markSent()` (B6.4). The existing stop rules
  (bounce or permanent failure) keep a "Re:" from following an email the person never got. M4 must keep it that way for
  M3's UNKNOWN and UNCONFIRMED states: no follow-up until the parent is proven sent.

### B3. Edge cases for the M4 design

1. **Subject already starting with "Re:"** (someone typed it into a template). Don't add a second one (RFC 5322 §3.6.5).
   Better, warn in the template editor: "Don't start a first email with Re:. Gmail's rules forbid it." Recommendation:
   block it on the first step.
2. **Outlook prefix trap.** A first subject matching `^[\p{L}]{1,3}: ` (1–3 letters, colon, space; e.g. "Art: …",
   "FYI: …", "Neu: …") ends up in a different Outlook conversation from its follow-ups. Warn in the template editor:
   "Outlook would show the follow-ups separately. Reword the start of the subject." Subjects starting with digits
   ("3D: …") are safe.
3. **Personalised first subjects.** Always build from the stored subject the person actually received, not from the
   template. PLAN already says so. Any difference, even a trailing space, starts a new Gmail or Outlook conversation.
4. **Rewritten Message-ID.** If M3's `message-id-rewritten` notice ever fires, the person received Mailgun's ID and not
   ours. M3 stores `providerId` lowercased (`bareMessageId()`), and RFC 5322 doesn't say IDs match regardless of case.
   (UNVERIFIED: how Gmail and Thunderbird compare case.) Either keep the raw-case ID for threading headers, or treat the
   notice as blocking follow-ups until checked. Our own IDs are lowercase already, so the normal path is safe.
5. **Non-ASCII subjects** (German umlauts, Norwegian æøå). RFC 5256 decodes RFC 2047 encoded-words before comparing. Keep
   "Re: " as plain ASCII in front of the stored subject and let Mailgun encode it. (UNVERIFIED: Mailgun's exact encoding
   of the Subject.)
6. **The sender's own inbox.** Mail goes out through Mailgun, not the sender's mailbox, so the sender has no copy. A reply
   lands in their inbox as a lone "Re: …" message. It usually quotes our text; the app's timeline has the rest. Say this
   in the help text.
7. **Checks for the Owner's first real test (after Mailgun setup; never in the build).**
   - Send step 0 and step 1 of a test campaign with delay 0 to test-list mailboxes on Gmail and Outlook.com (and Apple
     Mail or Thunderbird if available).
   - Confirm each shows one conversation.
   - Use "Show original" to confirm Mailgun kept `In-Reply-To` and `References` byte-for-byte (UNVERIFIED until then).
   - Automated tests assert the exact `h:` fields in the fake Mailgun's captured requests.

---

## Part C: Follow-up timing

### C1. Facts

- Temporal `ZonedDateTime.add()`:
  - Calendar units (days) are added to the local date-time, "and then interpret[ed] … in the same time zone". Example:
    `2024-11-03T01:00-04:00[America/New_York]` plus one day is `2024-11-04T01:00-05:00`, "as if the day has 25 hours".
  - Exact units (hours) are added to the instant.
  - A result in a DST gap or overlap uses `"compatible"`: the later instant for a gap, the earlier for an overlap.
  - Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/ZonedDateTime/add
  - The project uses `temporal-polyfill` 1.0.5, which has the same API.
- EU summer time begins and ends "at 1.00 a.m., Greenwich Mean Time, on the last Sunday in March" and "… the last Sunday
  in October" (Directive 2000/84/EC, Arts. 2–3). In 2026 that is 29 March and 25 October.
  — https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32000L0084
- Norway uses the same dates (UNVERIFIED legal source; IANA `Europe/Oslo` has them).
- US: DST "begins at 2:00 a.m. on the second Sunday of March" and "ends at 2:00 a.m. on the first Sunday of November".
  In 2026 that is 8 March to 1 November. — https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst
- Every EU and US transition falls on a Sunday night, outside the Mon–Fri 09:00–17:00 window. So a follow-up time never
  lands in a DST gap inside the window. The only effect is that "72 hours" and "3 calendar days" differ by an hour
  across a change.
  - Worked example (Berlin): a first email accepted Fri 27 Mar 2026 at 16:45 CET.
  - Plus 72 h is Mon 30 Mar at 17:45 CEST. That is after closing, so it moves to Tue 09:00.
  - Plus 3 calendar days is Mon 16:45 CEST, which is inside the window.
- Weekend spread with the PLAN sequence (A7: follow-up 1 at +3 days, follow-up 2 at +4 after follow-up 1, optional
  follow-up 3 at +7). This assumes a Mon–Fri window, each step sent on the day it's due, and weekend dates moved to
  Monday:

  | First email | Follow-up 1 due | Follow-up 2 due | Follow-up 3 due |
  |---|---|---|---|
  | Mon | Thu | Mon | Mon |
  | Tue | Fri | Tue | Tue |
  | Wed | Sat → **Mon** | Fri | Fri |
  | Thu | Sun → **Mon** | Fri | Fri |
  | Fri | Mon | Fri | Fri |

  - Follow-up 1 lands only on Mon, Thu or Fri, and Monday collects three weekdays' worth.
  - Follow-up 2 lands on Friday for three of the five start days.
  - `nextWindowOpen` gives weekend dates Monday 09:00, so Wednesday's and Thursday's follow-ups all become due at
    Monday's opening. The pacing gaps and the daily cap then spread them out, in competition with first emails.

- **Vendor-reported practice (not independent; each vendor sells sequencing software):**
  - Belkins (2023, "11 million emails"):
    - "Waiting 3 days before following up brings a 31% increase in the reply rate".
    - "Waiting longer than 5 days decreases the likelihood of a response by 24%".
    - Following up "within 1 day" costs 11%.
    - A second follow-up adds 9% and a third lowers replies by 20%. Three-step sequences had the highest reply rate,
      9.2%.
    - Source: https://belkins.io/blog/cold-email-outreach-statistics
  - Belkins (2026 study, 7.5 M emails in 2025): follow-ups are "58.6% of all replies". Step 3 books the most meetings.
    A 3–5 step sequence is optimal. — https://belkins.io/blog/sales-follow-up-statistics
  - Instantly (2026 report, workspace data for 1 Jan–18 Dec 2025):
    - "58% of all replies are generated from step one"; "Space touches 3-4 days apart".
    - "4-7 touchpoints" is the sweet spot.
    - Wednesday has the highest engagement, and Friday "sees the highest volume of auto-replies".
    - Source: https://instantly.ai/cold-email-benchmark-report-2026
  - Woodpecker (a round-up page mixing its own data, "over 20 million" emails, with others'): "First follow-up 3–4 days
    after the initial email, second 5–7 days later, third 7–10 days after that". It also says "Avoid identical
    intervals". — https://woodpecker.co/blog/cold-email-statistics/
  - Belkins and Instantly disagree on whether most replies come from step 1 (58% vs 41%). Treat all of these figures as
    marketing data.
  - The PLAN gaps (+3, then +4, then +7) sit inside every vendor's suggested range.

### C2. Recommended computation (M4)

```ts
// acceptedAt = when Mailgun accepted step N (markSent); zone = resolveZone(company.timeZone, defaultZone)
const local = Temporal.Instant.fromEpochMilliseconds(acceptedAt.getTime()).toZonedDateTimeISO(zone);
const due = local.add({ days: delayDays });           // calendar days: same local clock time, DST-safe
dueAt = nextWindowOpen(new Date(due.epochMilliseconds), zone, window);   // existing src/core/sending/window.ts
```

- Use the company's zone, not the cap-day zone (Asia/Karachi) and not the user's zone. Holidays are ignored (PLAN A5.4).
- Store `dueAt` as UTC. Recompute it only if the company's zone changes while the row is still waiting (an M4 decision).
- Optional, to soften the Monday pile-up: when the due date falls outside the window, move to the same local clock time
  on the next open day (or the window's start if that time is outside). "Sat 14:20" would become "Mon 14:20" rather than
  "Mon 09:00". This changes the "next open slot" wording in B6.4, so it needs the Owner's OK. Otherwise leave it to
  pacing.
- Tests: add cases for the DST example above (27 Mar 2026 and 23 Oct 2026 in Europe/Berlin; 6 Mar 2026 and 30 Oct 2026
  in America/New_York) and for every weekday row in the table. These are covered by the test list in PLAN B12
  ("follow-up scheduling across weekends and DST, threading headers").

---

## UNVERIFIED (collected)

- The exact count and length of Chrome's prompt embargo; Chrome and Edge using native Windows notifications; Chrome
  treating fully covered windows as hidden.
- How each browser behaves on an insecure origin (`Notification` undefined, or `requestPermission()` resolving
  "denied").
- Whether Edge's sleeping-tab heuristics and Chrome's "Page notifications" exemption cover our tab. The label of Edge's
  per-user never-sleep list.
- Whether Chrome's automatic permission revocation could ever hit a daily-used app.
- Gmail ignoring a leading "Re:" when comparing subjects (observed, not documented).
- Exchange Online's use of References when subjects differ. Apple Mail's threading algorithm.
- Whether Mailgun keeps `h:In-Reply-To` and `h:References` byte-for-byte, and whether it folds long custom headers.
  How it encodes non-ASCII subjects.
- Whether clients compare Message-IDs case-sensitively (it matters only after a Mailgun rewrite).
- The Norwegian legal source for DST dates. All vendor cadence statistics.

## Sources

- MDN: Notification() https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification ·
  requestPermission https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static ·
  Using the Notifications API https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API ·
  click event https://developer.mozilla.org/en-US/docs/Web/API/Notification/click_event ·
  notificationclick https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event ·
  Secure contexts https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts ·
  Page Visibility https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API ·
  Web Locks https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API ·
  Permissions.query https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query ·
  Temporal add https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/ZonedDateTime/add
- browser-compat-data: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Notification.json
- Chrome/Chromium: https://developer.chrome.com/blog/timer-throttling-in-chrome-88 ·
  https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html ·
  https://developer.chrome.com/blog/permissions-chip · https://issues.chromium.org/issues/40512312 ·
  https://blog.google/chromium/automatic-notification-permission/ ·
  https://www.chromium.org/Home/chromium-security/prefer-secure-origins-for-powerful-new-features/ ·
  https://support.google.com/chrome/answer/12929150
- Microsoft: https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/sleepingtabsenabled ·
  https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/sleepingtabstimeout ·
  https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/intensivewakeupthrottlingenabled ·
  https://support.microsoft.com/en-us/windows/notifications-and-do-not-disturb-in-windows-feeca47f-0baf-5680-16f0-8801db1a8466 ·
  https://support.microsoft.com/en-us/outlook/mail/view-email-messages-by-conversation-in-outlook ·
  https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-work-with-conversations-by-using-ews-in-exchange ·
  https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxomsg/f8e4a5fa-cb73-4eca-b174-72e1fda821a6 ·
  https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/0c6ea518-0f18-414d-a8cb-38a0dd7e693a ·
  https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/1f362c6a-468b-4113-934f-9e18392c2299 ·
  https://learn.microsoft.com/en-us/office/client-developer/outlook/mapi/pidtagnormalizedsubject-canonical-property ·
  https://substrate.office.com/ip-domain-management-snds/postmaster
- Mozilla: https://www.firefox.com/en-US/firefox/111.0/releasenotes/ ·
  https://raw.githubusercontent.com/mozilla/releases-comm-central/master/mailnews/mailnews.js
- Apple/WebKit: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ ·
  https://support.apple.com/guide/mail/view-conversations-mail35700 · https://support.apple.com/en-gb/guide/mail/cpmlprefview/mac
- Google mail: https://support.google.com/mail/answer/5900 ·
  https://workspaceupdates.googleblog.com/2019/03/threading-changes-in-gmail-conversation-view.html ·
  https://developers.google.com/workspace/gmail/api/guides/threads · https://support.google.com/a/answer/81126
- RFCs: https://www.rfc-editor.org/rfc/rfc5322.html · https://www.rfc-editor.org/rfc/rfc5537.html ·
  https://www.rfc-editor.org/rfc/rfc5256.html
- Law and time: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business ·
  https://senders.yahooinc.com/best-practices/ · https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32000L0084 ·
  https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst
- Vendor data: https://belkins.io/blog/cold-email-outreach-statistics · https://belkins.io/blog/sales-follow-up-statistics ·
  https://instantly.ai/cold-email-benchmark-report-2026 · https://woodpecker.co/blog/cold-email-statistics/
- Local: `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md`; `src/core/sending/window.ts`;
  `src/server/services/sending/addresses.ts`; `src/server/mailgun/client.ts`; PLAN.md A5.4, A5.11, A7, B4, B6.4, B6.5, B6.14, B12.
