"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { ExternalLink, Info, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { countryOptions, timeZoneOptions } from "@/core/geo/display";
import {
  addCompanyTagAction,
  addCompanyToListAction,
  removeCompanyFromListAction,
  removeCompanyTagAction,
  setCompanyCountryAction,
  setCompanyCustomFieldAction,
  setCompanyInstagramAction,
  setCompanyNicheAction,
  setCompanyTimeZoneAction,
  setCompanyWebsiteAction,
} from "./actions";
import { ChipsField, InlineError, InlineTextField, PanelSection, SearchSelect, usePanelAction, type PickerOption } from "./panel-ui";
import type { DetailsView } from "./types";

function Row({ label, labelId, children }: { label: string; labelId?: string; children: ReactNode }) {
  return (
    <>
      <dt id={labelId} className="pt-1 text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function CountryAndZone({ view, countries }: { view: DetailsView; countries: PickerOption[] }) {
  const { pending, error, run } = usePanelAction();
  const [offer, setOffer] = useState<string | null>(null);
  const zones = useMemo<PickerOption[]>(() => {
    const list = timeZoneOptions();
    if (view.timeZone && !list.includes(view.timeZone)) list.push(view.timeZone);
    return list.sort().map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
  }, [view.timeZone]);
  const countryChoices: PickerOption[] = useMemo(() => [{ value: "", label: "No country" }, ...countries], [countries]);
  const canReset = Boolean(view.countryDefaultZone && view.countryDefaultZone !== view.timeZone);

  return (
    <>
      <Row label="Country">
        <div className="grid gap-2">
          {view.readOnly ? (
            <span className="pt-1">{view.countryName ?? "Not set"}</span>
          ) : (
            <SearchSelect
              label="Country"
              options={countryChoices}
              value={view.country ?? ""}
              disabled={pending}
              placeholder="Search countries…"
              emptyText="No country matches."
              trigger={
                view.countryName ? <span>{view.countryName}</span> : <span className="text-muted-foreground">Pick a country</span>
              }
              onSelect={(code) =>
                run(() => setCompanyCountryAction({ companyId: view.companyId, value: code }), {
                  onSuccess: (r) => setOffer(r.suggestedTimeZone),
                })
              }
            />
          )}
          {offer && !view.readOnly ? (
            <div className="grid gap-2 rounded-md border border-border bg-muted/50 p-2.5 text-sm" role="status">
              <p>
                {view.countryName ? `${view.countryName}'s` : "The new country's"} usual time zone is {offer}. This company
                uses {view.timeZone ?? view.defaultTimeZone}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run(() => setCompanyTimeZoneAction({ companyId: view.companyId, timeZone: offer }), {
                      onSuccess: () => setOffer(null),
                    })
                  }
                >
                  Use {offer}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOffer(null)}>
                  Keep {view.timeZone ?? view.defaultTimeZone}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Row>
      <Row label="Time zone">
        <div className="grid gap-2">
          {view.readOnly ? (
            <span className="pt-1">{view.timeZone ?? `Default (${view.defaultTimeZone})`}</span>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <SearchSelect
                label="Time zone"
                options={zones}
                value={view.timeZone}
                disabled={pending}
                placeholder="Search time zones…"
                emptyText="No time zone matches."
                trigger={
                  view.timeZone ? (
                    <span>{view.timeZone.replace(/_/g, " ")}</span>
                  ) : (
                    <span className="text-muted-foreground">Default ({view.defaultTimeZone})</span>
                  )
                }
                onSelect={(z) =>
                  run(() => setCompanyTimeZoneAction({ companyId: view.companyId, timeZone: z }), {
                    onSuccess: () => setOffer(null),
                  })
                }
              />
              {canReset ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    run(() => setCompanyTimeZoneAction({ companyId: view.companyId, timeZone: null }), {
                      onSuccess: () => setOffer(null),
                    })
                  }
                >
                  <RotateCcw aria-hidden />
                  Reset to country default
                </Button>
              ) : null}
            </div>
          )}
          <InlineError error={error} />
        </div>
      </Row>
    </>
  );
}

function CustomFields({ view }: { view: DetailsView }) {
  const [adding, setAdding] = useState<string | null>(null);
  const filled = new Set(view.customFields.map((f) => f.key));
  const unfilled = view.customFieldDefs.filter((d) => !filled.has(d.key));
  const addingDef = adding ? view.customFieldDefs.find((d) => d.key === adding) : undefined;

  return (
    <>
      {view.customFields.map((f) => (
        <Row key={f.key} label={f.label}>
          <InlineTextField
            id={`company-panel-custom-${f.key}`}
            label={f.label}
            value={f.value}
            readOnly={view.readOnly}
            maxLength={1000}
            hint="Clear it and save to remove this field."
            onSave={(value) => setCompanyCustomFieldAction({ companyId: view.companyId, key: f.key, value })}
          />
        </Row>
      ))}
      {addingDef ? (
        <Row label={addingDef.label}>
          <InlineTextField
            key={addingDef.key}
            id={`company-panel-custom-new-${addingDef.key}`}
            label={addingDef.label}
            value=""
            startEditing
            maxLength={1000}
            onSave={(value) => setCompanyCustomFieldAction({ companyId: view.companyId, key: addingDef.key, value })}
            onDone={() => setAdding(null)}
          />
        </Row>
      ) : null}
      {!view.readOnly && unfilled.length > 0 && !addingDef ? (
        <Row label="More fields">
          <SearchSelect
            label="Fill in another field"
            options={unfilled.map((d) => ({ value: d.key, label: d.label }))}
            placeholder="Search fields…"
            emptyText="No field matches."
            triggerClassName="h-7"
            trigger={
              <>
                <Plus className="size-3.5" aria-hidden />
                Add a field
              </>
            }
            onSelect={(key) => setAdding(key)}
          />
        </Row>
      ) : null}
    </>
  );
}

/** Niche, tags, lists, country, time zone, website, Instagram, custom fields… each saves on its own. */
export function DetailsSection({ view }: { view: DetailsView }) {
  const nicheListId = useId();
  const countries = useMemo<PickerOption[]>(
    () => countryOptions().map((c) => ({ value: c.code, label: c.name, hint: c.code })),
    [],
  );
  const id = view.companyId;

  return (
    <PanelSection title="Details" id="company-panel-details">
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-y-3">
        <Row label="Website">
          <div className="grid gap-1">
            <InlineTextField
              id="company-panel-website"
              label="Website"
              value={view.website ?? ""}
              readOnly={view.readOnly}
              placeholder="acme.de"
              emptyText="No website"
              maxLength={2000}
              display={
                view.websiteUrl ? (
                  <a
                    href={view.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1 underline-offset-2 hover:underline"
                  >
                    <span className="truncate">{view.websiteHost ?? view.website}</span>
                    <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : undefined
              }
              onSave={(value) => setCompanyWebsiteAction({ companyId: id, value })}
            />
            {view.websiteIsShared ? (
              <p className="inline-flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                This looks like a social or marketplace page, so it won&apos;t be used to find duplicates.
              </p>
            ) : null}
          </div>
        </Row>

        <Row label="Instagram">
          <InlineTextField
            id="company-panel-instagram"
            label="Instagram"
            value={view.instagram ? `@${view.instagram}` : ""}
            readOnly={view.readOnly}
            placeholder="@name or profile link"
            emptyText="No Instagram"
            maxLength={300}
            display={
              view.instagram ? (
                <a
                  href={`https://www.instagram.com/${encodeURIComponent(view.instagram)}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  @{view.instagram}
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : undefined
            }
            onSave={(value) => setCompanyInstagramAction({ companyId: id, value })}
          />
        </Row>

        <CountryAndZone view={view} countries={countries} />

        <Row label="Niche">
          <InlineTextField
            id="company-panel-niche"
            label="Niche"
            value={view.niche ?? ""}
            readOnly={view.readOnly}
            placeholder="e.g. Tabletop miniatures"
            emptyText="No niche"
            maxLength={100}
            listId={nicheListId}
            onSave={(value) => setCompanyNicheAction({ companyId: id, value })}
          />
          <datalist id={nicheListId}>
            {view.niches.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Row>

        <Row label="Tags">
          <ChipsField
            noun="tag"
            items={view.tags}
            options={view.allTags}
            readOnly={view.readOnly}
            emptyText="No tags"
            onAdd={(t) => addCompanyTagAction({ companyId: id, ...t })}
            onRemove={(tagId) => removeCompanyTagAction({ companyId: id, id: tagId })}
          />
        </Row>

        <Row label="Lists">
          <ChipsField
            noun="list"
            items={view.lists}
            options={view.allLists}
            readOnly={view.readOnly}
            emptyText="Not in any list"
            onAdd={(t) => addCompanyToListAction({ companyId: id, ...t })}
            onRemove={(listId) => removeCompanyFromListAction({ companyId: id, id: listId })}
          />
        </Row>

        <Row label="First contacted by">
          <span className="block pt-1">{view.firstContacted}</span>
        </Row>
        <Row label="Created">
          <span className="block pt-1">{view.created}</span>
        </Row>

        <CustomFields view={view} />
      </dl>
    </PanelSection>
  );
}
