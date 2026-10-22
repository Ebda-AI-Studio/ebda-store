// @vitest-environment jsdom
/**
 * Phase B4 Task 5, Ruling B4-7: the checkout delivery section. A store WITHOUT `daysAhead` renders
 * the today/tomorrow windows picker exactly as before (pinned by a markup snapshot); a store with
 * it renders date chips (radiogroup, arrow keys, 44px, selected = fill + check, not colour alone)
 * and the windows bookable on the chosen date.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { deliveryDateChoices } from '@ebda/shared';
import { smallTargets } from '../helpers/target-size';

const ctx = vi.hoisted(() => ({ language: 'ar' as 'ar' | 'en' }));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: ctx.language,
    isRtl: ctx.language === 'ar',
    t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
  }),
}));

const { DeliverySection } =
  await import('../../apps/web/src/app/checkout/_components/DeliverySection');
const { resolveDeliverySelection } =
  await import('../../apps/web/src/app/checkout/_lib/deliveryWindows');

afterEach(cleanup);

const WINDOWS = [
  { id: 'lunch', label: 'Lunch', labelAr: 'غدا', start: '12:00', end: '14:00', orderBy: '10:00' },
  { id: 'dinner', label: 'Dinner', labelAr: 'عشا', start: '18:00', end: '20:00', orderBy: '15:00' },
];
const settings = (extra: Record<string, unknown> = {}) => ({
  note: { enabled: false, text: '', textAr: '' },
  windows: { enabled: true, items: WINDOWS },
  ...extra,
});
const cairo = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`);
const choices = (hhmm = '11:00') =>
  deliveryDateChoices({
    now: cairo('2026-10-22', hhmm),
    windows: WINDOWS,
    daysAhead: 4,
    offDays: [],
    timeZone: 'Africa/Cairo',
  });

describe('DeliverySection without daysAhead (unchanged)', () => {
  it('renders the today / tomorrow windows picker markup exactly as before', () => {
    const selection = resolveDeliverySelection(WINDOWS, 9 * 60);
    const { container } = render(
      <DeliverySection
        settings={settings() as never}
        selection={selection}
        selectedWindowId="lunch"
        onSelectWindow={() => {}}
      />
    );
    expect(container.innerHTML).toMatchInlineSnapshot(
      `"<div class="rounded-[var(--radius)] border bg-card p-4 shadow-sm space-y-3"><div><div class="flex items-center gap-2"><h3 class="text-sm font-medium text-foreground">موعد التوصيل</h3><span class="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">اليوم</span></div><div class="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="موعد التوصيل"><button type="button" role="radio" aria-checked="true" class="rounded-lg border px-3 py-2 text-sm transition border-primary bg-primary/5 text-foreground"><span class="font-medium">غدا</span><span class="ms-1.5 text-xs text-muted-foreground">12:00 م–2:00 م</span></button><button type="button" role="radio" aria-checked="false" class="rounded-lg border px-3 py-2 text-sm transition border-input text-foreground hover:border-input/80"><span class="font-medium">عشا</span><span class="ms-1.5 text-xs text-muted-foreground">6:00 م–8:00 م</span></button></div></div></div>"`
    );
  });
  it('renders nothing when note and windows are both off and no dates are given', () => {
    const { container } = render(
      <DeliverySection
        settings={{
          note: { enabled: false, text: '', textAr: '' },
          windows: { enabled: false, items: [] },
        }}
        selection={{ day: 'today', windows: [] }}
        selectedWindowId={null}
        onSelectWindow={() => {}}
      />
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('DeliverySection with daysAhead', () => {
  const view = (over: Record<string, unknown> = {}) => {
    const onSelectDate = vi.fn();
    const onSelectWindow = vi.fn();
    const props = {
      settings: settings({ daysAhead: 4 }) as never,
      selection: { day: 'today' as const, windows: [] },
      selectedWindowId: null as string | null,
      onSelectWindow,
      dateChoices: choices(),
      selectedDate: null as string | null,
      onSelectDate,
      ...over,
    };
    const r = render(<DeliverySection {...props} />);
    return { ...r, onSelectDate, onSelectWindow };
  };
  it('offers the dates as a radiogroup of chips: today and tomorrow in words, then the date', () => {
    const { container, getAllByRole } = view();
    const group = container.querySelector('[role="radiogroup"][aria-label="يوم التوصيل"]')!;
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(radios).toHaveLength(4);
    expect(radios[0].textContent).toContain('النهاردة');
    expect(radios[1].textContent).toContain('بكرة');
    expect(radios[2].textContent).toContain('السبت');
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(getAllByRole('radiogroup')).toHaveLength(1); // no windows until a date is chosen
  });
  it('selecting a date calls back; the chosen date shows its windows with the closed one disabled', () => {
    const { container, onSelectDate } = view({ selectedDate: '2026-10-22' });
    fireEvent.click(container.querySelectorAll('[role="radio"]')[1]);
    expect(onSelectDate).toHaveBeenCalledWith('2026-10-23');
    const win = container.querySelector('[role="radiogroup"][aria-label="موعد التوصيل"]')!;
    const [lunch, dinner] = Array.from(
      win.querySelectorAll('[role="radio"]')
    ) as HTMLButtonElement[];
    expect(lunch.disabled).toBe(true); // 11:00 is past the 10:00 cut-off for today
    expect(dinner.disabled).toBe(false);
  });
  it('the selected chip is filled AND carries a check (not colour alone); only it is tabbable', () => {
    const { container } = view({ selectedDate: '2026-10-23' });
    const radios = Array.from(
      container.querySelectorAll('[role="radiogroup"]')[0].querySelectorAll('[role="radio"]')
    ) as HTMLElement[];
    const on = radios.find(r => r.getAttribute('aria-checked') === 'true')!;
    expect(on.querySelector('svg')).not.toBeNull();
    expect(on.className).toContain('bg-primary');
    expect(radios.filter(r => r.getAttribute('tabindex') === '0')).toEqual([on]);
  });
  it('arrow keys move and select, following the page direction (RTL: left is next)', () => {
    const { container, onSelectDate } = view({ selectedDate: '2026-10-22' });
    const first = container.querySelectorAll('[role="radio"]')[0];
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(onSelectDate).toHaveBeenLastCalledWith('2026-10-23');
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(onSelectDate).toHaveBeenLastCalledWith('2026-10-25'); // wraps to the last
  });
  it('every chip is a 44px target', () => {
    const { container } = view({ selectedDate: '2026-10-23' });
    expect(smallTargets(container, 44)).toEqual([]);
  });
  it('speaks English with sentence case', () => {
    ctx.language = 'en';
    const { container } = view();
    expect(container.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe(
      'Delivery date'
    );
    expect(container.textContent).toContain('Today');
    expect(container.textContent).toContain('Tomorrow');
    ctx.language = 'ar';
  });
  it('before the first clock tick (null) only the heading shows: no chips, no legacy picker, no flash of "none available"', () => {
    const { container } = view({ dateChoices: null });
    expect(container.textContent).toContain('يوم التوصيل');
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(container.textContent).not.toContain('مفيش مواعيد');
  });
  it('shows the refusal message next to the chips and never blocks when no date is on offer', () => {
    const withError = view({ error: 'الموعد اللي اخترته مبقاش متاح — اختار موعد تاني.' });
    expect(withError.getByRole('alert').textContent).toContain('مبقاش متاح');
    cleanup();
    const none = view({ dateChoices: [] });
    expect(none.container.textContent).toContain('مفيش مواعيد توصيل متاحة دلوقتي');
    expect(none.container.querySelector('[role="radio"]')).toBeNull();
  });
});
