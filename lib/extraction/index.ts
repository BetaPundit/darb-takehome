import Anthropic from '@anthropic-ai/sdk';
import { ClaudeExtractor } from './claude-extractor';
import { MockExtractor } from './mock-extractor';
import type { DocumentExtractor } from './types';

export interface CreateExtractorOptions {
  /** Defaults to 'mock'. */
  kind?: 'mock' | 'claude';
  anthropicApiKey?: string;
  /** Falls back to CLAUDE_EXTRACTOR_MODEL, then the ClaudeExtractor default. */
  model?: string;
}

export function createExtractor(opts: CreateExtractorOptions = {}): DocumentExtractor {
  if ((opts.kind ?? 'mock') === 'mock') return new MockExtractor();
  // Fail fast: never silently fall back to the mock when the real extractor was requested.
  if (!opts.anthropicApiKey) {
    throw new Error('EXTRACTOR=claude requires ANTHROPIC_API_KEY; refusing to fall back to the mock extractor');
  }
  return new ClaudeExtractor({
    client: new Anthropic({ apiKey: opts.anthropicApiKey, maxRetries: 0 }),
    model: opts.model ?? process.env.CLAUDE_EXTRACTOR_MODEL,
  });
}

export { sha256Hex } from './hash';
export * from './types';
