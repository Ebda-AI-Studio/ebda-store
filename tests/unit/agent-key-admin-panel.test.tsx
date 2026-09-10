/**
 * The agent-key admin surface RENDERS — for all three states a merchant can
 * actually be in, and without ever putting the credential on screen.
 *
 * There is no jsdom or testing-library in this repo (vitest env = 'node'), so
 * this renders `AgentKeyPanel` to static markup with `react-dom/server` and
 * asserts on the output. That is possible only because the panel was split out
 * of `page.tsx` as a pure function of its props — the page itself owns the
 * fetching, the router and the modals, none of which render server-side.
 *
 * `next-intl` is mocked to the identity function, so every assertion below is
 * against a TRANSLATION KEY, never an English string. A hardcoded user-facing
 * string in the panel would therefore not satisfy these assertions, which is
 * the intended pressure: the repo's rule is that no user-facing string is
 * hardcoded, and both locales carry the key.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Identity translator: `t('status.issued')` renders the literal key.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Imported AFTER the mock so it picks it up.
import {
  AgentKeyPanel,
  type AgentKeyStatus,
} from '@admin/app/stores/[id]/agent-key/_components/AgentKeyPanel';

const noop = () => {};

function render(status: AgentKeyStatus | null): string {
  return renderToStaticMarkup(
    <AgentKeyPanel status={status} busy={null} onIssue={noop} onRevoke={noop} />
  );
}

const NO_KEY: AgentKeyStatus = {
  hasKey: false,
  rotatedAt: null,
  header: 'x-agent-key',
  openWrites: false,
};

const WITH_KEY: AgentKeyStatus = {
  hasKey: true,
  rotatedAt: '2026-09-09T10:00:00.000Z',
  header: 'x-agent-key',
  openWrites: false,
};

const HATCH_ON: AgentKeyStatus = { ...WITH_KEY, hasKey: false, openWrites: true };

describe('AgentKeyPanel — a store with NO key', () => {
  const html = render(NO_KEY);

  it('renders the not-issued state and offers minting', () => {
    expect(html).toContain('status.notIssued');
    expect(html).toContain('status.notIssuedBody');
    expect(html).toContain('actions.mint');
  });

  it('offers no revoke — there is nothing to revoke', () => {
    expect(html).not.toContain('actions.revoke');
    expect(html).not.toContain('actions.rotate');
  });

  it('says the last-changed slot is empty rather than rendering a blank', () => {
    // unknown-state-rendered-as-empty: "never issued" must SAY so.
    expect(html).toContain('status.never');
  });

  it('states that read tools stay open, so "no key" is not read as "closed"', () => {
    expect(html).toContain('howto.readsAreOpen');
  });
});

describe('AgentKeyPanel — a store WITH a key', () => {
  const html = render(WITH_KEY);

  it('renders the issued state with rotate and revoke available', () => {
    expect(html).toContain('status.issued');
    expect(html).toContain('actions.rotate');
    expect(html).toContain('actions.revoke');
  });

  it('offers no second "mint" path once a key exists', () => {
    expect(html).not.toContain('actions.mint');
  });

  it('renders the header name forced LTR so an Arabic admin does not reorder it', () => {
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('x-agent-key');
  });

  it('shows when the key was last issued or changed', () => {
    expect(html).not.toContain('status.never');
  });
});

describe('AgentKeyPanel — the escape hatch is ON', () => {
  const html = render(HATCH_ON);

  it('warns that writes are accepted with no key at all', () => {
    expect(html).toContain('hatch.title');
    expect(html).toContain('hatch.body');
  });

  it('still renders the underlying key state alongside the warning', () => {
    expect(html).toContain('status.notIssued');
  });

  it('does not show the warning when the hatch is off', () => {
    // The other direction — a banner that always renders warns about nothing.
    expect(render(WITH_KEY)).not.toContain('hatch.title');
    expect(render(NO_KEY)).not.toContain('hatch.title');
  });
});

describe('AgentKeyPanel — the credential never reaches the DOM', () => {
  it('renders no secret even when the status payload smuggles one in', () => {
    // The regression this guards: the parent PR had to add
    // `omit: { agentApiKey: true }` at three StoreService boundaries because a
    // wide read leaked the ciphertext. If this panel ever renders a field off
    // its status payload that it should not, this reddens.
    const smuggled = {
      ...WITH_KEY,
      apiKey: 'fak_PLAINTEXT_MUST_NEVER_RENDER',
      agentApiKey: 'CIPHERTEXT_MUST_NEVER_RENDER',
    } as unknown as AgentKeyStatus;
    const html = render(smuggled);
    expect(html).not.toContain('fak_');
    expect(html).not.toContain('CIPHERTEXT_MUST_NEVER_RENDER');
  });
});

describe('AgentKeyPanel — loading', () => {
  it('renders a skeleton rather than a false "no key" claim while status is unknown', () => {
    // unknown-state-rendered-as-empty, again: before the status arrives the
    // page must not assert that the store has no key.
    const html = render(null);
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('status.notIssued');
    expect(html).not.toContain('status.issued');
  });
});
