export interface LegalDoc {
  title: string;
  sections: { h: string; p: string[] }[];
}

export interface LegalPages {
  draftBadge: string;
  draftBody: string;
  back: string;
  legal: LegalDoc;
  privacy: LegalDoc;
  terms: LegalDoc;
  acceptableUse: LegalDoc;
  merchant: LegalDoc;
}
