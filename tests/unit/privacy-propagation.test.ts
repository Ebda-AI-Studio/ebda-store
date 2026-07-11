/**
 * Unit tests — privacy-propagation.service.ts
 *
 * What we test:
 *   deleteOneSignalPlayers
 *     - no-op when playerIds is empty (no fetch call, no config lookup needed)
 *     - warns + no-ops when the OneSignal admin app isn't configured
 *     - calls DELETE for every playerId with the right URL + admin auth header
 *     - treats 404 as success (already gone)
 *     - a failed deletion doesn't stop the others AND rejects the whole call
 *       (so the caller — the Inngest step — can catch/log it without ever
 *       throwing back into AuthService.eraseAccount)
 *   deletePostHogPerson
 *     - warns + no-ops when POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID unset
 *     - no-ops when the lookup returns no matching person
 *     - deletes the person when the lookup finds one
 *     - rejects (doesn't swallow) on a lookup or delete HTTP failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@api/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mutable config stub — individual tests flip fields to exercise the
// env-gated branches.
const mockConfig: {
  onesignalAdminAppId: string;
  onesignalAdminRestApiKey: string;
  posthogPersonalApiKey: string;
  posthogProjectId: string;
  posthogHost: string;
} = {
  onesignalAdminAppId: '',
  onesignalAdminRestApiKey: '',
  posthogPersonalApiKey: '',
  posthogProjectId: '',
  posthogHost: 'https://eu.posthog.com',
};

vi.mock('@api/config', () => ({
  get config() {
    return mockConfig;
  },
}));

import {
  deleteOneSignalPlayers,
  deletePostHogPerson,
} from '@api/services/privacy-propagation.service';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('privacy-propagation.service', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.onesignalAdminAppId = '';
    mockConfig.onesignalAdminRestApiKey = '';
    mockConfig.posthogPersonalApiKey = '';
    mockConfig.posthogProjectId = '';
    mockConfig.posthogHost = 'https://eu.posthog.com';
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('deleteOneSignalPlayers', () => {
    it('no-ops without calling fetch when playerIds is empty', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await deleteOneSignalPlayers([]);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('warns and no-ops when the OneSignal admin app is not configured', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await deleteOneSignalPlayers(['player-1']);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('calls DELETE for every playerId with the admin app id + key', async () => {
      mockConfig.onesignalAdminAppId = 'admin-app-id';
      mockConfig.onesignalAdminRestApiKey = 'admin-rest-key';
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
      global.fetch = fetchMock as unknown as typeof fetch;

      await deleteOneSignalPlayers(['player-1', 'player-2']);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url1, opts1] = fetchMock.mock.calls[0];
      expect(url1).toBe('https://onesignal.com/api/v1/players/player-1?app_id=admin-app-id');
      expect(opts1).toMatchObject({
        method: 'DELETE',
        headers: { Authorization: 'Key admin-rest-key' },
      });
    });

    it('treats a 404 response as success, not a failure', async () => {
      mockConfig.onesignalAdminAppId = 'admin-app-id';
      mockConfig.onesignalAdminRestApiKey = 'admin-rest-key';
      global.fetch = vi.fn().mockResolvedValue(jsonResponse(404, {})) as unknown as typeof fetch;

      await expect(deleteOneSignalPlayers(['already-gone'])).resolves.toBeUndefined();
    });

    it('rejects when a deletion fails, after attempting every playerId', async () => {
      mockConfig.onesignalAdminAppId = 'admin-app-id';
      mockConfig.onesignalAdminRestApiKey = 'admin-rest-key';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
        .mockResolvedValueOnce(jsonResponse(200, {}));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(deleteOneSignalPlayers(['bad-player', 'good-player'])).rejects.toThrow();
      // Both were attempted despite the first failing (Promise.allSettled).
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('deletePostHogPerson', () => {
    it('warns and no-ops when PostHog personal API key/project id are unset', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await deletePostHogPerson('user-123');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no-ops when the person lookup returns no results', async () => {
      mockConfig.posthogPersonalApiKey = 'phx_personal_key';
      mockConfig.posthogProjectId = '12345';
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { results: [] }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await deletePostHogPerson('user-123');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('deletes the person when the lookup finds a match', async () => {
      mockConfig.posthogPersonalApiKey = 'phx_personal_key';
      mockConfig.posthogProjectId = '12345';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: 'person-abc' }] }))
        .mockResolvedValueOnce(jsonResponse(200, {}));
      global.fetch = fetchMock as unknown as typeof fetch;

      await deletePostHogPerson('user-123');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [lookupUrl] = fetchMock.mock.calls[0];
      expect(lookupUrl).toBe(
        'https://eu.posthog.com/api/projects/12345/persons/?distinct_id=user-123'
      );
      const [deleteUrl, deleteOpts] = fetchMock.mock.calls[1];
      expect(deleteUrl).toBe(
        'https://eu.posthog.com/api/projects/12345/persons/person-abc/?delete_events=true'
      );
      expect(deleteOpts).toMatchObject({ method: 'DELETE' });
    });

    it('rejects when the lookup call fails', async () => {
      mockConfig.posthogPersonalApiKey = 'phx_personal_key';
      mockConfig.posthogProjectId = '12345';
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;

      await expect(deletePostHogPerson('user-123')).rejects.toThrow();
    });

    it('rejects when the delete call fails after a successful lookup', async () => {
      mockConfig.posthogPersonalApiKey = 'phx_personal_key';
      mockConfig.posthogProjectId = '12345';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: 'person-abc' }] }))
        .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(deletePostHogPerson('user-123')).rejects.toThrow();
    });
  });
});
