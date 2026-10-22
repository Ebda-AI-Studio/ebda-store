'use client';

/**
 * "This tree is rendered inside the visual editor's canvas" for components that sit below a
 * section renderer and cannot be handed `editorMode` by props (the shared heading row is used by
 * nine skins' category grids, carousels and review rows). `PageRenderer` provides it only in
 * editor mode; everywhere else the default is `false`, so the public storefront renders exactly
 * what it did before and carries no editor attribute.
 */
import { createContext, useContext } from 'react';

const EditorModeContext = createContext(false);

export const EditorModeProvider = EditorModeContext.Provider;
export const useEditorMode = (): boolean => useContext(EditorModeContext);

/**
 * The `data-builder-setting` attribute for a localized text the canvas shows, so the overlay edits
 * the field on screen: `title` in English, `titleAr` in Arabic. Editor mode only.
 */
export function settingMarker(
  editorMode: boolean,
  base: string,
  rtl: boolean | undefined
): Record<string, string> | undefined {
  return editorMode ? { 'data-builder-setting': rtl ? `${base}Ar` : base } : undefined;
}
