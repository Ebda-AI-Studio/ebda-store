'use client';

import { useState, useEffect } from 'react';
import { useStoreTemplate } from '../contexts/StoreContext';
import { getTemplateComponents, type TemplateComponents } from '../templates';

/**
 * Hook to dynamically load template components based on the current store's template.
 * Returns the loaded components with a loading state.
 */
export function useTemplateComponents() {
  const templateId = useStoreTemplate();
  const [components, setComponents] = useState<TemplateComponents | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const loaded = await getTemplateComponents(templateId);
        if (!cancelled) {
          setComponents(loaded);
        }
      } catch (err) {
        console.error(`Failed to load template '${templateId}':`, err);
        // Fallback to modern
        if (!cancelled) {
          const fallback = await getTemplateComponents('modern');
          setComponents(fallback);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [templateId]);

  return { components, isLoading, templateId };
}
