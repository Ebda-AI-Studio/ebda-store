'use client';

import { useRef, useState, type ReactNode } from 'react';

interface UploadDropzoneProps {
  accept: string;
  multiple?: boolean;
  onFiles: (files: FileList) => void;
  children: ReactNode;
  /** Tailwind spacing utility for the dropzone padding (e.g. 'p-6' / 'p-8'). */
  paddingClass?: string;
  className?: string;
}

/**
 * Reusable drag-and-drop + click-to-pick zone. Wraps a hidden file input and
 * renders whatever content the caller provides (idle icon, progress, etc.).
 */
export function UploadDropzone({
  accept,
  multiple = false,
  onFiles,
  children,
  paddingClass = 'p-6',
  className = '',
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) onFiles(e.target.files);
    // Reset so picking the same file twice still fires onChange
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div
      onDragOver={e => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`relative cursor-pointer rounded-lg border-2 border-dashed ${paddingClass} text-center transition-colors ${
        dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground'
      } ${className}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        className="hidden"
      />
      {children}
    </div>
  );
}
