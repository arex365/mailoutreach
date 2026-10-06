import type { Metadata } from "next";
import { FlaskConical } from "lucide-react";
import { requireOwner } from "@/lib/auth/dal";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/campaigns/notice";
import { AiPausedCard } from "@/components/ai/ai-paused-card";
import { SettingsTitle } from "@/components/settings/settings-title";
import { AiLimitForm } from "@/components/settings/ai/ai-limit-form";
import { AiModelForm } from "@/components/settings/ai/ai-model-form";
import { AiPricesForm } from "@/components/settings/ai/ai-prices-form";
import { AnthropicKeyForm } from "@/components/settings/ai/anthropic-key-form";
import { AI_CARD_DESCRIPTIONS, AI_SETTINGS_PAGE } from "@/components/settings/ai/texts";
import { AI_SETTINGS_TEXT, loadAiSettings } from "@/server/services/ai/settings";

export const metadata: Metadata = { title: "AI" };

/**
 * Settings › AI (Owner, docs/dev/M5-DESIGN.md §6.9): the test-server banner in fake mode, the pause card (Resume
 * drafting is the page's primary action while paused), the Anthropic key (Save key is primary otherwise), the model
 * with this app's estimate per 300 companies, the monthly limit with this month's spend, the prices, and how websites
 * are read.
 */
export default async function AiSettingsPage() {
  const user = await requireOwner();
  const view = await loadAiSettings(user.timeZone);

  return (
    <div>
      <SettingsTitle title={AI_SETTINGS_PAGE.title} description={AI_SETTINGS_PAGE.description} />
      <div className="grid gap-6">
        {view.fakeBanner ? (
          <Notice tone="warning">
            <p className="flex items-start gap-2">
              <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
              {view.fakeBanner}
            </p>
          </Notice>
        ) : null}

        {view.pause ? <AiPausedCard text={view.pause.text} isOwner /> : null}

        <Card>
          <CardHeader>
            <CardTitle>{AI_SETTINGS_PAGE.keyTitle}</CardTitle>
            <CardDescription>{AI_SETTINGS_PAGE.keyDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <AnthropicKeyForm
              keyView={view.key}
              practiceLine={view.practiceCopy ? AI_SETTINGS_TEXT.practiceCopy : null}
              primary={!view.pause}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{AI_SETTINGS_PAGE.modelTitle}</CardTitle>
            <CardDescription>{AI_SETTINGS_PAGE.modelDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <AiModelForm choice={view.model.choice} radios={view.radios} custom={view.custom} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{AI_SETTINGS_PAGE.limitTitle}</CardTitle>
            <CardDescription>{AI_CARD_DESCRIPTIONS.limit}</CardDescription>
          </CardHeader>
          <CardContent>
            <AiLimitForm usd={view.limit.usd} spentLine={view.limit.spentLine} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{AI_SETTINGS_PAGE.pricesTitle}</CardTitle>
            <CardDescription>{AI_CARD_DESCRIPTIONS.prices}</CardDescription>
          </CardHeader>
          <CardContent>
            <AiPricesForm rows={view.prices} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{AI_SETTINGS_PAGE.readingTitle}</CardTitle>
            <CardDescription>{AI_CARD_DESCRIPTIONS.reading}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{AI_SETTINGS_PAGE.readingText}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
