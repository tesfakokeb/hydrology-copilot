import type { CopilotIntent, ToolDefinition } from '@hydro/shared-types';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';

/**
 * Deterministic intent router.
 *
 * This is the fallback reasoning layer used when no language model is
 * configured, and it is also the safety net when the model returns no tool
 * call. It is intentionally transparent: keyword scoring over the same tool
 * catalogue the model sees, plus explicit argument extraction. Being
 * deterministic, it is fully reproducible and costs nothing to run — which is
 * why the platform is useful out of the box with no API key.
 */

export interface RoutedPlan {
  intent: CopilotIntent;
  calls: { name: string; arguments: Record<string, unknown>; score: number; matched: string[] }[];
  unmatched: boolean;
  rationale: string;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'for', 'to', 'and', 'is', 'are', 'my', 'our', 'this', 'that', 'what', 'how', 'me', 'please', 'can', 'you', 'show', 'give']);

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9%.\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Score a tool against the message by keyword and name overlap. */
function scoreTool(tool: ToolDefinition, text: string): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];
  for (const kw of tool.keywords) {
    if (text.includes(kw)) {
      // Longer phrases are stronger evidence than single words.
      score += 1 + kw.split(' ').length * 0.75 + kw.length * 0.02;
      matched.push(kw);
    }
  }
  const nameWords = tool.name.split('_').filter((w) => !STOPWORDS.has(w));
  for (const w of nameWords) if (w.length > 3 && text.includes(w)) score += 0.6;
  return { score, matched };
}

/** Extract explicit arguments from the message text. */
export function extractArguments(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  // Forecast horizon: "next 7 days", "7-day", "14 day forecast", "30 days"
  const horizon = text.match(/(?:next\s+)?(\d{1,3})[\s-]*(day|days|d)\b/);
  if (horizon) args.horizonDays = Number(horizon[1]);
  if (/\bnext week\b/.test(text)) args.horizonDays = 7;
  if (/\btomorrow\b/.test(text)) args.horizonDays = 1;

  // Months for demand / drought horizons
  const months = text.match(/(\d{1,3})\s*month/);
  if (months) {
    args.horizonMonths = Number(months[1]);
    args.timescaleMonths = Number(months[1]);
  }

  // Index timescale: "SPI-12", "SPI 3", "SPEI-6"
  const spi = text.match(/\bspe?i[\s-]*(\d{1,2})\b/);
  if (spi) args.timescaleMonths = Number(spi[1]);

  // Return period: "100-year", "1% annual chance"
  const rp = text.match(/(\d{1,4})[\s-]*(?:year|yr)\b/);
  if (rp) args.returnPeriodYears = Number(rp[1]);
  if (/\b1\s*%|\bone percent\b/.test(text)) args.returnPeriodYears = 100;
  if (/\b0\.2\s*%/.test(text)) args.returnPeriodYears = 500;

  // Explicit discharge for a return-period query
  const q = text.match(/(\d[\d,]*\.?\d*)\s*(?:m3\/s|m³\/s|cms|cfs|ft3\/s)/);
  if (q) {
    const value = Number(q[1].replace(/,/g, ''));
    args.discharge = /cfs|ft3/.test(q[0]) ? value * 0.028316846592 : value;
  }

  // Forecast model
  for (const [pattern, model] of [
    [/\bxgboost\b/, 'xgboost'],
    [/\brandom forest\b/, 'random_forest'],
    [/\blstm\b/, 'lstm'],
    [/\bgru\b/, 'gru'],
    [/\btft\b|temporal fusion/, 'tft'],
    [/\bsarima\b/, 'sarima'],
    [/\barima\b/, 'arima'],
    [/\bpersistence\b/, 'persistence'],
    [/\bclimatolog/, 'climatology'],
    [/\bmoving average\b/, 'moving_average'],
  ] as [RegExp, string][]) {
    if (pattern.test(text)) args.model = model;
  }

  // Model engine
  for (const [pattern, engine] of [
    [/\bhec[\s-]?hms\b/, 'HEC-HMS'],
    [/\bhec[\s-]?ras\b/, 'HEC-RAS'],
    [/\bswat\+|\bswat plus\b/, 'SWAT+'],
    [/\bswat\b/, 'SWAT'],
    [/\bmodflow\b/, 'MODFLOW'],
    [/\bgr4j\b/, 'GR4J'],
  ] as [RegExp, string][]) {
    if (pattern.test(text)) args.engine = engine;
  }

  // Scenario
  for (const [pattern, scenario] of [
    [/\bextreme drought\b/, 'extreme_drought'],
    [/\bdrought scenario\b|\bdry year\b|\bunder drought\b/, 'dry'],
    [/\bclimate change\b/, 'climate_change'],
    [/\bpopulation growth\b/, 'population_growth'],
    [/\bconservation\b/, 'conservation'],
    [/\bhigh demand\b/, 'high_demand'],
    [/\bwet year\b/, 'wet'],
  ] as [RegExp, string][]) {
    if (pattern.test(text)) args.scenario = scenario;
  }

  // Demand sector
  if (/\bmunicipal\b/.test(text)) args.sector = 'municipal';
  else if (/\bagricultur|\birrigation\b/.test(text)) args.sector = 'agricultural';
  else if (/\bindustrial\b/.test(text)) args.sector = 'industrial';

  // Report kind
  if (/\breport\b/.test(text)) {
    if (/\bdrought\b/.test(text)) args.kind = 'drought_assessment';
    else if (/\bflood\b/.test(text)) args.kind = 'flood_risk';
    else if (/\bwater quality\b/.test(text)) args.kind = 'water_quality';
    else if (/\bsupply\b/.test(text)) args.kind = 'water_supply_planning';
    else if (/\bdemand\b/.test(text)) args.kind = 'water_demand_forecast';
    else args.kind = 'hydrology_assessment';
  }

  // Dates: YYYY-MM-DD pairs, or "since 2010", "from 2000 to 2020"
  const isoDates = text.match(/\d{4}-\d{2}-\d{2}/g);
  if (isoDates && isoDates.length >= 1) args.startDate = isoDates[0];
  if (isoDates && isoDates.length >= 2) args.endDate = isoDates[1];
  const range = text.match(/\b(19|20)\d{2}\s*(?:to|[-–])\s*((19|20)\d{2})\b/);
  if (range) {
    args.startDate = `${range[0].slice(0, 4)}-01-01`;
    args.endDate = `${range[2]}-12-31`;
  }
  const last = text.match(/last\s+(\d{1,3})\s+year/);
  if (last) {
    const y = Number(last[1]);
    const end = new Date();
    const start = new Date(end.getTime() - y * 365.25 * 86400000);
    args.startDate = start.toISOString().slice(0, 10);
  }

  // Water-quality parameters
  const params: string[] = [];
  const paramMap: [RegExp, string][] = [
    [/\bnitrate\b/, 'nitrate'],
    [/\bdissolved oxygen\b|\bdo\b/, 'dissolved_oxygen'],
    [/\bturbidity\b/, 'turbidity'],
    [/\bph\b/, 'ph'],
    [/\bconductivity\b/, 'conductivity'],
    [/\be\.?\s?coli\b/, 'e_coli'],
    [/\bphosph/, 'phosphate'],
    [/\bammonia\b/, 'ammonia'],
    [/\bchlorophyll\b/, 'chlorophyll_a'],
    [/\bsediment\b|\btss\b/, 'tss'],
    [/\btemperature\b/, 'temperature'],
  ];
  for (const [re, name] of paramMap) if (re.test(text)) params.push(name);
  if (params.length > 0) args.parameters = params;

  return args;
}

const INTENT_HINTS: [RegExp, CopilotIntent][] = [
  [/\bforecast|predict|outlook|next \d+ (day|week|month)|will (the|it|we)\b/, 'forecasting'],
  [/\breport\b|\bwrite up\b|\bdeliverable\b/, 'report_generation'],
  [/\bmap\b|\bspatial\b|\bwhere\b|\bgis\b|\bnearest\b/, 'gis_analysis'],
  [/\brun (the|a|my)? ?model|simulate|calibrat/, 'hydrologic_modeling'],
  [/\bshow me\b|\bplot\b|\bchart\b|\bgraph\b|\bvisuali[sz]e\b/, 'visualization'],
  [/\bwhat (is|are)\b|\bhow (much|many)\b|\bgive me\b|\blist\b/, 'data_retrieval'],
];

/** Route a natural-language message to a plan of tool calls. */
export function route(message: string, context?: { datasetIds?: string[] }): RoutedPlan {
  const text = normalise(message);
  const extracted = extractArguments(text);

  const scored = TOOLS.map((t) => ({ tool: t, ...scoreTool(t, text) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      intent: 'unsupported',
      calls: [],
      unmatched: true,
      rationale:
        'No tool in the catalogue matched the request. The Copilot answers questions it can support with an actual computation; it does not answer hydrologic questions from memory.',
    };
  }

  // Take the leading tool plus any tool within 55 % of its score, capped at
  // three, so that a compound request ("assess drought and forecast flow")
  // runs both analyses without the plan sprawling.
  const top = scored[0];
  const selected = scored.filter((s) => s.score >= top.score * 0.55).slice(0, 3);

  // Deduplicate near-identical tools that share an executor path.
  const seenCategories = new Set<string>();
  const calls = selected
    .filter((s) => {
      const key = `${s.tool.category}:${s.tool.intent}`;
      if (seenCategories.has(key) && s !== top) return false;
      seenCategories.add(key);
      return true;
    })
    .map((s) => ({
      name: s.tool.name,
      arguments: filterArgs(s.tool.name, extracted),
      score: Number(s.score.toFixed(2)),
      matched: s.matched,
    }));

  let intent = top.tool.intent;
  for (const [re, hinted] of INTENT_HINTS) {
    if (re.test(text)) {
      intent = hinted;
      break;
    }
  }

  return {
    intent,
    calls,
    unmatched: false,
    rationale:
      `Matched "${top.tool.name}" on ${top.matched.map((m) => `"${m}"`).join(', ')} (score ${top.score.toFixed(2)})` +
      (calls.length > 1 ? `, together with ${calls.slice(1).map((c) => `"${c.name}"`).join(' and ')}.` : '.'),
  };
}

/** Keep only the arguments a given tool actually declares. */
function filterArgs(toolName: string, extracted: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS_BY_NAME[toolName];
  if (!def) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(def.parameters.properties)) {
    if (extracted[key] !== undefined) out[key] = extracted[key];
  }
  return out;
}
