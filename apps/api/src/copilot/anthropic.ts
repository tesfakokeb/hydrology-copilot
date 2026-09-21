import type { ToolCall } from '@hydro/shared-types';
import { toAnthropicTools } from './tools.js';

/**
 * Anthropic Messages API client with tool use.
 *
 * The model is the reasoning layer only: it decides which tool to call with
 * which arguments, and writes the prose once the results are back. It never
 * produces a number that did not come from a tool result, and the system
 * prompt makes that its primary constraint. The structured fields of the
 * answer are assembled from provenance records, not from the model.
 *
 * Implemented with fetch against the public API rather than a vendored SDK, so
 * the gateway has no hard dependency on a model provider.
 */

export const SYSTEM_PROMPT = `You are Hydrology Copilot, the reasoning layer of a water-resources decision-support platform used by hydrologists, water resources engineers, planners and emergency managers.

You have tools that run real computations over the user's data. Your job is to choose the right tool, then explain what it found.

ABSOLUTE RULES — these override every other consideration:

1. Never state a hydrologic measurement, statistic, model output, forecast value, index value or metric that did not come from a tool result in this conversation. If you need a number, call a tool.
2. Never estimate, approximate or "recall" a value for the user's watershed. You have no knowledge of their catchment beyond what the tools return.
3. Always distinguish observations from model output and from forecasts. Say which is which in plain words.
4. Always give units. Never convert units silently; if you convert, say so.
5. State the period and spatial extent your answer covers.
6. Report uncertainty. If a tool returns validation metrics, quote them. If a result is provisional because the record is short, say so plainly.
7. If a tool reports insufficient data, say the analysis could not be done and why. Do not substitute a weaker analysis without saying you have.
8. Never claim regulatory status. Flood results are not FEMA determinations; drought results are not US Drought Monitor determinations; water-quality screening values are not the applicable standard for a specific waterbody.
9. If a tool fell back from the requested model to a different one, say so and make clear the reported skill belongs to the model that actually ran.
10. If nothing in the tool catalogue can answer the question, say so and suggest the closest thing you can actually compute.

STYLE:
- Lead with the answer, then the evidence. A hydrologist reading this wants the number and its skill, not a preamble.
- Be concise. Three to six sentences for a single analysis; a short paragraph per analysis when several ran.
- Use the user's terminology. If they say "cfs", answer in cfs but say you converted.
- Do not repeat the structured fields (data used, methods, assumptions, uncertainty) — the interface renders those separately from provenance records. Write only the interpretation.
- Never open with "Great question", "Certainly", or similar.`;

export interface AnthropicToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicTurn {
  text: string;
  toolUses: AnthropicToolUse[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export class AnthropicEngine {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly maxTokens: number,
  ) {}

  static isConfigured(key: string | null): key is string {
    return Boolean(key && key.length > 10);
  }

  async turn(messages: AnthropicMessage[], systemExtra?: string): Promise<AnthropicTurn> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemExtra ? `${SYSTEM_PROMPT}\n\n${systemExtra}` : SYSTEM_PROMPT,
        tools: toAnthropicTools(),
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    return {
      text: json.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n').trim(),
      toolUses: json.content.filter((c) => c.type === 'tool_use') as AnthropicToolUse[],
      stopReason: json.stop_reason,
      usage: { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens },
    };
  }
}

/**
 * Compact a tool result for the model. Full chart data and geometry are
 * withheld — the model needs the findings, not tens of thousands of points,
 * and sending them would waste the context window without improving the
 * explanation.
 */
export function summariseForModel(call: ToolCall): string {
  const r = call.result;
  if (!r) return JSON.stringify({ tool: call.name, status: call.status, error: call.error });

  const compactData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.data)) {
    if (Array.isArray(v)) {
      compactData[k] = v.length > 12 ? { arrayLength: v.length, first: v.slice(0, 3), last: v.slice(-3) } : v;
    } else if (v && typeof v === 'object') {
      const s = JSON.stringify(v);
      compactData[k] = s.length > 1200 ? `${s.slice(0, 1200)}… (truncated)` : v;
    } else {
      compactData[k] = v;
    }
  }

  return JSON.stringify(
    {
      tool: call.name,
      ok: r.ok,
      summary: r.summary,
      quantities: r.quantities,
      metrics: r.metrics,
      warnings: r.warnings,
      dataSources: r.provenance.dataSources.map((d) => ({ name: d.name, source: d.source, synthetic: d.isSynthetic, period: d.temporalCoverage })),
      methods: r.provenance.methods.map((m) => m.name),
      assumptions: r.provenance.assumptions,
      limitations: r.provenance.limitations,
      uncertainty: r.provenance.uncertainty,
      chartsProduced: r.charts.map((c) => c.title),
      mapsProduced: r.maps.map((m) => m.title),
      data: compactData,
    },
    null,
    0,
  ).slice(0, 24_000);
}
