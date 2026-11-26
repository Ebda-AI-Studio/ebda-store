import { describe, it, expect, vi } from 'vitest';
import { pollForNewStamp } from '../useQueuedScan';

const wait = async () => {};

describe('pollForNewStamp (QA-117: "Last scanned" must move after a scan)', () => {
  it('returns true as soon as the stamp differs from the one before the scan', async () => {
    const reload = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('T1')
      .mockResolvedValueOnce('T1')
      .mockResolvedValueOnce('T2');
    await expect(pollForNewStamp({ reload, before: 'T1', wait })).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxPolls when nothing new landed', async () => {
    const reload = vi.fn(async () => 'T1');
    await expect(pollForNewStamp({ reload, before: 'T1', wait, maxPolls: 4 })).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(4);
  });

  it('a first-ever scan (no stamp before) counts once a stamp appears; null never counts', async () => {
    const reload = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('T1');
    await expect(pollForNewStamp({ reload, before: null, wait })).resolves.toBe(true);
  });
});
