import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@hydro/config';
import type {
  ChartSpec,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotIntent,
  MapSpec,
  ToolCall,
  ToolCallTraceStep,
} from '@hydro/shared-types';
import type { DataAccess } from '../store/types.js';
import type { ToolContext } from '../services/analysis/common.js';
import { AnthropicEngine, summariseForModel, type AnthropicMessage } from './anthropic.js';
import { composeDeterministicProse, composeScientificAnswer } from './composer.js';
import { EXECUTORS } from './registry.js';
import { route } from './router.js';
import { TOOLS_BY_NAME } from './tools.js';

export interface OrchestratorDeps {
  db: DataAccess;
  config: AppConfig;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  /** Streams tool progress to the client. */
  publish?: (event: { type: 'copilot.tool'; conversationId: string; toolName: string; status: string; detail: string | null }) => void;
}

/**
 * Copilot orchestration (§6).
 *
 *   user message → intent detection → tool selection → execution →
 *   results → visualisation + explanation → scientific answer
 *
 * Two reasoning engines sit behind the same pipeline. When an Anthropic API
 * key is configured the model selects tools and writes the prose; otherwise
 * the deterministic keyword router selects tools and the prose is composed
 * from tool summaries. Either way the tools that run, the results they
 * produce and the provenance they carry are identical, and the response says
 * which engine was used.
 */
export class CopilotOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  get engine(): 'anthropic' | 'deterministic-router' {
    return AnthropicEngine.isConfigured(this.deps.config.copilot.anthropicApiKey) ? 'anthropic' : 'deterministic-router';
  }

  async chat(req: CopilotChatRequest, userId: string, conversationId: string): Promise<CopilotChatResponse> {
    const project = await this.deps.db.getProject(req.projectId, userId);
    const watershedId = req.context?.watershedId ?? project?.defaultWatershedId ?? null;

    const toolCalls: ToolCall[] = [];
    const ctxFor = (toolName: string): ToolContext => ({
      db: this.deps.db,
      projectId: req.projectId,
      userId,
      watershedId,
      unitSystem: project?.unitSystem ?? 'SI',
      scienceServiceUrl: this.deps.config.scienceServiceUrl,
      log: this.deps.log,
      emit: (label, status, detail) => {
        const call = toolCalls.find((c) => c.name === toolName && c.status === 'running');
        call?.trace.push({ label, status, detail: detail ?? null, at: new Date().toISOString() });
        this.deps.publish?.({ type: 'copilot.tool', conversationId, toolName, status: label, detail: detail ?? null });
      },
    });

    const execute = async (name: string, args: Record<string, unknown>): Promise<ToolCall> => {
      const def = TOOLS_BY_NAME[name];
      const call: ToolCall = {
        id: randomUUID(),
        name,
        category: def?.category ?? 'statistics',
        arguments: args,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        trace: [],
        result: null,
        error: null,
      };
      toolCalls.push(call);
      this.deps.publish?.({ type: 'copilot.tool', conversationId, toolName: name, status: 'started', detail: null });

      const started = Date.now();
      const executor = EXECUTORS[name];
      if (!executor) {
        call.status = 'failed';
        call.error = `No executor is registered for tool "${name}".`;
        call.finishedAt = new Date().toISOString();
        call.durationMs = Date.now() - started;
        return call;
      }

      try {
        const result = await executor(ctxFor(name), args);
        call.result = result;
        call.status = result.ok ? 'succeeded' : 'failed';
        if (!result.ok) call.error = result.summary;
        await this.deps.db.saveProvenance(result.provenance).catch(() => undefined);
      } catch (err) {
        call.status = 'failed';
        call.error = (err as Error).message;
        this.deps.log.error({ err, tool: name }, 'Copilot tool execution failed');
      }
      call.finishedAt = new Date().toISOString();
      call.durationMs = Date.now() - started;
      call.trace.push({
        label: call.status === 'succeeded' ? 'Completed' : 'Failed',
        status: call.status === 'succeeded' ? 'ok' : 'fail',
        detail: call.result?.summary ?? call.error,
        at: call.finishedAt,
      } satisfies ToolCallTraceStep);
      this.deps.publish?.({ type: 'copilot.tool', conversationId, toolName: name, status: call.status, detail: call.result?.summary ?? call.error });
      return call;
    };

    let prose = '';
    let intent: CopilotIntent;
    let engineUsed: 'anthropic' | 'deterministic-router' = this.engine;
    const warnings: string[] = [];

    const plan = route(req.message, { datasetIds: req.datasetIds });

    if (engineUsed === 'anthropic') {
      try {
        const outcome = await this.runWithModel(req, execute, conversationId);
        prose = outcome.prose || composeDeterministicProse(req.message, toolCalls, plan.rationale);
        intent = outcome.intent ?? plan.intent;
        if (outcome.warnings.length) warnings.push(...outcome.warnings);
      } catch (err) {
        this.deps.log.warn({ err }, 'Anthropic engine failed; falling back to the deterministic router');
        warnings.push(
          `The language model could not be reached (${(err as Error).message}). The deterministic tool router was used instead — the analyses below are unaffected, but the explanation is composed from tool summaries rather than written by the model.`,
        );
        engineUsed = 'deterministic-router';
        intent = plan.intent;
        for (const c of plan.calls) if (!toolCalls.some((t) => t.name === c.name)) await execute(c.name, c.arguments);
        prose = composeDeterministicProse(req.message, toolCalls, plan.rationale);
      }
    } else {
      intent = plan.intent;
      if (plan.unmatched) {
        prose =
          'I could not match that request to any analysis I can actually run, so I have not produced an answer. ' +
          'I only report numbers that come from a computation over your data — I do not answer hydrologic questions from general knowledge. ' +
          'Try one of the suggested prompts, or ask about streamflow, drought, water quality, flooding, watershed characteristics, hydrologic modelling, water supply or water demand.';
      } else {
        for (const c of plan.calls) await execute(c.name, c.arguments);
        prose = composeDeterministicProse(req.message, toolCalls, plan.rationale);
      }
    }

    if (engineUsed === 'deterministic-router' && !plan.unmatched) {
      warnings.push(
        'No language model is configured (ANTHROPIC_API_KEY is not set), so tool selection used the deterministic keyword router and the explanation is composed from tool summaries. All scientific results are identical either way.',
      );
    }

    const charts: ChartSpec[] = toolCalls.flatMap((c) => c.result?.charts ?? []);
    const maps: MapSpec[] = toolCalls.flatMap((c) => c.result?.maps ?? []);
    const metrics: Record<string, number | null> = {};
    for (const c of toolCalls) for (const [k, v] of Object.entries(c.result?.metrics ?? {})) metrics[`${c.name}.${k}`] = v;

    const scientific = composeScientificAnswer(prose, toolCalls);

    return {
      conversationId,
      messageId: randomUUID(),
      answer: prose,
      scientific,
      intent,
      toolsUsed: toolCalls,
      dataSources: scientific.dataUsed,
      charts,
      maps,
      metrics,
      uncertainty: scientific.uncertainty,
      warnings: [...new Set([...warnings, ...toolCalls.flatMap((c) => c.result?.warnings ?? [])])],
      engine: engineUsed,
    };
  }

  /** Model-driven loop: the model picks tools, we run them, it explains. */
  private async runWithModel(
    req: CopilotChatRequest,
    execute: (name: string, args: Record<string, unknown>) => Promise<ToolCall>,
    _conversationId: string,
  ): Promise<{ prose: string; intent: CopilotIntent | null; warnings: string[] }> {
    const engine = new AnthropicEngine(
      this.deps.config.copilot.anthropicApiKey!,
      this.deps.config.copilot.model,
      this.deps.config.copilot.maxTokens,
    );

    const contextNote = [
      `Project: ${req.projectId}.`,
      req.context?.watershedId ? `Watershed: ${req.context.watershedId}.` : '',
      req.context?.startDate ? `Requested period: ${req.context.startDate} to ${req.context.endDate ?? 'end of record'}.` : '',
      req.datasetIds?.length ? `Datasets in scope: ${req.datasetIds.join(', ')}.` : '',
      'Today is ' + new Date().toISOString().slice(0, 10) + '.',
    ]
      .filter(Boolean)
      .join(' ');

    const messages: AnthropicMessage[] = [{ role: 'user', content: req.message }];
    const warnings: string[] = [];
    let prose = '';
    let intent: CopilotIntent | null = null;

    for (let i = 0; i < this.deps.config.copilot.maxToolIterations; i++) {
      const turn = await engine.turn(messages, contextNote);
      if (turn.text) prose = turn.text;

      if (turn.toolUses.length === 0) break;

      messages.push({
        role: 'assistant',
        content: [
          ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
          ...turn.toolUses.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
        ],
      });

      const toolResults: unknown[] = [];
      for (const use of turn.toolUses) {
        if (!EXECUTORS[use.name]) {
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool "${use.name}".` });
          continue;
        }
        intent = intent ?? TOOLS_BY_NAME[use.name]?.intent ?? null;
        const call = await execute(use.name, use.input ?? {});
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: call.status !== 'succeeded',
          content: summariseForModel(call),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (!prose) {
      warnings.push('The model returned no explanatory text; the deterministic summary of the tool results is shown instead.');
    }

    return { prose, intent, warnings };
  }
}
