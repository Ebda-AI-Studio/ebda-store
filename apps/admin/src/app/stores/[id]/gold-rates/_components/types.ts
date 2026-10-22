import type { GoldKarat } from '@ebda/shared';

export interface RateView {
  karat: GoldKarat;
  ratePerGram: number | null;
  appliedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
}
export interface PendingRate {
  id: string;
  karat: GoldKarat;
  ratePerGram: number;
  source: string;
  jumpBps: number | null;
  createdAt: string;
}
export interface GoldSettingsView {
  enabled: boolean;
  feedEnabled: boolean;
  feedPremiumBps: number;
  maxAgeMinutes: number;
  jumpConfirmBps: number;
  roundingStep: 1 | 100 | 500 | 1000;
  showBreakdown: boolean;
}
export interface GoldState {
  settings: GoldSettingsView;
  goldProductCount: number;
  rates: RateView[];
  pending: PendingRate[];
  feedAvailable: boolean;
}
export interface HistoryItem {
  id: string;
  karat: GoldKarat;
  ratePerGram: number;
  source: 'manual' | 'feed';
  status: 'applied' | 'pending' | 'rejected';
  jumpBps: number | null;
  createdAt: string;
}
