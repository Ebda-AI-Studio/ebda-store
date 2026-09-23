/**
 * Unit tests — privacy-propagation.service.ts
 *
 * What we test:
 *   deleteOneSignalPlayers
 *     - no-op when playerIds is empty (no fetch call, no config lookup needed
 *       — genuinely nothing to delete, not a missing-credential failure)
 *     - FAILS LOUD (PropagationNotConfiguredError) when the OneSignal admin
 *       app isn't configured AND there ARE playerIds to delete (2026-09-22:
 *       this used to warn + silently return, which reported success on an
 *       erasure that never propagated)
 *     - calls DELETE for every playerId with the right URL + admin auth header
 *     - treats 404 as success (already gone)
 *     - a failed deletion doesn't stop the others AND rejects the whole call
 *       (so the caller — the Inngest step — can catch/log it without ever
 *       throwing back into AuthService.eraseAccount)
 *   deletePostHogPerson
 *     - FAILS LOUD (PropagationNotConfiguredError) when
 *       POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID are unset (same
 *       2026-09-22 fix — was warn + silent no-op)
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
  PropagationNotConfiguredError,
  summarizePropagationFailures,
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
    mockConfig.posthogErasureRequired = false;
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

    it('FAILS LOUD when the OneSignal admin app is not configured and there is something to delete', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(deleteOneSignalPlayers(['player-1'])).rejects.toBeInstanceOf(
        PropagationNotConfiguredError
      );
      // Never attempted an HTTP call it can't make — and never silently
      // reports success either.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the not-configured error names the provider', async () => {
      await expect(deleteOneSignalPlayers(['player-1'])).rejects.toMatchObject({
        provider: 'onesignal',
      });
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
    /**
     * Unset credentials are a documented NO-OP, not a failure, because nothing
     * calls `posthog.identify(userId)` so no person is keyed by our userId.
     * It used to throw, which dead-lettered the propagation function and raised
     * a P1 alert on EVERY erasure — up to 200 per monthly retention-cron run —
     * for a person that provably cannot exist. The same function already
     * returns normally when the credential IS set and the distinct_id matches
     * nothing, so this branch was strictly noisier than a stricter one.
     */
    it('no-ops (does not throw) when PostHog credentials are unset and erasure is not declared required', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(deletePostHogPerson('user-123')).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /** The escape hatch: once identify() is wired, declare it and it fails loud again. */
    it('FAILS LOUD when credentials are unset but POSTHOG_ERASURE_REQUIRED is true', async () => {
      mockConfig.posthogErasureRequired = true;
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(deletePostHogPerson('user-123')).rejects.toBeInstanceOf(
        PropagationNotConfiguredError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the not-configured error names the provider', async () => {
      mockConfig.posthogErasureRequired = true;
      await expect(deletePostHogPerson('user-123')).rejects.toMatchObject({
        provider: 'posthog',
      });
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

  describe('summarizePropagationFailures', () => {
    it('names the provider + "not-configured" for a PropagationNotConfiguredError', () => {
      const summary = summarizePropagationFailures([
        new PropagationNotConfiguredError('posthog', 'nope'),
      ]);
      expect(summary).toBe('posthog: not-configured');
    });

    it('distinguishes a real outage from a not-configured credential', () => {
      const summary = summarizePropagationFailures([
        new PropagationNotConfiguredError('posthog', 'nope'),
        new Error('OneSignal player delete failed (500): boom'),
      ]);
      expect(summary).toBe('posthog: not-configured; OneSignal player delete failed (500): boom');
    });

    it('falls back to "unknown error" for a non-Error reason', () => {
      expect(summarizePropagationFailures(['a bare string'])).toBe('unknown error');
    });
  });
});
