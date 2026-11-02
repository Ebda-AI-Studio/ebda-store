export interface LegalDoc {
  title: string;
  /**
   * Own version and publish date, for documents that are not Ebda Store acceptance documents (the data deletion
   * page and the Ebda Chat documents). Store documents take theirs from LEGAL_POLICIES.
   */
  meta?: { version: string; publishedAt: string };
  /** A visible note under the title (a document with clauses still under legal review says so). */
  note?: string;
  sections: { h: string; p: readonly string[] }[];
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
  dataDeletion: LegalDoc;
  refund: LegalDoc;
  waTerms: LegalDoc;
  waPrivacy: LegalDoc;
  waDpa: LegalDoc;
  /** Link list on the legal notice page, to the documents that sit under /legal/. */
  more: { h: string; links: { slug: string; label: string }[] };
}
