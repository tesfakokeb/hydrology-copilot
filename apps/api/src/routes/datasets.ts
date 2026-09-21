import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatasetFormat, DatasetProfile } from '@hydro/shared-types';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { BINARY_FORMATS, binaryFormatProfile, profileDelimited, TEXT_FORMATS } from '../services/profiler.js';
import { storage } from '../services/storage.js';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const EXTENSION_FORMATS: Record<string, DatasetFormat> = {
  csv: 'csv', txt: 'csv', tsv: 'csv', rdb: 'csv',
  xlsx: 'xlsx', xls: 'xlsx',
  nc: 'netcdf', nc4: 'netcdf', cdf: 'netcdf',
  tif: 'geotiff', tiff: 'geotiff',
  geojson: 'geojson', json: 'json',
  shp: 'shapefile', zip: 'shapefile',
  parquet: 'parquet',
};

export function formatFromFilename(filename: string): DatasetFormat {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_FORMATS[ext] ?? 'csv';
}

export async function datasetRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const auth = { preHandler: [app.authenticate] };

  app.get('/api/datasets', { ...auth, schema: { tags: ['datasets'], summary: 'List datasets in a project.' } }, async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId ?? (await ctx.store.db.listProjects(req.user!.id))[0]?.id ?? '';
    return { data: await ctx.store.db.listDatasets(projectId) };
  });

  app.get('/api/datasets/:id', { ...auth, schema: { tags: ['datasets'], summary: 'Dataset metadata and profile.' } }, async (req, reply) => {
    const ds = await ctx.store.db.getDataset((req.params as { id: string }).id);
    if (!ds) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No dataset with that identifier.' } });
    return { data: ds };
  });

  app.get('/api/datasets/:id/preview', { ...auth, schema: { tags: ['datasets'], summary: 'First rows of a stored delimited dataset.' } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ds = await ctx.store.db.getDataset(id);
    if (!ds) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No dataset with that identifier.' } });
    const content = await storage.readText(ds.storageUri);
    if (content === null) {
      return reply.code(409).send({
        error: { code: 'NO_PREVIEW', message: 'This dataset has no stored text content to preview. Synthetic demonstration series are generated in memory and are available through /api/series instead.' },
      });
    }
    const limit = Number((req.query as { rows?: string }).rows ?? 50);
    return { data: { lines: content.split(/\r?\n/).slice(0, limit + 1) } };
  });

  app.post('/api/datasets/upload', {
    preHandler: [app.authenticate, requireRole('analyst')],
    schema: { tags: ['datasets'], summary: 'Upload a dataset. Delimited text is profiled immediately; binary scientific formats are stored and profiled by the Python service.' },
  }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) return reply.code(400).send({ error: { code: 'NO_FILE', message: 'Attach a file in a multipart/form-data field named "file".' } });

    const projectId = (file.fields?.projectId as { value?: string })?.value ?? (await ctx.store.db.listProjects(req.user!.id))[0]?.id ?? '';
    const description = (file.fields?.description as { value?: string })?.value ?? null;
    const source = (file.fields?.source as { value?: string })?.value ?? 'User upload';

    const buffer = await file.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: { code: 'EMPTY_FILE', message: 'The uploaded file is empty.' } });

    const format = formatFromFilename(file.filename);
    const datasetId = randomUUID();
    const storageUri = await storage.write(`${projectId}/${datasetId}/${file.filename}`, buffer);

    let profile: DatasetProfile;
    if (TEXT_FORMATS.includes(format)) {
      profile = profileDelimited(buffer.toString('utf8'), { name: file.filename, format, datasetId });
    } else if (BINARY_FORMATS.includes(format)) {
      const remote = await ctx.science.profileDataset({ filename: file.filename, contentBase64: buffer.toString('base64') });
      profile = remote
        ? ({ ...(remote as unknown as DatasetProfile), datasetId, name: file.filename, format })
        : binaryFormatProfile({ name: file.filename, format, datasetId }, ctx.science.configured);
    } else {
      profile = binaryFormatProfile({ name: file.filename, format, datasetId }, ctx.science.configured);
    }

    const dataset = await ctx.store.db.createDataset({
      projectId,
      name: file.filename,
      description,
      format,
      source,
      sourceUrl: null,
      version: '1',
      storageUri,
      sizeBytes: buffer.length,
      isSynthetic: false,
      uploadedBy: req.user!.id,
      profile,
    });

    ctx.bus.publish(projectId, { type: 'alert', severity: 'info', title: 'Dataset uploaded', body: `${file.filename} (${(buffer.length / 1024).toFixed(0)} kB) was uploaded and profiled.` });
    return reply.code(201).send({ data: dataset });
  });

  app.delete('/api/datasets/:id', { preHandler: [app.authenticate, requireRole('analyst')], schema: { tags: ['datasets'], summary: 'Delete an uploaded dataset.' } }, async (req, reply) => {
    const okDeleted = await ctx.store.db.deleteDataset((req.params as { id: string }).id);
    if (!okDeleted) {
      return reply.code(409).send({ error: { code: 'NOT_DELETED', message: 'That dataset could not be deleted. Pre-loaded synthetic demonstration datasets are protected.' } });
    }
    return reply.code(204).send();
  });
}
