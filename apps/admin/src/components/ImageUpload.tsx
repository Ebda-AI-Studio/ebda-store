'use client';

import { useState, useRef, useCallback } from 'react';
import Image from 'next/image';
import { getApiUrl } from '../lib/api';

interface ImageUploadProps {
  value?: string;
  onUpload: (url: string) => void;
  onRemove?: () => void;
  folder?: string;
  label?: string;
  accept?: string;
  className?: string;
}

interface MultiImageUploadProps {
  values: string[];
  onChange: (urls: string[]) => void;
  folder?: string;
  label?: string;
  max?: number;
  className?: string;
}

export function ImageUpload({
  value,
  onUpload,
  onRemove,
  folder = 'products',
  label = 'Upload Image',
  accept = 'image/jpeg,image/png,image/webp,image/gif',
  className = '',
}: ImageUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);
      setProgress(0);

      const formData = new FormData();
      formData.append('file', file);

      try {
        const xhr = new XMLHttpRequest();

        const url = await new Promise<string>((resolve, reject) => {
          xhr.upload.addEventListener('progress', e => {
            if (e.lengthComputable) {
              setProgress(Math.round((e.loaded / e.total) * 100));
            }
          });

          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const data = JSON.parse(xhr.responseText);
                if (data.success && data.data?.url) {
                  resolve(data.data.url);
                } else {
                  reject(new Error(data.error?.message || 'Upload failed'));
                }
              } catch {
                reject(new Error('Invalid server response'));
              }
            } else {
              try {
                const data = JSON.parse(xhr.responseText);
                reject(new Error(data.error?.message || `Upload failed (${xhr.status})`));
              } catch {
                reject(new Error(`Upload failed (${xhr.status})`));
              }
            }
          });

          xhr.addEventListener('error', () => reject(new Error('Network error')));
          xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

          xhr.open(
            'POST',
            `${getApiUrl()}/api/v1/uploads/image?folder=${encodeURIComponent(folder)}`
          );
          xhr.withCredentials = true;
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          xhr.send(formData);
        });

        onUpload(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [folder, onUpload]
  );

  const handleFile = useCallback(
    (file: File) => {
      const acceptTypes = accept.split(',').map(t => t.trim());
      if (
        !acceptTypes.some(
          t => file.type === t || (t.endsWith('/*') && file.type.startsWith(t.replace('/*', '/')))
        )
      ) {
        setError(`File type ${file.type} not accepted`);
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError('File must be under 10MB');
        return;
      }
      uploadFile(file);
    },
    [accept, uploadFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      if (inputRef.current) inputRef.current.value = '';
    },
    [handleFile]
  );

  if (value) {
    return (
      <div className={`relative group ${className}`}>
        <div className="rounded-lg border bg-muted p-3">
          <Image
            src={value}
            alt={label}
            width={200}
            height={96}
            className="h-24 w-auto object-contain mx-auto"
          />
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      <div
        onDragOver={e => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`relative cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={handleChange}
          className="hidden"
        />

        {uploading ? (
          <div className="space-y-2">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">{progress}%</p>
            <div className="mx-auto w-32 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <svg
              className="mx-auto h-10 w-10 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="mt-1 text-sm text-muted-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">Drag & drop or click to browse</p>
          </>
        )}
      </div>

      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

export function MultiImageUpload({
  values,
  onChange,
  folder = 'products',
  label = 'Upload Images',
  max = 10,
  className = '',
}: MultiImageUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const remaining = max - values.length;
      if (remaining <= 0) {
        setError(`Maximum ${max} images allowed`);
        return;
      }

      const toUpload = files.slice(0, remaining);
      setError(null);
      setUploading(true);
      setProgress(0);

      const formData = new FormData();
      toUpload.forEach(f => formData.append('files', f));

      try {
        const newUrls = await new Promise<string[]>((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.addEventListener('progress', e => {
            if (e.lengthComputable) {
              setProgress(Math.round((e.loaded / e.total) * 100));
            }
          });

          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const data = JSON.parse(xhr.responseText);
                if (data.success && data.data?.files) {
                  resolve(data.data.files.map((f: { url: string }) => f.url));
                } else {
                  reject(new Error(data.error?.message || 'Upload failed'));
                }
              } catch {
                reject(new Error('Invalid server response'));
              }
            } else {
              try {
                const data = JSON.parse(xhr.responseText);
                reject(new Error(data.error?.message || `Upload failed (${xhr.status})`));
              } catch {
                reject(new Error(`Upload failed (${xhr.status})`));
              }
            }
          });

          xhr.addEventListener('error', () => reject(new Error('Network error')));

          xhr.open(
            'POST',
            `${getApiUrl()}/api/v1/uploads/images?folder=${encodeURIComponent(folder)}`
          );
          xhr.withCredentials = true;
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          xhr.send(formData);
        });

        onChange([...values, ...newUrls]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [folder, max, onChange, values]
  );

  const handleFiles = useCallback(
    (fileList: FileList) => {
      const files = Array.from(fileList).filter(f => {
        if (!f.type.startsWith('image/')) return false;
        if (f.size > 10 * 1024 * 1024) return false;
        return true;
      });
      if (files.length === 0) {
        setError('No valid image files selected');
        return;
      }
      uploadFiles(files);
    },
    [uploadFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files);
      if (inputRef.current) inputRef.current.value = '';
    },
    [handleFiles]
  );

  const removeImage = useCallback(
    (index: number) => {
      onChange(values.filter((_, i) => i !== index));
    },
    [onChange, values]
  );

  const moveImage = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= values.length) return;
      const next = [...values];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onChange(next);
    },
    [onChange, values]
  );

  return (
    <div className={className}>
      {/* Image grid */}
      {values.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-4">
          {values.map((url, i) => (
            <div
              key={url}
              className="relative group aspect-square rounded-lg border bg-muted overflow-hidden"
            >
              <Image src={url} alt={`Image ${i + 1}`} fill className="object-cover" />
              {i === 0 && (
                <span className="absolute top-1 left-1 bg-primary text-white text-[10px] font-medium px-1.5 py-0.5 rounded">
                  Main
                </span>
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
                {i > 0 && (
                  <button
                    type="button"
                    onClick={() => moveImage(i, i - 1)}
                    className="p-1 bg-white rounded-full shadow"
                    title="Move left"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                )}
                {i < values.length - 1 && (
                  <button
                    type="button"
                    onClick={() => moveImage(i, i + 1)}
                    className="p-1 bg-white rounded-full shadow"
                    title="Move right"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="p-1 bg-red-500 text-white rounded-full shadow"
                  title="Remove"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload zone */}
      {values.length < max && (
        <div
          onDragOver={e => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`relative cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={handleChange}
            className="hidden"
          />

          {uploading ? (
            <div className="space-y-2">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Uploading... {progress}%</p>
              <div className="mx-auto w-40 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ) : (
            <>
              <svg
                className="mx-auto h-12 w-12 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <p className="mt-2 text-sm text-muted-foreground">{label}</p>
              <p className="text-xs text-muted-foreground">
                Drag & drop or click to browse ({values.length}/{max})
              </p>
            </>
          )}
        </div>
      )}

      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
