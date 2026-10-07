export interface LegalDoc {
  title: string;
  sections: { h: string; p: string[] }[];
}

export interface LegalPages {
  /** "Last updated" line: label before the date, the date as shown, and the version. */
  updated: { label: string; date: string; version: string };
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
