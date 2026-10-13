import { fixtureBytes, FIXTURES, type FixtureName } from '@/lib/extraction/fixtures';
import { MediaFetchError, type MediaFetcher } from '@/lib/services/media-fetcher';

/**
 * Dev/demo only: media id "fixture:<name>" resolves to the mock extractor's fixture bytes, so the WhatsApp
 * webhook can be exercised end to end without Meta credentials. The container never uses it in production.
 */
export class FixtureMediaFetcher implements MediaFetcher {
  async download(mediaId: string) {
    const name = mediaId.replace(/^fixture:/, '');
    if (!Object.hasOwn(FIXTURES, name)) throw new MediaFetchError('INVALID_MEDIA_ID', false, 'Unknown fixture media id');
    return { bytes: fixtureBytes(name as FixtureName), mimeType: 'image/jpeg' };
  }
}

/** Production without WHATSAPP_ACCESS_TOKEN: fail loudly and retryably so Meta redelivers once it is configured. */
export class UnconfiguredMediaFetcher implements MediaFetcher {
  async download(): Promise<never> {
    throw new MediaFetchError('HTTP_ERROR', true, 'WHATSAPP_ACCESS_TOKEN is not configured');
  }
}
