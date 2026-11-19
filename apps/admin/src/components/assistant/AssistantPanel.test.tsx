// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => api);
vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

import { AssistantDock } from './AssistantDock';
import { AssistantPanel } from './AssistantPanel';
import { hrefForPath, safeHref } from '../../lib/assistant';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});

const reply = (over: Record<string, unknown> = {}) => ({
  data: {
    status: 'answered',
    previews: [],
    turnId: 't1',
    segments: [
      { kind: 'text', text: 'افتح صفحة الدومين. ' },
      {
        kind: 'cap',
        capabilityId: 'store.domain',
        label: 'الدومين',
        appPath: '/stores/[id]/domain',
      },
    ],
    ...over,
  },
});
const mount = (extra: { onClose?: () => void; onUnavailable?: () => void } = {}) =>
  render(
    <AssistantPanel
      storeId="s1"
      userId="u1"
      onClose={extra.onClose ?? (() => undefined)}
      onUnavailable={extra.onUnavailable ?? (() => undefined)}
    />
  );
const ask = (text = 'ازاي أربط دومين؟') => {
  fireEvent.change(screen.getByLabelText('placeholder'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
};

describe('AssistantPanel (Store admin)', () => {
  it('shows the empty state with suggestions; a suggestion asks the question', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValue(reply());
    mount();
    expect(screen.getByText('emptyTitle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'suggestions.s1' }));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/assistant/turn', {
        conversationId: expect.any(String),
        text: 'suggestions.s1',
        locale: 'ar',
      })
    );
  });

  it('renders a cap segment as a link to its screen in THIS store', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValue(reply());
    mount();
    ask();
    const link = await screen.findByRole('link', { name: /showMe/ });
    expect(link.getAttribute('href')).toBe('/stores/s1/domain');
  });

  it('never renders an <img>, a script or a link from reply text: it is plain text; a dynamic path with no id is plain text too', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValue(
      reply({
        segments: [
          {
            kind: 'text',
            text: '<img src="https://evil.example/p?d=1"> ![x](https://evil.example/p) <script>alert(1)</script>',
          },
          {
            kind: 'cap',
            capabilityId: 'order.list-detail',
            label: 'الطلب',
            appPath: '/stores/[id]/orders/[orderId]',
          },
          { kind: 'link', href: 'javascript:alert(1)', text: 'bad-js' },
          { kind: 'link', href: 'https://user:pw@evil.example/', text: 'bad-cred' },
          {
            kind: 'cite',
            articleId: 'a',
            title: 'الدومين الخاص',
            url: 'https://help.ebda.app/custom-domain/',
          },
        ],
      })
    );
    const { container } = mount();
    ask();
    await screen.findByText(/evil\.example/);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad-js' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad-cred' })).toBeNull();
    expect(screen.queryByRole('link', { name: /showMe/ })).toBeNull();
    expect(screen.getByText('الطلب')).toBeTruthy();
    expect(screen.getByRole('link', { name: /الدومين الخاص/ }).getAttribute('rel')).toContain(
      'noopener'
    );
    expect(safeHref('http://help.ebda.app/x')).toBeNull();
    expect(hrefForPath('/stores/[id]/domain', 'a b')).toBe('/stores/a%20b/domain');
    expect(hrefForPath('/stores/[id]/finance/*', 's1')).toBeNull();
    expect(hrefForPath('/stores/[id] dashboard', 's1')).toBe('/stores/s1'); // a note after the path never reaches the link
  });

  it('shows the refusal text the server sent, in words', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValue(
      reply({
        status: 'refused',
        segments: [{ kind: 'text', text: 'أنا هنا عشان أساعدك في متجرك بس.' }],
      })
    );
    mount();
    ask('احكيلي نكتة');
    expect(await screen.findByText('أنا هنا عشان أساعدك في متجرك بس.')).toBeTruthy();
  });

  it('a thumb down posts feedback once, then thanks', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValueOnce(reply()).mockResolvedValue({ data: { ok: true } });
    mount();
    ask();
    fireEvent.click(await screen.findByRole('button', { name: 'thumbDown' }));
    await waitFor(() =>
      expect(api.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/assistant/feedback', {
        turnId: 't1',
        thumb: 'down',
      })
    );
    expect(screen.getByText('thanks')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'thumbDown' })).toBeNull();
  });

  it('an error is stated with a retry that asks again; the question is not lost', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValueOnce({ error: { message: 'x' } }).mockResolvedValueOnce(reply());
    mount();
    ask();
    expect(await screen.findByText('error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await screen.findByRole('link', { name: /showMe/ });
    expect(api.apiPost).toHaveBeenCalledTimes(2);
    expect(api.apiPost.mock.calls[1]![1].text).toBe('ازاي أربط دومين؟');
  });

  it('shows a waiting state, then the answer', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    let done!: (v: unknown) => void;
    api.apiPost.mockReturnValue(
      new Promise(r => {
        done = r;
      })
    );
    mount();
    ask();
    expect(await screen.findByText('thinking')).toBeTruthy();
    done(reply());
    await screen.findByRole('link', { name: /showMe/ });
    expect(screen.queryByText('thinking')).toBeNull();
  });

  it('an off answer tells the owner and withdraws the panel', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValue(reply({ status: 'off', segments: [] }));
    const gone = vi.fn();
    mount({ onUnavailable: gone });
    ask();
    await waitFor(() => expect(gone).toHaveBeenCalled());
    expect(screen.getByText('off')).toBeTruthy();
    expect((screen.getByLabelText('placeholder') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('refuses over-long text, Enter sends, Shift+Enter does not, Esc closes', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValue(reply());
    const close = vi.fn();
    mount({ onClose: close });
    const box = screen.getByLabelText('placeholder');
    fireEvent.change(box, { target: { value: 'x'.repeat(2001) } });
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('tooLong')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'سؤال' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(api.apiPost).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });

  it('has no axe violations (empty and answered)', async () => {
    api.apiGet.mockResolvedValue({ data: { items: [] } });
    api.apiPost.mockResolvedValue(reply());
    const { container } = mount();
    const rules = { rules: { 'color-contrast': { enabled: false } } };
    expect((await axe.run(container, rules)).violations.map(v => v.id)).toEqual([]);
    ask();
    await screen.findByRole('link', { name: /showMe/ });
    expect((await axe.run(container, rules)).violations.map(v => v.id)).toEqual([]);
  });
});

describe('AssistantDock', () => {
  it('renders nothing when the server says the assistant is off (or the status fails); shows the launcher when on; Ctrl/Cmd+J toggles', async () => {
    api.apiGet.mockResolvedValueOnce({ data: { enabled: false } });
    const off = render(<AssistantDock storeId="s1" />);
    await waitFor(() =>
      expect(api.apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/assistant/status')
    );
    expect(off.container.querySelector('#assistant-launcher')).toBeNull();
    cleanup();
    api.apiGet.mockResolvedValueOnce({ error: { message: 'x' } });
    const failed = render(<AssistantDock storeId="s1" />);
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledTimes(2));
    expect(failed.container.querySelector('#assistant-launcher')).toBeNull();
    cleanup();
    api.apiGet.mockImplementation(async (url: string) =>
      url.endsWith('/status') ? { data: { enabled: true } } : { data: { items: [] } }
    );
    render(<AssistantDock storeId="s1" />);
    const launcher = await screen.findByRole('button', { name: 'title' });
    expect(screen.queryByTestId('assistant-panel')).toBeNull();
    fireEvent.click(launcher);
    expect(await screen.findByTestId('assistant-panel')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId('assistant-panel')).toBeNull());
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(await screen.findByTestId('assistant-panel')).toBeTruthy();
  });
});
