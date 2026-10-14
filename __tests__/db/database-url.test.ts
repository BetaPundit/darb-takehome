import path from 'node:path';
import { resolveDatabaseUrl } from '@/lib/prisma-client';

/**
 * Regression: Prisma resolves a RELATIVE sqlite url as `dirname-of-generated-client + relativePath`. Inside Next's
 * bundled server that dirname is a build chunk folder under .next/, so `file:../dev.db` pointed at a file that does
 * not exist ("Error code 14: Unable to open the database file") while plain Node worked. We resolve it ourselves,
 * exactly like the Prisma CLI does (against the prisma/ folder), so every runtime agrees.
 */
describe('resolveDatabaseUrl', () => {
  const root = '/srv/app';
  const base = path.join(root, 'prisma');

  it('resolves a relative url against the prisma/ folder, like the CLI: ../dev.db is the project root', () => {
    expect(resolveDatabaseUrl('file:../dev.db', base)).toBe('file:/srv/app/dev.db');
  });

  it('resolves ./x.db to prisma/x.db (the CLI convention)', () => {
    expect(resolveDatabaseUrl('file:./x.db', base)).toBe('file:/srv/app/prisma/x.db');
  });

  it('leaves absolute paths alone', () => {
    expect(resolveDatabaseUrl('file:/tmp/scratch.db', base)).toBe('file:/tmp/scratch.db');
  });

  it('keeps query parameters', () => {
    expect(resolveDatabaseUrl('file:../dev.db?connection_limit=1&socket_timeout=5', base)).toBe(
      'file:/srv/app/dev.db?connection_limit=1&socket_timeout=5',
    );
  });

  it('does not touch non-file urls', () => {
    expect(resolveDatabaseUrl('postgresql://u:p@h/db', base)).toBe('postgresql://u:p@h/db');
  });

  it('defaults the base to <cwd>/prisma, which is where the Next server and the CLI both run from', () => {
    expect(resolveDatabaseUrl('file:../dev.db')).toBe(`file:${path.resolve(process.cwd(), 'dev.db')}`);
  });
});
