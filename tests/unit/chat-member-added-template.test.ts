import { describe, it, expect } from 'vitest';
import { chatMemberAddedTemplate as t } from '@api/services/email-templates/chat-member-added';

const d = {
  email: 'a@example.com',
  name: '<b>Sam</b>',
  workspaceName: 'Acme "Support" <x>',
  chatUrl: 'https://wa.ebda.app/',
};

describe('chat-member-added template', () => {
  it('escapes the name and workspace in both languages and links to Chat, with no code', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = t[lang](d);
      expect(html).not.toContain('<b>Sam</b>');
      expect(html).not.toContain('<x>');
      expect(html).toContain('https://wa.ebda.app/');
      expect(html).not.toMatch(/\d{6}/);
      expect(t.subject[lang](d)).toContain('Acme');
    }
  });

  it('keeps the subject on one line even if the workspace name carries CR/LF', () => {
    const evil = { ...d, workspaceName: 'Acme\r\nBcc: x@evil.example\u2028y' };
    for (const lang of ['en', 'ar'] as const) {
      expect(t.subject[lang](evil)).not.toMatch(/[\r\n\u2028\u2029]/);
    }
  });

  it('says INVITED (not added), asks to sign in to Chat and accept, valid 7 days, in both languages', () => {
    const en = t.en(d);
    expect(en).toMatch(/invited/i);
    expect(en).toMatch(/accept the invitation/i);
    expect(en).toContain('7 days');
    expect(en).not.toMatch(/were added|has been added/i);
    expect(t.subject.en(d)).toMatch(/invited/i);
    const ar = t.ar(d);
    expect(ar).toContain('7 أيام');
    expect(ar).toContain('وافق على الدعوة');
    expect(ar).not.toContain('اتضفت');
  });

  it('a new account gets a set-password link; an existing one gets only Chat sign-in', () => {
    const fresh = {
      ...d,
      setPasswordUrl: 'https://store.ebda.app/reset-password?email=a%40b.c#code=123456',
    };
    expect(t.en(fresh)).toContain('reset-password');
    expect(t.ar(fresh)).toContain('reset-password');
    expect(t.en(d)).not.toContain('reset-password');
    // no invitation token anywhere: only the chat url
    expect(t.en(d)).toContain('https://wa.ebda.app/');
  });
});
