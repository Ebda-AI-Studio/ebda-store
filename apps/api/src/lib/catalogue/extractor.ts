/**
 * The seam between the import pipeline and the model. The pipeline only knows this interface, so the
 * extractor can be swapped (an offline OCR comparison later, Ruling CATIMP-8) or replaced in tests by a
 * recorded replay without touching the job.
 */
export interface CatalogueExtractionInput {
  storeId: string;
  bytes: Buffer;
  /** Sniffed from the bytes. */
  mime: string;
  pageCount: number;
  /** Existing category names, so a guess maps onto the merchant's own tree. */
  categories: string[];
}

export interface CatalogueExtractionResult {
  /** The model's reply, parsed as JSON but NOT yet trusted: the pipeline validates it with Zod. */
  raw: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CatalogueExtractor {
  readonly name: string;
  extract(input: CatalogueExtractionInput): Promise<CatalogueExtractionResult>;
}
