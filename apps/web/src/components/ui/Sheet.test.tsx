// @vitest-environment jsdom
/**
 * R-04: the one Sheet primitive. Open → focus inside → Escape → focus back on the
 * trigger; Tab stays inside; the page behind does not scroll; a backdrop tap
 * closes; the close button is 44px. Also driven through its real consumers: the
 * bottom tab bar's menu drawer and the Dahab drawer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Sheet } from './Sheet';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'ar',
    isRtl: true,
    direction: 'rtl',
    setLanguage: () => {},
    t: (_en: string, ar: string) => ar,
  }),
}));
vi.mock('../../contexts/CartContext', () => ({ useCart: () => ({ itemCount: 0, items: [] }) }));
vi.mock('../../contexts/StoreContext', () => ({
  useStoreUrl: () => (p: string) => p,
  useStore: () => ({ store: null }),
}));

afterEach(() => {
  cleanup();
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

function Harness({ side = 'bottom' as const }: { side?: 'bottom' | 'start' | 'end' | 'center' }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        فتح
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        side={side}
        title="الفلاتر"
        closeLabel="إغلاق"
      >
        <a href="/a">أول</a>
        <a href="/b">آخر</a>
      </Sheet>
    </div>
  );
}

const dialog = () => document.querySelector('dialog')!;

describe('Sheet', () => {
  it('open → focus moves in → Escape → focus returns to the trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'فتح' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe('أول');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('the native cancel event (browser Escape) closes through the owner', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'فتح' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab wraps inside the sheet (focus trap)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'فتح' }));
    const close = screen.getByRole('button', { name: 'إغلاق' });
    const last = screen.getByText('آخر');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('locks page scroll while open and restores it on close', () => {
    document.body.style.overflow = 'auto';
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'فتح' }));
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(document.body.style.overflow).toBe('auto');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('a tap on the backdrop closes; a tap inside does not', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'فتح' }));
    fireEvent.click(screen.getByText('أول'));
    expect(dialog().hasAttribute('open')).toBe(true);
    fireEvent.click(dialog());
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('is named by its title, has a 44px close, contained overscroll, var(--radius), no drag handle', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'فتح' }));
    const d = dialog();
    const titleId = d.getAttribute('aria-labelledby')!;
    expect(document.getElementById(titleId)?.textContent).toBe('الفلاتر');
    const close = screen.getByRole('button', { name: 'إغلاق' });
    expect(close.className).toContain('h-11');
    expect(close.className).toContain('w-11');
    expect(d.querySelector('[data-sheet-body]')!.className).toContain('overscroll-contain');
    expect(d.className).toContain('rounded-t-[var(--radius)]');
    expect(d.querySelector('.h-1.w-10, .h-1.w-12')).toBeNull();
  });

  it('a closed sheet holds no focusable content', () => {
    render(<Harness />);
    expect(dialog().querySelectorAll('a, button').length).toBe(0);
  });

  it('the browser closing the dialog itself still unlocks, returns focus and tells the owner', () => {
    document.body.style.overflow = 'auto';
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'فتح' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe('hidden');
    // Android back / a non-cancelable close watcher: the dialog closes natively,
    // no Escape keydown, no owner click. The Harness never unmounts (cookie modal shape).
    const d = dialog();
    d.removeAttribute('open');
    fireEvent(d, new Event('close'));
    expect(document.body.style.overflow).toBe('auto');
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
    // The owner flipped to closed: a second open works as new.
    fireEvent.click(trigger);
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('a stale close event after close-then-reopen is ignored (fix round 2)', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'فتح' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' })); // owner closes…
    fireEvent.click(trigger); // …and reopens before the queued `close` event fires
    const d = dialog();
    expect(d.hasAttribute('open')).toBe(true);
    fireEvent(d, new Event('close')); // the stale event arrives now
    expect(d.hasAttribute('open')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('uses showModal / close when the browser has them', () => {
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    const close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'فتح' }));
      expect(showModal).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      // @ts-expect-error -- jsdom has no showModal/close; remove the stubs again.
      delete HTMLDialogElement.prototype.showModal;
      // @ts-expect-error -- see above.
      delete HTMLDialogElement.prototype.close;
    }
  });

  it('unmounting while open unlocks the page and returns focus', () => {
    function Gone() {
      const [shown, setShown] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setShown(false)}>
            إخفاء
          </button>
          {shown && <Harness />}
        </div>
      );
    }
    render(<Gone />);
    const trigger = screen.getByRole('button', { name: 'فتح' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe('hidden');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'إخفاء', hidden: true }));
    });
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Sheet consumers', () => {
  it('bottom tab bar: Menu opens the drawer; Escape returns focus to the Menu tab', async () => {
    const { BottomTabBar } = await import('../../templates/shared/BottomTabBar');
    render(
      <BottomTabBar navigation={[{ label: 'Products', labelAr: 'المنتجات', href: '/products' }]} />
    );
    const menu = await screen.findByRole('button', { name: 'القائمة' });
    menu.focus();
    fireEvent.click(menu);
    const d = document.getElementById('bottom-nav-menu-drawer') as HTMLDialogElement;
    expect(d.tagName).toBe('DIALOG');
    expect(d.hasAttribute('open')).toBe(true);
    expect(d.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(d.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(menu);
  });

  it('dahab drawer: renders on the Sheet primitive and closes on Escape', async () => {
    const { DahabDrawer } = await import('../../templates/dahab/Drawer');
    const onClose = vi.fn();
    render(
      <DahabDrawer open onClose={onClose} side="start" label="القائمة" closeLabel="إغلاق القائمة">
        <a href="/x">رابط</a>
      </DahabDrawer>
    );
    const d = dialog();
    expect(d.getAttribute('data-sheet')).toBe('start');
    fireEvent.keyDown(screen.getByText('رابط'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
