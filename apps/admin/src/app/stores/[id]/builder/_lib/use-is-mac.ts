import { useEffect, useState } from 'react';

/** True on Apple platforms (after mount, so server and first client render agree). */
export function useIsMac(): boolean {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    const nav = window.navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = nav.userAgentData?.platform ?? nav.platform ?? '';
    setMac(/mac|iphone|ipad/i.test(p));
  }, []);
  return mac;
}
