import { IMAGE_UPLOAD_ACCEPTED_TYPES, IMAGE_UPLOAD_MAX_BYTES } from '@ebda/shared';

export interface RefusedFile {
  name: string;
  /** `type`: not a format the server stores; `size`: over the per-image ceiling. */
  reason: 'type' | 'size';
}

/**
 * Split a selection into the files the server will accept and the ones it would refuse, so a
 * predictable refusal is named before any upload starts (FU46 I-1a) instead of failing a later
 * batch. The list is the server's own (`IMAGE_UPLOAD_ACCEPTED_TYPES`); order is preserved.
 */
export function partitionImageFiles(files: readonly File[]): {
  accepted: File[];
  refused: RefusedFile[];
} {
  const accepted: File[] = [];
  const refused: RefusedFile[] = [];
  for (const f of files) {
    if (!(IMAGE_UPLOAD_ACCEPTED_TYPES as readonly string[]).includes(f.type)) {
      refused.push({ name: f.name, reason: 'type' });
    } else if (f.size > IMAGE_UPLOAD_MAX_BYTES) {
      refused.push({ name: f.name, reason: 'size' });
    } else {
      accepted.push(f);
    }
  }
  return { accepted, refused };
}
