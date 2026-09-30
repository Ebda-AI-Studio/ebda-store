import { describe, it, expect } from 'vitest';
import { isHostInjectedScriptEvent } from '../utils/sentry-host-injected-filter';

// Frames copied from the production events (after the Next.js
// `app://` rewrite, which is what `beforeSend` sees).
const frames = (path: string, lines: Array<[string | undefined, number, number]>) =>
  lines.map(([fn, lineno, colno]) => ({
    filename: path,
    abs_path: path,
    function: fn,
    lineno,
    colno,
  }));

const event = (f: ReturnType<typeof frames>) => ({
  exception: { values: [{ stacktrace: { frames: f } }] },
});

// FORCE-WEB-Q (Chrome 154, `/`), FORCE-WEB-K (Chrome 152, `/products`),
// FORCE-WEB-P (`Error: La`, Chrome 153, `/`).
const WEB_Q = event(
  frames('app:///', [
    [undefined, 190, 70],
    [undefined, 197, 363],
    [undefined, 190, 41],
    [undefined, 198, 237],
    ['Qk', 226, 408],
    ['Ok', 226, 63],
  ])
);
const WEB_K = event(
  frames('app:///products', [
    [undefined, 198, 237],
    ['Pk', 226, 408],
    ['Nk', 226, 63],
  ])
);
const WEB_P = event(
  frames('app:///', [
    [undefined, 464, 363],
    ['Vi', 194, 41],
    [undefined, 195, 338],
  ])
);

const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.8037.0 Mobile/15E148 Safari/604.1';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const INSTAGRAM_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0';
const INSTAGRAM_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0.0 Android';
const FB_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]';

describe('isHostInjectedScriptEvent', () => {
  it('drops the production Chrome-for-iOS injected-script events (WEB-Q, WEB-K, WEB-P)', () => {
    expect(isHostInjectedScriptEvent(WEB_Q, CHROME_IOS)).toBe(true);
    expect(isHostInjectedScriptEvent(WEB_K, CHROME_IOS)).toBe(true);
    expect(isHostInjectedScriptEvent(WEB_P, CHROME_IOS)).toBe(true);
  });

  it('issue 2008: keeps the same shape from Instagram/Facebook in-app browsers — no evidence, widest reach', () => {
    expect(isHostInjectedScriptEvent(WEB_K, INSTAGRAM_IOS)).toBe(false);
    expect(isHostInjectedScriptEvent(WEB_K, FB_ANDROID)).toBe(false);
    expect(isHostInjectedScriptEvent(WEB_K, INSTAGRAM_ANDROID)).toBe(false);
  });

  it('issue 2008: keeps a Chrome-iOS error from one of OUR inline scripts (a document-sized line number)', () => {
    // Our served HTML is ~12 lines: an inline bootstrap error is attributed
    // to the document at a LOW line — not the injected script's 190-464.
    const ownInline = event(
      frames('app:///', [
        ['hydrate', 9, 1200],
        [undefined, 11, 40],
      ])
    );
    expect(isHostInjectedScriptEvent(ownInline, CHROME_IOS)).toBe(false);
    // Mixed: one low frame of ours is enough to keep it.
    const mixed = event(
      frames('app:///', [
        ['Ok', 226, 63],
        ['hydrate', 9, 1200],
      ])
    );
    expect(isHostInjectedScriptEvent(mixed, CHROME_IOS)).toBe(false);
  });

  it('issue 2008: a frame with no line number keeps the event (provenance unknown)', () => {
    const noLine = {
      exception: { values: [{ stacktrace: { frames: [{ filename: 'app:///' }] } }] },
    };
    expect(isHostInjectedScriptEvent(noLine, CHROME_IOS)).toBe(false);
  });

  it('keeps the same shape from Mobile Safari — no injected scripts there, so it could be ours', () => {
    expect(isHostInjectedScriptEvent(WEB_Q, SAFARI_IOS)).toBe(false);
  });

  it('keeps a Chrome-iOS event with even ONE frame in a shipped chunk', () => {
    const mixed = event([
      ...frames('app:///', [['Ok', 226, 63]]),
      ...frames('app:///_next/static/chunks/0dxyuvoq1y4qt.js', [['e', 12, 400]]),
    ]);
    expect(isHostInjectedScriptEvent(mixed, CHROME_IOS)).toBe(false);
  });

  it('keeps a script-file frame on a non-/_next path, and frames of unknown provenance', () => {
    expect(
      isHostInjectedScriptEvent(
        event(frames('https://connect.facebook.net/en_US/fbevents.js', [['a', 1, 1]])),
        CHROME_IOS
      )
    ).toBe(false);
    expect(isHostInjectedScriptEvent(event(frames('', [['a', 1, 1]])), CHROME_IOS)).toBe(false);
    expect(isHostInjectedScriptEvent(event(frames('<anonymous>', [['a', 1, 1]])), CHROME_IOS)).toBe(
      false
    );
  });

  it('keeps an event with no stack at all (a message or a frameless rejection)', () => {
    expect(isHostInjectedScriptEvent({}, CHROME_IOS)).toBe(false);
    expect(isHostInjectedScriptEvent(event([]), CHROME_IOS)).toBe(false);
  });
});
