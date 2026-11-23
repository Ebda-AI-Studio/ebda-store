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
});
