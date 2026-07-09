/**
 * Chronicle command orchestrator (issue #40).
 *
 * Ties together the selector + aggregator + LLM prompt into a single
 * `runChronicle` function that both the CLI and tests can drive.
 *
 * Offline mode still runs the real selector/aggregator; only the narrative
 * generation is swapped for a deterministic canned template. This keeps
 * the offline output honest about what the cohort actually looked like
 * (per the AC: "canned narrative that still consumes real aggregates so
 * the shape is honest").
 */

import type { LlmClient } from "../llm/client.js";
import { assembleChroniclePrompt } from "../llm/prompts.js";
import type { Persona } from "../personas/types.js";
import type { HistoryRow } from "../history.js";
import type { ChronicleAggregate } from "./aggregate.js";
import type { ChronicleSelectionSummary } from "./select.js";

export interface ChronicleRunOptions {
  aggregate: ChronicleAggregate;
  selection: ChronicleSelectionSummary;
  persona: Persona;
  client: LlmClient;
  offline: boolean;
}

export interface ChronicleReading {
  narrative: string;
  channel: string;
}

/**
 * Deterministic offline template. Consumes the *real* aggregate so the
 * shape of the reading matches what the caller actually selected.
 */
export function renderOfflineChronicle(args: {
  aggregate: ChronicleAggregate;
  selection: ChronicleSelectionSummary;
  persona: Persona;
}): string {
  const { aggregate, selection, persona } = args;
  const cohortLine = `⚱️ The gathering: ${selection.count} reading${selection.count === 1 ? "" : "s"} via ${selection.strategy}, dominant method ${aggregate.dominantMethod ?? "unknown"}.`;
  const omenLines = aggregate.omens.length > 0
    ? aggregate.omens.slice(0, 3).map((o) => {
        const label = o.name ? `${o.name} (${o.id})` : o.id;
        return `🕯️ ${label} appeared ${o.count}× — the sign returns; heed its rhythm.`;
      }).join("\n")
    : "🕯️ Recurring omens: none. The deck refuses to repeat itself for this cohort.";
  const weatherLine = aggregate.weather
    ? `🌗 The team's weather runs ${aggregate.weather.moodLabel} (${aggregate.weather.approvals} approvals, ${aggregate.weather.changesRequested} pushbacks, ${aggregate.weather.commented} musings).`
    : "🌗 The team's weather is unrecorded — no reviewer signal in this cohort.";
  const outcomeSummary = Object.entries(aggregate.outcomeTallies)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "no outcomes recorded";
  const chronicleParas = [
    `📜 In the span consulted, ${persona.name} watched the deck fall across ${aggregate.methodTallies.length} method${aggregate.methodTallies.length === 1 ? "" : "s"}. Outcomes: ${outcomeSummary}.`,
    aggregate.dominantMethod
      ? `📜 The ${aggregate.dominantMethod} thread ran hottest, and the omens above kept surfacing — a pattern the walls remember even when the reviewers forget.`
      : "📜 No single method dominated; the readings drifted, and so did the fates.",
  ].join("\n");
  const prophecy = aggregate.omens.length > 0
    ? `🔮 The prophecy: the next cycle will echo ${aggregate.omens[0].name ?? aggregate.omens[0].id}; prepare accordingly.`
    : "🔮 The prophecy: a novel omen approaches; treat the next reading as first-of-its-kind.";
  return [cohortLine, omenLines, weatherLine, chronicleParas, prophecy].join("\n");
}

export async function runChronicle(opts: ChronicleRunOptions): Promise<ChronicleReading> {
  const { aggregate, selection, persona, client, offline } = opts;
  if (offline) {
    return {
      narrative: renderOfflineChronicle({ aggregate, selection, persona }),
      channel: client.id,
    };
  }
  let messages = assembleChroniclePrompt({
    aggregate: {
      readings: aggregate.readings,
      dominantMethod: aggregate.dominantMethod,
      dominantPersona: aggregate.dominantPersona,
      methodTallies: aggregate.methodTallies,
      outcomeTallies: aggregate.outcomeTallies,
      omens: aggregate.omens.map((o) => ({
        id: o.id, name: o.name, count: o.count, frequency: o.frequency, methods: o.methods,
      })),
      weather: aggregate.weather
        ? {
            moodLabel: aggregate.weather.moodLabel,
            totalReviews: aggregate.weather.totalReviews,
            approvals: aggregate.weather.approvals,
            changesRequested: aggregate.weather.changesRequested,
            commented: aggregate.weather.commented,
          }
        : null,
      repos: aggregate.repos,
      selection: {
        strategy: selection.strategy,
        count: selection.count,
        dateRange: selection.dateRange,
      },
    },
  });
  if (persona.systemPrompt.trim()) {
    messages = [...messages, { role: "system", content: `Persona — ${persona.name}: ${persona.systemPrompt}` }];
  }
  const text = await client.complete(messages);
  return { narrative: text, channel: client.id };
}

/**
 * Human-friendly terminal render for the chronicle. Kept separate from
 * `runChronicle` so the CLI can also emit `--json` cheaply.
 */
export function renderChronicleCard(args: {
  aggregate: ChronicleAggregate;
  selection: ChronicleSelectionSummary;
  persona: Persona;
  reading: ChronicleReading;
}): string {
  const { aggregate, selection, persona, reading } = args;
  const header = [
    `🔮 chronicle`,
    `   strategy: ${selection.strategy}`,
    `   readings: ${selection.count}`,
    selection.dateRange.earliest
      ? `   range: ${selection.dateRange.earliest} → ${selection.dateRange.latest}`
      : "   range: (empty)",
    aggregate.dominantMethod ? `   dominant method: ${aggregate.dominantMethod}` : "",
    `   persona: ${persona.name}`,
    `   channel: ${reading.channel}`,
  ].filter(Boolean).join("\n");
  return `${header}\n\n${reading.narrative}\n`;
}

/**
 * JSON shape for `--json` output. Kept flat + documented so bots can rely
 * on the layout without cracking the DB open themselves.
 */
export function chronicleJsonBlob(args: {
  aggregate: ChronicleAggregate;
  selection: ChronicleSelectionSummary;
  persona: Persona;
  reading: ChronicleReading;
  rows: HistoryRow[];
}) {
  const { aggregate, selection, persona, reading, rows } = args;
  return {
    persona: persona.id,
    channel: reading.channel,
    chronicle: {
      selection,
      omens: aggregate.omens,
      weather: aggregate.weather,
      narrative: reading.narrative,
      prophecy: extractProphecy(reading.narrative),
    },
    aggregates: {
      methodTallies: aggregate.methodTallies,
      personaTallies: aggregate.personaTallies,
      outcomeTallies: aggregate.outcomeTallies,
      repos: aggregate.repos,
    },
    consulted: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      repo: r.repo,
      prNumber: r.prNumber,
      methodId: r.methodId,
      personaId: r.personaId,
      outcome: r.outcome,
    })),
  };
}

/**
 * Best-effort prophecy extractor: pulls the last "🔮 …" line from the
 * narrative so bots can surface it in isolation (e.g. release notes).
 * Returns null when there's no prophecy line.
 */
export function extractProphecy(narrative: string): string | null {
  const lines = narrative.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("🔮")) return lines[i].replace(/^🔮\s*(The prophecy[:\s]*)?/, "").trim();
  }
  return null;
}
