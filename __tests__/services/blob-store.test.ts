import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '@/lib/extraction/hash';
import { InMemoryBlobStore, LocalFsBlobStore, type BlobStore } from '@/lib/services/blob-store';

const bytes = Buffer.from('%PDF-1.4 fake receipt');
const hash = sha256Hex(bytes);

const BAD_KEYS = [
  '../../etc/passwd',
  '..',
  '../' + hash,
  hash + '/..',
  hash.slice(0, 63),
  hash + 'a',
  hash.toUpperCase(),
  hash.replace(/.$/, 'g'),
  '/etc/passwd',
  `${hash}.tmp`,
  '',
  'a\u0000b',
];

function contract(name: string, make: () => Promise<BlobStore>) {
  describe(name, () => {
    let store: BlobStore;
    beforeEach(async () => {
      store = await make();
    });

    it('round-trips bytes and returns the hash as the key', async () => {
      expect(await store.put(hash, bytes)).toBe(hash);
      expect((await store.get(hash)).equals(bytes)).toBe(true);
    });

    it('put is idempotent', async () => {
      await store.put(hash, bytes);
      await expect(store.put(hash, bytes)).resolves.toBe(hash);
      expect((await store.get(hash)).equals(bytes)).toBe(true);
    });

    it('concurrent puts of the same hash are safe', async () => {
      const keys = await Promise.all(Array.from({ length: 20 }, () => store.put(hash, bytes)));
      expect(new Set(keys)).toEqual(new Set([hash]));
      expect((await store.get(hash)).equals(bytes)).toBe(true);
    });

    it('rejects bytes that do not match the hash', async () => {
      await expect(store.put(hash, Buffer.from('other'))).rejects.toThrow('does not match');
    });

    it.each(BAD_KEYS)('rejects invalid key %p in put and get', async (key) => {
      await expect(store.put(key, bytes)).rejects.toThrow('Invalid blob key');
      await expect(store.get(key)).rejects.toThrow('Invalid blob key');
    });

    it('get of a missing key rejects', async () => {
      await expect(store.get('0'.repeat(64))).rejects.toThrow();
    });
  });
}

contract('InMemoryBlobStore', async () => new InMemoryBlobStore());

describe('LocalFsBlobStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blobstore-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const contractDirs: string[] = [];
  contract('contract (fresh temp dir)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'blobstore-c-'));
    contractDirs.push(dir);
    return new LocalFsBlobStore(dir);
  });
  afterAll(async () => {
    await Promise.all(contractDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('creates the directory lazily, including nested ones', async () => {
    const dir = path.join(root, 'a', 'b');
    const store = new LocalFsBlobStore(dir); // nothing created yet
    await expect(readdir(dir)).rejects.toThrow();
    await store.put(hash, bytes);
    expect(await readdir(dir)).toEqual([hash]);
  });

  it('leaves no temp files behind, even after concurrent puts', async () => {
    const store = new LocalFsBlobStore(root);
    await Promise.all(Array.from({ length: 10 }, () => store.put(hash, bytes)));
    expect(await readdir(root)).toEqual([hash]);
  });

  it('never writes outside its directory for traversal keys', async () => {
    const dir = path.join(root, 'blobs');
    const store = new LocalFsBlobStore(dir);
    await writeFile(path.join(root, 'secret.txt'), 'top secret');
    await expect(store.get('../secret.txt')).rejects.toThrow('Invalid blob key');
    await expect(store.put('../pwned', bytes)).rejects.toThrow('Invalid blob key');
    expect(await readdir(root)).toEqual(['secret.txt']);
  });
});
