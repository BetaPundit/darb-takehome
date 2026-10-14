import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultFixturesDir } from '@/lib/extraction/fixtures';
import { MediaStoreError, type MediaStore } from '@/lib/services/media-store';

/**
 * Dev/demo/test only: resolves a media id through fixtures/media-map.json (media id -> file path under fixtures/), so the
 * WhatsApp webhook can be exercised end to end without Meta credentials. The container never uses it in production.
 *
 * The map is read and validated when the store is created: a broken map is a deployment error and should fail at wiring
 * time, not on the first request. Media ids from a webhook are only ever used as lookup keys, never as path parts; the
 * only paths ever opened are map values, and each must stay inside the fixtures directory.
 */
export class FixtureMediaStore implements MediaStore {
  /** media id -> absolute file path. A Map, so ids like "__proto__" or "constructor" are plain misses. */
  private readonly files = new Map<string, string>();

  constructor(dir: string = defaultFixturesDir()) {
    const root = path.resolve(dir);
    const mapFile = path.join(root, 'media-map.json');
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Cannot read ${mapFile}: fixtures directory not found (run the server from the project root)`);
    }

    let json: unknown;
    try {
      json = JSON.parse(readFileSync(mapFile, 'utf8'));
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error(`${mapFile} is not valid JSON`);
      throw new Error(`Cannot read ${mapFile}`);
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json) || Object.values(json).some((v) => typeof v !== 'string')) {
      throw new Error(`${mapFile} must be an object of media id -> file path under fixtures/`);
    }

    for (const [mediaId, relative] of Object.entries(json as Record<string, string>)) {
      const file = path.resolve(root, relative);
      const fromRoot = path.relative(root, file);
      // `..` prefix = outside; absolute = a different root (Windows drive); '' = the directory itself, not a file.
      if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
        throw new Error(`${mapFile}: "${mediaId}" maps to a path outside the fixtures directory`);
      }
      this.files.set(mediaId, file);
    }
  }

  async get(mediaId: string): Promise<Buffer> {
    // The id is attacker-supplied (it comes from a webhook body), so it is not echoed into the error message.
    const file = this.files.get(mediaId);
    if (file === undefined) throw new MediaStoreError('NOT_FOUND', false, 'Media id is not in the fixture map');
    try {
      return await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaStoreError('NOT_FOUND', false, 'Mapped fixture file does not exist');
      throw err;
    }
  }
}

/** Production without WHATSAPP_ACCESS_TOKEN: fail loudly and retryably so Meta redelivers once it is configured. */
export class UnconfiguredMediaStore implements MediaStore {
  async get(): Promise<never> {
    throw new MediaStoreError('HTTP_ERROR', true, 'WHATSAPP_ACCESS_TOKEN is not configured');
  }
}
