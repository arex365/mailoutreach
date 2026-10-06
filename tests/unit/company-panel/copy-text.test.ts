import { afterEach, describe, expect, it, vi } from "vitest";
import { copyHost, copyText } from "@/components/copy-text";

/**
 * copyText() on the plain-http office address (no navigator.clipboard) inside the company panel,
 * a modal sheet whose focus trap sends focus straight back when it moves outside the sheet.
 * A tiny fake DOM is enough: elements with parents, focus, selection and a clipboard.
 */

class FakeElement {
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  value = "";
  tabIndex = 0;
  selectionStart = 0;
  selectionEnd = 0;
  constructor(
    readonly doc: FakeDocument,
    readonly tag: string,
    role?: string,
  ) {
    if (role) this.attrs.role = role;
  }
  get ownerDocument() {
    return this.doc;
  }
  get isConnected(): boolean {
    return isInside(this, this.doc.body);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  closest(selector: string): FakeElement | null {
    const roles = selector.includes("alertdialog") ? ["dialog", "alertdialog"] : ["dialog"];
    if (roles.includes(this.attrs.role ?? "")) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  focus() {
    this.doc.moveFocus(this);
  }
  select() {
    // Selecting also focuses (as browsers do), which the trap may undo.
    this.doc.moveFocus(this);
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
}

class FakeDocument {
  body: FakeElement;
  activeElement: FakeElement;
  /** Like Radix FocusScope: focus that leaves this element is sent back to `trapReturn`. */
  trap: { container: FakeElement; trapReturn: FakeElement } | null = null;
  clipboard = "old clipboard text";
  constructor() {
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(this, tag);
  }
  moveFocus(el: FakeElement) {
    if (this.trap && !isInside(el, this.trap.container)) {
      this.activeElement = this.trap.trapReturn;
      return;
    }
    this.activeElement = el;
  }
  querySelectorAll(selector: string) {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      if ((el.attrs.role === "dialog" || el.attrs.role === "alertdialog") && el.attrs["data-state"] === "open" && selector.includes("data-state")) {
        out.push(el);
      }
      el.children.forEach(walk);
    };
    walk(this.body);
    return out;
  }
  /** Chrome returns true even when nothing useful was selected; it copies the focused box's selection. */
  execCommand(cmd: string) {
    if (cmd !== "copy") return false;
    const el = this.activeElement;
    if (el.tag === "textarea") this.clipboard = el.value.slice(el.selectionStart, el.selectionEnd);
    return true;
  }
}

function isInside(el: FakeElement, container: FakeElement): boolean {
  let cur: FakeElement | null = el;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parent;
  }
  return false;
}

function setup() {
  const doc = new FakeDocument();
  const sheet = doc.body.appendChild(new FakeElement(doc, "div", "dialog"));
  sheet.attrs["data-state"] = "open";
  const button = sheet.appendChild(new FakeElement(doc, "button"));
  doc.activeElement = button;
  doc.trap = { container: sheet, trapReturn: button };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { isSecureContext: false });
  vi.stubGlobal("navigator", {});
  return { doc, sheet, button };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText on the plain-http office address", () => {
  it("copies from inside the open panel, then gives focus back to the button", async () => {
    const { doc, sheet, button } = setup();
    expect(copyHost(doc as unknown as Document)).toBe(sheet);
    const ok = await copyText("anna@acme3d.de");
    expect(ok).toBe(true);
    expect(doc.clipboard).toBe("anna@acme3d.de");
    expect(sheet.children).toHaveLength(1); // the temporary box is gone
    expect(sheet.children[0]).toBe(button);
    expect(doc.activeElement).toBe(button);
  });

  it("uses the open dialog even when the click didn't focus the button (Safari)", async () => {
    const { doc, sheet } = setup();
    doc.activeElement = doc.body;
    expect(copyHost(doc as unknown as Document)).toBe(sheet);
    expect(await copyText("x@y.de")).toBe(true);
    expect(doc.clipboard).toBe("x@y.de");
  });

  it("reports failure (never a false 'Copied') when the text couldn't be selected", async () => {
    const { doc, sheet } = setup();
    // Something else holds a trap the temporary box can't enter.
    const other = doc.body.appendChild(new FakeElement(doc, "div"));
    doc.trap = { container: other, trapReturn: other };
    expect(await copyText("anna@acme3d.de")).toBe(false);
    expect(doc.clipboard).toBe("old clipboard text");
    expect(sheet.children).toHaveLength(1);
  });

  it("uses the browser clipboard when there is one (https)", async () => {
    setup();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });
});
