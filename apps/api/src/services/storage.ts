import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Object storage abstraction.
 *
 * The interface is written against S3 semantics so that AWS S3, Azure Blob,
 * Google Cloud Storage or MinIO can back it in a deployment. The default
 * implementation writes to a local directory, which keeps `docker compose up`
 * free of a storage dependency; the compose file wires MinIO in for a
 * realistic local S3.
 *
 * Uploaded paths are confined to the storage root: a `..` in a filename cannot
 * escape it.
 */

export interface ObjectStorage {
  write(key: string, data: Buffer): Promise<string>;
  readText(uri: string): Promise<string | null>;
  read(uri: string): Promise<Buffer | null>;
  readonly backend: string;
}

class LocalObjectStorage implements ObjectStorage {
  readonly backend = 'local-filesystem';
  private root: string;

  constructor(root = process.env.STORAGE_ROOT ?? './.storage') {
    this.root = resolve(root);
  }

  private safePath(key: string): string {
    const target = resolve(join(this.root, key));
    if (!target.startsWith(this.root)) {
      throw new Error('Refusing to write outside the storage root.');
    }
    return target;
  }

  async write(key: string, data: Buffer): Promise<string> {
    const path = this.safePath(key.replace(/\.\./g, '_'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return `file://${path}`;
  }

  async read(uri: string): Promise<Buffer | null> {
    if (!uri.startsWith('file://')) return null;
    try {
      return await readFile(uri.slice('file://'.length));
    } catch {
      return null;
    }
  }

  async readText(uri: string): Promise<string | null> {
    const buf = await this.read(uri);
    return buf ? buf.toString('utf8') : null;
  }
}

export const storage: ObjectStorage = new LocalObjectStorage();
