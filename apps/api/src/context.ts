import type { AppConfig } from '@hydro/config';
import type { FastifyBaseLogger } from 'fastify';
import type { CopilotOrchestrator } from './copilot/orchestrator.js';
import type { JobQueue } from './jobs/queue.js';
import type { EventBus } from './plugins/ws.js';
import type { ScienceClient } from './services/science-client.js';
import type { StoreHandle } from './store/index.js';
import type { ToolContext } from './services/analysis/common.js';

export interface AppContext {
  config: AppConfig;
  store: StoreHandle;
  bus: EventBus;
  science: ScienceClient;
  copilot: CopilotOrchestrator;
  queue: JobQueue;
  log: FastifyBaseLogger;
}

/** Build the analysis tool context for a request. */
export async function toolContextFor(
  app: AppContext,
  projectId: string,
  userId: string | null,
  watershedId?: string | null,
): Promise<ToolContext> {
  const project = userId ? await app.store.db.getProject(projectId, userId) : null;
  return {
    db: app.store.db,
    projectId,
    userId,
    watershedId: watershedId ?? project?.defaultWatershedId ?? (await app.store.db.listWatersheds())[0]?.id ?? null,
    unitSystem: project?.unitSystem ?? 'SI',
    scienceServiceUrl: app.config.scienceServiceUrl,
    log: app.log,
    emit: (label, status, detail) => {
      app.bus.publish(projectId, { type: 'copilot.tool', conversationId: 'rest', toolName: 'rest', status: `${label}${status === 'ok' ? '' : ` (${status})`}`, detail: detail ?? null });
    },
  };
}
