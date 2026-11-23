// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let language: 'ar' | 'en' = 'ar';
vi.mock('../../../contexts/LanguageContext', () => ({ useLanguage: () => ({ language }) }));
vi.mock('next/image', () => ({ default: () => null }));

import { CustomPageView } from './CustomPageView';

const page = {
  slug: 'qa-test-page',
  title: 'QA page',
  titleAr: 'صفحة اختبار',
  contentHtml: '<p>Hello body</p>',
  contentHtmlAr: '<p>أهلا بالمحتوى</p>',
};
afterEach(() => cleanup());

describe('CustomPageView', () => {
  it('renders the Arabic title and body in Arabic', () => {
    language = 'ar';
    render(<CustomPageView page={page} />);
    expect(screen.getByRole('heading', { name: 'صفحة اختبار' })).toBeTruthy();
    expect(screen.getByText('أهلا بالمحتوى')).toBeTruthy();
  });
  it('renders the English title and body in English', () => {
    language = 'en';
    render(<CustomPageView page={page} />);
    expect(screen.getByRole('heading', { name: 'QA page' })).toBeTruthy();
    expect(screen.getByText('Hello body')).toBeTruthy();
  });
  it('falls back to the other language when one side is empty', () => {
    language = 'en';
    render(<CustomPageView page={{ ...page, title: '', contentHtml: '' }} />);
    expect(screen.getByRole('heading', { name: 'صفحة اختبار' })).toBeTruthy();
    expect(screen.getByText('أهلا بالمحتوى')).toBeTruthy();
  });
});
