export interface LegalDoc {
  title: string;
  sections: { h: string; p: string[] }[];
}

export interface LegalPages {
  /**
   * Labels of the "last updated" line. The date and the version themselves come from
   * LEGAL_POLICIES in @ebda/shared/legal (Ruling LEGAL-4), never from this copy.
   */
  updated: { label: string; versionLabel: string };
  /** One-line note under the title (which text is authoritative, how changes happen). */
  notice: string;
  /** Heading of the in-page table of contents. */
  toc: string;
  back: string;
  legal: LegalDoc;
  privacy: LegalDoc;
  terms: LegalDoc;
  acceptableUse: LegalDoc;
  merchant: LegalDoc;
}
