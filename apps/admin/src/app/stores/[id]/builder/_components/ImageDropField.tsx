'use client';

/**
 * The image control of the right pane (editor premium F53): one large target that shows the picture,
 * takes a dropped file (uploaded into the store's builder folder, the same pipeline as the picker),
 * opens the media library on a click, and offers Replace and Remove as real buttons. The target is a
 * pointer convenience; Replace / Choose is the keyboard and screen-reader path.
 *
 * No focal point picker: the document has no focal data for a generic image (a hero slide's
 * top / centre / bottom focus is an ordinary 3-way choice, shown as a segmented control).
 */
import { useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useImageUpload } from '../../../../../hooks/useImageUpload';
import { MediaPicker } from './MediaPicker';

const ACCEPT = /^image\/(jpeg|png|webp|gif)$/;

export function ImageDropField({
  storeId,
  label,
  tag,
  value,
  onChange,
}: {
  storeId: string;
  /** The field's own name: several images on one section share the same button text. */
  label: string;
  tag: string;
  value: string;
  onChange: (v: string | undefined) => void;
}) {
  const t = useT('builder.settings');
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const { uploadSingle, uploading, error } = useImageUpload();
  const name = tag ? `${label} - ${tag}` : label;

  const drop = async (file: File | undefined) => {
    if (!file || !ACCEPT.test(file.type)) return;
    const url = await uploadSingle(file, 'builder', storeId);
    if (url) onChange(url);
  };

  return (
    <div className="min-w-0" data-testid="image-field">
      {tag && <span className="mb-0.5 block text-xs text-muted-foreground">{tag}</span>}
      <div
        data-ui="tile"
        data-testid="image-drop"
        data-over={over || undefined}
        onClick={() => setOpen(true)}
        onDragOver={e => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault();
          setOver(false);
          void drop(e.dataTransfer.files?.[0]);
        }}
        className={`relative flex min-h-28 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed transition-colors duration-150 motion-reduce:transition-none ${
          over ? 'border-primary bg-primary/10' : 'border-border bg-muted/40 hover:bg-muted'
        }`}
      >
        {value ? (
          <img src={value} alt="" className="h-28 w-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-1 px-3 py-4 text-center text-xs text-muted-foreground">
            <ImagePlus className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            {uploading ? t('uploadingImage') : t('dropImage')}
          </span>
        )}
        {value && uploading && (
          <span className="absolute inset-0 grid place-items-center bg-background/70 text-xs">
            {t('uploadingImage')}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${value ? t('changeImage') : t('chooseImage')}: ${name}`}
        >
          {value ? t('changeImage') : t('chooseImage')}
        </Button>
        {value && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => onChange(undefined)}
            aria-label={`${t('removeImage')}: ${name}`}
            className="text-muted-foreground"
          >
            {t('removeImage')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive-ink">
          {error}
        </p>
      )}
      {open && (
        <MediaPicker
          storeId={storeId}
          onClose={() => setOpen(false)}
          onPick={url => {
            onChange(url);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
