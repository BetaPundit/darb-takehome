import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '@/lib/extraction/hash';

export interface BlobStore {
  /** `hash` must be the sha256 hex of `bytes`. Returns the storage key (== hash). Idempotent. */
  put(hash: string, bytes: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}

const KEY_RE = /^[a-f0-9]{64}$/;

function assertKey(key: string): void {
  // Path-traversal defence: only a bare 64-char lowercase hex name can ever reach the filesystem.
  if (!KEY_RE.test(key)) throw new Error('Invalid blob key');
}

function assertContentMatches(hash: string, bytes: Buffer): void {
  // Content-addressed means the key is a promise about the bytes; refuse to store a lie.
  if (sha256Hex(bytes) !== hash) throw new Error('Blob hash does not match content');
}

export class LocalFsBlobStore implements BlobStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  async put(hash: string, bytes: Buffer): Promise<string> {
    assertKey(hash);
    assertContentMatches(hash, bytes);
    const target = path.join(this.dir, hash);
    if (await exists(target)) return hash;

    await mkdir(this.dir, { recursive: true });
    // Write to a unique temp name then rename: readers never see a partial file, and concurrent
    // puts of the same hash each rename identical content onto the same target.
    const tmp = path.join(this.dir, `${hash}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return hash;
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    return readFile(path.join(this.dir, key));
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  async put(hash: string, bytes: Buffer): Promise<string> {
    assertKey(hash);
    assertContentMatches(hash, bytes);
    this.blobs.set(hash, Buffer.from(bytes));
    return hash;
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    const blob = this.blobs.get(key);
    if (!blob) throw new Error('Blob not found');
    return Buffer.from(blob);
  }
}
