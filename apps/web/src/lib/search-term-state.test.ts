// @vitest-environment jsdom
/**
 * Ruling SEARCH-URL-1: the storefront search term never rides in a URL. It lives in the history
 * entry's state (back / forward / refresh), with a same-tab sessionStorage hand-off for the header
 * search and a one-time adoption of an old `/search?q=` link.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptLegacySearchQuery,
  commitSearchTerm,
  readSearchTermFromHistory,
  resolveSearchTerm,
  stashPendingSearchTerm,
  takePendingSearchTerm,
} from './search-term-state';

const TERM = 'منى 01012345678';

beforeEach(() => {
  window.history.replaceState(null, '', '/search');
  sessionStorage.clear();
});
afterEach(() => sessionStorage.clear());

describe('commitSearchTerm', () => {
  it('keeps the term in history.state and out of the URL', () => {
    commitSearchTerm(TERM, '/search?sort=newest', 'push');
    expect(window.location.href).not.toContain('01012345678');
    expect(decodeURIComponent(window.location.href)).not.toContain('منى');
    expect(window.location.search).toBe('?sort=newest');
    expect(readSearchTermFromHistory()).toBe(TERM);
  });

  it('survives going back and forward between two searches', () => {
    commitSearchTerm('shoes', '/search', 'push');
    commitSearchTerm('bags', '/search', 'push');
    expect(readSearchTermFromHistory()).toBe('bags');
    window.history.back();
    return new Promise<void>(resolve =>
      window.addEventListener(
        'popstate',
        () => {
          expect(readSearchTermFromHistory()).toBe('shoes');
          resolve();
        },
        { once: true }
      )
    );
  });
});

describe('header-search hand-off', () => {
  it('is taken once and then gone', () => {
    stashPendingSearchTerm(TERM);
    expect(takePendingSearchTerm()).toBe(TERM);
    expect(takePendingSearchTerm()).toBe('');
  });
});

describe('adoptLegacySearchQuery', () => {
  it('moves an old ?q= link into history.state and rewrites the URL without it', () => {
    window.history.replaceState(null, '', `/search?q=${encodeURIComponent(TERM)}&sort=newest`);
    expect(adoptLegacySearchQuery()).toBe(TERM);
    expect(window.location.search).toBe('?sort=newest');
    expect(window.location.href).not.toContain('01012345678');
    expect(readSearchTermFromHistory()).toBe(TERM);
  });

  it('does nothing off the search page', () => {
    window.history.replaceState(null, '', '/products?q=abc');
    expect(adoptLegacySearchQuery()).toBe('');
    expect(window.location.search).toBe('?q=abc');
  });
});

describe('resolveSearchTerm', () => {
  it('prefers history.state, then a legacy link, then the pending hand-off', () => {
    stashPendingSearchTerm('pending');
    commitSearchTerm('in-state', '/search', 'replace');
    expect(resolveSearchTerm()).toBe('in-state');

    window.history.replaceState(null, '', '/search?q=legacy');
    expect(resolveSearchTerm()).toBe('legacy');
    expect(window.location.search).toBe('');

    window.history.replaceState(null, '', '/search');
    expect(resolveSearchTerm()).toBe('pending');
    // adopted into the entry, so a refresh finds it without the hand-off
    expect(readSearchTermFromHistory()).toBe('pending');
    expect(takePendingSearchTerm()).toBe('');
  });

  it('is empty for a fresh visit to /search', () => {
    expect(resolveSearchTerm()).toBe('');
  });
});
