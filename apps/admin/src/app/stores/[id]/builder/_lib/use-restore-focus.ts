import { useEffect, useState } from 'react';

/**
 * A modal that the parent un-mounts (`{open && <Dialog/>}`) never runs `dialog.close()`, so the
 * browser does not give focus back: it lands on `<body>`, a keyboard or screen-reader user loses
 * their place, and the drawer's Esc / Tab trap (which listens on the drawer) goes deaf. This puts
 * focus back on what opened the dialog when it unmounts, unless focus already went somewhere on
 * purpose (another dialog, the canvas).
 *
 * The opener is read during the FIRST RENDER, before any effect: by the time an effect runs the
 * dialog has moved focus into itself (`showModal()`), and React's dev double-mount would then
 * capture a control inside the dialog.
 */
export function useRestoreFocus(): void {
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  );
  useEffect(() => {
    return () => {
      const now = document.activeElement;
      if ((!now || now === document.body) && opener && opener.isConnected) opener.focus();
    };
  }, [opener]);
}
