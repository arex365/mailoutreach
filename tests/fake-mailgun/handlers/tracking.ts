import { field, formBool, json, type FakeContext, type HandlerResult } from "./context";

/**
 * Tracking settings (research §10, §15): GET /v3/domains/{d}/tracking and the three multipart PUTs. Defaults: open and
 * click tracking on, unsubscribe handling off with Mailgun's default footers; web_scheme mirrors the domain. The
 * `ignoreEmptyFooters` switch keeps the old footers when "" is sent (Mailgun's unverified behaviour).
 */

export function getTracking(ctx: FakeContext): HandlerResult {
  const t = ctx.world.tracking;
  return json(200, {
    tracking: {
      open: { active: t.open.active, place_at_the_top: t.open.placeAtTheTop },
      click: { active: t.click.active },
      unsubscribe: { active: t.unsubscribe.active, html_footer: t.unsubscribe.htmlFooter, text_footer: t.unsubscribe.textFooter },
      web_scheme: ctx.world.domain.webScheme,
    },
  });
}

const UPDATED = "Domain tracking settings have been updated";

export function putTracking(ctx: FakeContext): HandlerResult {
  const form = ctx.req.form;
  if (!form) return json(400, { message: "Content-Type must be multipart/form-data." });
  const t = ctx.world.tracking;
  const which = ctx.req.params.which;
  const activeRaw = field(form, "active");
  if (which === "click") {
    if (activeRaw !== undefined) {
      if (activeRaw === "htmlonly") t.click.active = "htmlonly";
      else {
        const v = formBool(activeRaw);
        if (v === undefined) return json(400, { message: "active must be true, false or htmlonly" });
        t.click.active = v;
      }
    }
    return json(200, { message: UPDATED, click: { active: t.click.active } });
  }
  const active = formBool(activeRaw);
  if (activeRaw !== undefined && active === undefined) return json(400, { message: "active must be true or false" });
  if (which === "open") {
    if (active !== undefined) t.open.active = active;
    const top = formBool(field(form, "place_at_the_top"));
    if (top !== undefined) t.open.placeAtTheTop = top;
    return json(200, { message: UPDATED, open: { active: t.open.active, place_at_the_top: t.open.placeAtTheTop } });
  }
  if (active !== undefined) t.unsubscribe.active = active;
  const html = field(form, "html_footer");
  const text = field(form, "text_footer");
  if (html !== undefined && !(html === "" && ctx.switches.ignoreEmptyFooters)) t.unsubscribe.htmlFooter = html;
  if (text !== undefined && !(text === "" && ctx.switches.ignoreEmptyFooters)) t.unsubscribe.textFooter = text;
  return json(200, {
    message: UPDATED,
    unsubscribe: { active: t.unsubscribe.active, html_footer: t.unsubscribe.htmlFooter, text_footer: t.unsubscribe.textFooter },
  });
}
