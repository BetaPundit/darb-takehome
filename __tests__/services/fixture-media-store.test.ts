import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultFixturesDir, fixtureBytes, fixtureNames } from '@/lib/extraction/fixtures';
import { FixtureMediaStore, UnconfiguredMediaStore } from '@/lib/services/fixture-media-store';
import { MediaStoreError, type MediaStore } from '@/lib/services/media-store';

const ROOT = defaultFixturesDir();
const realMap = JSON.parse(readFileSync(path.join(ROOT, 'media-map.json'), 'utf8')) as Record<string, string>;

const failure = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as MediaStoreError;

describe('FixtureMediaStore with the committed fixtures/media-map.json', () => {
  const store = new FixtureMediaStore();

  it('media_4471 (the assignment example id) resolves to the bytes of its fixture file', async () => {
    expect(realMap.media_4471).toBe('documents/exact.fixture');
    expect((await store.get('media_4471')).equals(fixtureBytes('exact'))).toBe(true);
  });

  it('every media id resolves to the exact bytes of the file it names', async () => {
    for (const [id, file] of Object.entries(realMap)) {
      expect((await store.get(id)).equals(readFileSync(path.join(ROOT, file)))).toBe(true);
    }
  });

  it('every fixture is reachable through exactly one media id', () => {
    const files = Object.values(realMap).sort();
    expect(files).toEqual(fixtureNames.map((n) => `documents/${n}.fixture`).sort());
  });

  it('the sample WhatsApp webhook bodies in fixtures/webhooks use ids that are in the map (and the "unknown" sample one that is not)', () => {
    const samples = readdirSync(path.join(ROOT, 'webhooks')).filter((f) => f.startsWith('whatsapp-'));
    expect(samples.length).toBeGreaterThan(0);
    for (const file of samples) {
      const body = JSON.parse(readFileSync(path.join(ROOT, 'webhooks', file), 'utf8')) as {
        entry: { changes: { value: { messages: { image: { id: string } }[] } }[] }[];
      };
      const ids = body.entry.flatMap((e) => e.changes.flatMap((c) => c.value.messages.map((m) => m.image.id)));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(Object.hasOwn(realMap, id)).toBe(file !== 'whatsapp-unknown-media.json');
    }
  });

  it('returns a fresh buffer each time', async () => {
    const a = await store.get('media_4471');
    a.fill(0);
    expect((await store.get('media_4471')).toString('utf8')).toBe('DARB-FIXTURE:exact');
  });

  it.each(['media_9999', '', 'fixture:exact', 'exact', 'media_4471 ', '__proto__', 'constructor', 'toString', '../documents/exact.fixture'])(
    'an id that is not in the map (%p) is a permanent NOT_FOUND',
    async (id) => {
      const e = await failure(store.get(id));
      expect(e).toBeInstanceOf(MediaStoreError);
      expect({ code: e.code, retryable: e.retryable }).toEqual({ code: 'NOT_FOUND', retryable: false });
      expect(e.message).not.toContain(id || 'never'); // the id is attacker-supplied: it is not echoed into logs
    },
  );
});

describe('FixtureMediaStore loading and path traversal', () => {
  let dir = '';
  /** A fixtures-like directory at <tmp>/<random>/fixtures, with a "secret" file OUTSIDE it, next to it. */
  function build(map: unknown, files: Record<string, string> = { 'documents/a.fixture': 'AAA' }): string {
    const base = mkdtempSync(path.join(tmpdir(), 'darb-media-'));
    dir = path.join(base, 'fixtures');
    mkdirSync(path.join(dir, 'documents'), { recursive: true });
    writeFileSync(path.join(base, 'secret.txt'), 'TOP SECRET');
    for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c);
    if (map !== undefined) writeFileSync(path.join(dir, 'media-map.json'), typeof map === 'string' ? map : JSON.stringify(map));
    return dir;
  }
  afterEach(() => dir && rmSync(path.dirname(dir), { recursive: true, force: true }));

  it('reads the file a media id maps to', async () => {
    const store = new FixtureMediaStore(build({ media_1: 'documents/a.fixture' }));
    expect((await store.get('media_1')).toString()).toBe('AAA');
  });

  it('a path that normalises to a place still inside fixtures/ is fine', async () => {
    const store = new FixtureMediaStore(build({ media_1: 'documents/../documents/a.fixture' }));
    expect((await store.get('media_1')).toString()).toBe('AAA');
  });

  it.each([
    ['parent traversal', '../secret.txt'],
    ['traversal through a subdirectory', 'documents/../../secret.txt'],
    ['an absolute path', '/etc/passwd'],
    ['the fixtures directory itself', '.'],
    ['an empty path', ''],
  ])('a map value that is %s is refused when the store is created, so the file is never read', (_name, value) => {
    const d = build({ media_1: value });
    expect(() => new FixtureMediaStore(d)).toThrow(/media-map\.json: "media_1" maps to a path outside the fixtures directory/);
  });

  it('refuses a sibling directory whose name merely starts with "fixtures"', () => {
    const d = build({ media_1: '../fixtures-evil/x.fixture' });
    expect(() => new FixtureMediaStore(d)).toThrow(/outside/);
  });

  it('a missing fixtures directory fails with the path in the message', () => {
    const missing = path.join(tmpdir(), 'darb-no-such-fixtures-dir');
    expect(() => new FixtureMediaStore(missing)).toThrow(/media-map\.json/);
    expect(() => new FixtureMediaStore(missing)).toThrow(missing);
  });

  it('a missing media-map.json fails clearly', () => {
    expect(() => new FixtureMediaStore(build(undefined))).toThrow(/Cannot read .*media-map\.json/);
  });

  it('invalid JSON fails clearly', () => {
    expect(() => new FixtureMediaStore(build('{ nope'))).toThrow(/media-map\.json is not valid JSON/);
  });

  it.each([
    ['an array', ['documents/a.fixture']],
    ['a non-string value', { media_1: 5 }],
    ['null', null],
  ])('%s is not a media map', (_name, map) => {
    expect(() => new FixtureMediaStore(build(map))).toThrow(/media-map\.json must be an object of media id -> file path/);
  });

  it('a mapped file that no longer exists is a permanent NOT_FOUND, not a crash', async () => {
    const store = new FixtureMediaStore(build({ media_1: 'documents/gone.fixture' }));
    const e = await failure(store.get('media_1'));
    expect({ code: e.code, retryable: e.retryable }).toEqual({ code: 'NOT_FOUND', retryable: false });
  });
});

describe('UnconfiguredMediaStore', () => {
  it('fails retryably so Meta redelivers once the token is configured', async () => {
    const store: MediaStore = new UnconfiguredMediaStore();
    const e = await failure(store.get('anything'));
    expect({ code: e.code, retryable: e.retryable }).toEqual({ code: 'HTTP_ERROR', retryable: true });
  });
});
