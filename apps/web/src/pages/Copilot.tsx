import type { CopilotChatResponse, ToolCall } from '@hydro/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ChartRenderer } from '@/components/ChartRenderer';
import { MapRenderer } from '@/components/MapRenderer';
import { ProvenancePanel } from '@/components/ProvenancePanel';
import { Card, EmptyState, PageHeader, Spinner, StatusPill, WarningList } from '@/components/ui';
import { api } from '@/services/api';
import { useApp } from '@/stores/app';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  response?: CopilotChatResponse;
  pending?: boolean;
}

export function Copilot() {
  const { projectId, watershedId, pushToast } = useApp();
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>();
  const bottom = useRef<HTMLDivElement>(null);

  const tools = useQuery({ queryKey: ['copilot-tools'], queryFn: api.copilotTools });
  const conversations = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => api.conversations(projectId ?? undefined),
    enabled: Boolean(projectId),
  });

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const chat = useMutation({
    mutationFn: (message: string) =>
      api.copilotChat({
        projectId: projectId!,
        message,
        conversationId,
        context: watershedId ? { watershedId } : undefined,
      }),
    onSuccess: (response) => {
      setConversationId(response.conversationId);
      setTurns((prev) => [
        ...prev.filter((t) => !t.pending),
        { id: response.messageId, role: 'assistant', content: response.answer, response },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (error) => {
      setTurns((prev) => prev.filter((t) => !t.pending));
      pushToast({ kind: 'error', title: 'The Copilot could not answer', body: error instanceof Error ? error.message : String(error) });
    },
  });

  const send = (message: string) => {
    if (!message.trim() || !projectId || chat.isPending) return;
    setTurns((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: message },
      { id: `p-${Date.now()}`, role: 'assistant', content: '', pending: true },
    ]);
    setInput('');
    chat.mutate(message);
  };

  const loadConversation = async (id: string) => {
    const { messages } = await api.conversation(id);
    setConversationId(id);
    setTurns(
      messages.map((m) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        response: m.role === 'assistant'
          ? ({
              conversationId: id,
              messageId: m.id,
              answer: m.content,
              scientific: m.scientific!,
              intent: m.intent ?? 'explanation',
              toolsUsed: m.toolCalls ?? [],
              dataSources: m.scientific?.dataUsed ?? [],
              charts: m.charts ?? [],
              maps: m.maps ?? [],
              metrics: {},
              uncertainty: m.scientific?.uncertainty ?? '',
              warnings: m.warnings ?? [],
              engine: m.engine ?? 'deterministic-router',
            } satisfies CopilotChatResponse)
          : undefined,
      })),
    );
  };

  return (
    <>
      <PageHeader
        title="Hydrology Copilot"
        description="Ask a hydrology question in plain language. The Copilot selects and runs analytical tools over your data, then explains the result. It does not answer from general knowledge — every number comes from a computation you can inspect."
        actions={
          tools.data && (
            <>
              <StatusPill status={tools.data.engine === 'anthropic' ? 'normal' : 'info'}>
                Engine: {tools.data.engine === 'anthropic' ? 'language model + tools' : 'deterministic router + tools'}
              </StatusPill>
              <StatusPill status="info" dot={false}>
                {tools.data.tools.filter((t) => t.executable).length} tools available
              </StatusPill>
            </>
          )
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          {turns.length === 0 && (
            <Card title="Start with a question" subtitle="These prompts each map to a tool the Copilot can actually run">
              <div className="flex flex-wrap gap-2">
                {(tools.data?.suggestedPrompts ?? []).map((p) => (
                  <button key={p} type="button" className="btn btn-secondary" onClick={() => send(p)}>
                    {p}
                  </button>
                ))}
              </div>
              <p className="mt-4 text-xs leading-relaxed text-ink-600">
                The Copilot understands questions about streamflow, drought, water quality, flooding, watershed
                characteristics, hydrologic modelling, water supply and water demand. It will tell you when it cannot answer
                rather than guessing.
              </p>
            </Card>
          )}

          {turns.map((turn) =>
            turn.role === 'user' ? (
              <div key={turn.id} className="flex justify-end">
                <p className="max-w-[42rem] rounded-lg rounded-br-sm bg-hydro-600 px-3.5 py-2 text-sm text-white shadow-card">
                  {turn.content}
                </p>
              </div>
            ) : turn.pending ? (
              <Card key={turn.id}>
                <div className="flex items-center gap-2 text-xs text-ink-600">
                  <Spinner />
                  Selecting tools and running the analysis…
                </div>
              </Card>
            ) : (
              <AssistantTurn key={turn.id} response={turn.response!} />
            ),
          )}

          <div ref={bottom} />

          <form
            className="sticky bottom-0 rounded-lg border border-ink-200 bg-white p-2 shadow-panel"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <div className="flex items-end gap-2">
              <textarea
                className="input min-h-[2.5rem] resize-y border-0 !py-2 focus:ring-0"
                rows={2}
                placeholder="e.g. Forecast streamflow for the next 7 days, or Is this watershed experiencing drought?"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                disabled={chat.isPending}
              />
              <button type="submit" className="btn btn-primary !py-2" disabled={chat.isPending || !input.trim()}>
                {chat.isPending && <Spinner />}
                Ask
              </button>
            </div>
          </form>
        </div>

        <aside className="space-y-4">
          <Card title="Conversations" bodyClassName="p-2">
            {conversations.data && conversations.data.length > 0 ? (
              <ul className="space-y-1">
                {conversations.data.slice(0, 12).map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => void loadConversation(c.id)}
                      className={`w-full truncate rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        conversationId === c.id ? 'bg-hydro-50 text-hydro-900' : 'text-ink-700 hover:bg-ink-50'
                      }`}
                    >
                      <span className="block truncate">{c.title}</span>
                      <span className="block text-2xs text-ink-400">
                        {c.messageCount} messages · {new Date(c.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-3 text-xs text-ink-500">No conversations yet.</p>
            )}
            {turns.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary mt-2 w-full justify-center"
                onClick={() => {
                  setTurns([]);
                  setConversationId(undefined);
                }}
              >
                New conversation
              </button>
            )}
          </Card>

          <Card title="Tool catalogue" subtitle="What the Copilot can actually run" bodyClassName="p-2">
            <ul className="max-h-[26rem] space-y-1 overflow-y-auto">
              {(tools.data?.tools ?? []).map((t) => (
                <li key={t.name} className="rounded px-2 py-1.5 hover:bg-ink-50">
                  <div className="flex items-center gap-1.5">
                    <code className="font-mono text-[10px] text-ink-800">{t.name}</code>
                    {t.requiresIntegration && (
                      <span className="chip border-amber-200 bg-amber-50 !px-1 !py-0 text-[9px] text-amber-800">integration</span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-ink-500">{t.description}</p>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}

function AssistantTurn({ response }: { response: CopilotChatResponse }) {
  const s = response.scientific;
  return (
    <div className="space-y-3">
      <Card bodyClassName="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status="info" dot={false}>
            {response.intent.replace(/_/g, ' ')}
          </StatusPill>
          <StatusPill status={response.engine === 'anthropic' ? 'normal' : 'unknown'} dot={false}>
            {response.engine === 'anthropic' ? 'model-composed' : 'router-composed'}
          </StatusPill>
        </div>

        <ToolTrace calls={response.toolsUsed} />

        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{response.answer}</p>

        <WarningList warnings={response.warnings} />

        {s && (
          <div className="grid grid-cols-1 gap-3 rounded-md border border-ink-200 bg-ink-50/60 p-3 md:grid-cols-2">
            <Field title="Data used" items={s.dataUsed} />
            <Field title="Methods" items={s.methods} />
            <Field title="Period" items={s.timePeriod ? [s.timePeriod] : []} />
            <Field title="Spatial extent" items={s.spatialExtent ? [s.spatialExtent] : []} />
            <Field title="Assumptions" items={s.assumptions} />
            <Field title="Uncertainty" items={s.uncertainty ? [s.uncertainty] : []} />
            {s.results.length > 0 && (
              <div className="md:col-span-2">
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Results</p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
                  {s.results.slice(0, 12).map((r, i) => (
                    <div key={i} className="rounded border border-ink-200 bg-white px-2 py-1">
                      <p className="truncate text-[10px] text-ink-500" title={r.label}>
                        {r.label}
                      </p>
                      <p className="text-xs font-semibold tabular text-ink-900">{r.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {s.recommendations.length > 0 && (
              <div className="md:col-span-2">
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Suggested next steps</p>
                <ul className="list-disc space-y-1 pl-4">
                  {s.recommendations.map((r, i) => (
                    <li key={i} className="text-2xs leading-relaxed text-ink-700">
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      {response.charts.map((c) => (
        <Card key={c.id}>
          <ChartRenderer spec={c} />
        </Card>
      ))}

      {response.maps.map((m) => (
        <Card key={m.id}>
          <MapRenderer spec={m} />
        </Card>
      ))}

      {response.toolsUsed
        .filter((t) => t.result)
        .map((t) => (
          <ProvenancePanel key={t.id} record={t.result!.provenance} />
        ))}
    </div>
  );
}

function Field({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">{title}</p>
      <ul className="space-y-0.5">
        {items.slice(0, 6).map((it, i) => (
          <li key={i} className="text-2xs leading-relaxed text-ink-700">
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** §38: tool execution is shown transparently, step by step. */
function ToolTrace({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="rounded-md border border-ink-200 bg-ink-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-200">
      {calls.map((call) => (
        <div key={call.id} className="mb-1.5 last:mb-0">
          <p className="text-hydro-300">
            {call.status === 'succeeded' ? '✓' : call.status === 'failed' ? '✕' : '…'} {call.name}
            <span className="ml-2 text-ink-500">
              {Object.entries(call.arguments)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(' ')}
            </span>
            {call.durationMs !== null && <span className="ml-2 text-ink-500">{call.durationMs} ms</span>}
          </p>
          {call.trace.map((step, i) => (
            <p key={i} className="pl-3 text-ink-400">
              <span className={step.status === 'ok' ? 'text-emerald-400' : step.status === 'warn' ? 'text-amber-400' : 'text-red-400'}>
                {step.status === 'ok' ? '✓' : step.status === 'warn' ? '!' : '✕'}
              </span>{' '}
              {step.label}
              {step.detail && <span className="text-ink-500"> — {step.detail}</span>}
            </p>
          ))}
          {call.error && <p className="pl-3 text-red-400">✕ {call.error}</p>}
        </div>
      ))}
    </div>
  );
}
