/** Static option lists for the top-bar dropdowns and quick-filter chips. */
import type { SelectOption } from '../../components/ui/SelectPill';
import { IMPL_CHIP_ACTIVE_PMT, IMPL_CHIP_GO_LIVE_GROWTH } from '../../domain/filters';
import { GMV_BANDS } from '../../domain/metrics';

export const ACCOUNT_CLASS_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Classes' },
  { value: 'Client', label: 'Client' },
  { value: 'Pre-live', label: 'Pre-live' },
  { value: 'Prospect', label: 'Prospect' },
];

export const BUSINESS_TYPES = ['Wholesaler', 'Importer', 'Grower', 'Retailer'] as const;

export const BUSINESS_TYPE_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Business Types' },
  ...BUSINESS_TYPES.map((v) => ({ value: v, label: v })),
];

export const SEGMENT_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Segments' },
  { value: 'Activo', label: 'Activo' },
  { value: 'Onboarding', label: 'Onboarding' },
  { value: 'Churned', label: 'Churned' },
  { value: 'Otro (Komet)', label: 'Otro (Komet)' },
  { value: 'Customer (sin Komet)', label: 'Customer (sin Komet)' },
  { value: 'Prospect (TAM)', label: 'Prospect (TAM)' },
];

export const PRODUCT_TIERS = ['Core+', 'eSuite', 'Procurement', 'K2K'] as const;

export const PRODUCT_TIER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Product Tiers' },
  ...PRODUCT_TIERS.map((v) => ({ value: v, label: v })),
];

export const GMV_BAND_OPTIONS: SelectOption[] = [
  { value: '', label: 'All GMV Bands' },
  ...GMV_BANDS.map((b) => ({ value: b.label, label: b.label.replace('>=', '≥').replace('<', '<') })),
];

export const SELL_CHANNEL_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Sell Channels' },
  { value: 'eShop-dominant', label: 'eShop' },
  { value: 'K2K-dominant', label: 'K2K' },
  { value: 'API', label: 'API' },
  { value: 'no_fees_data', label: 'No fees data' },
];

export const POTENTIAL_TIER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Potential Tiers' },
  { value: 'Flagship', label: 'Flagship' },
  { value: 'Growth Engine', label: 'Growth Engine' },
  { value: 'Activate', label: 'Activate' },
  { value: 'Seed', label: 'Seed' },
  { value: 'Unmeasured', label: 'Unmeasured' },
];

export const PRIORITY_CHIPS: { value: string; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'IMPL', label: 'IMPL' },
  { value: 'TA', label: 'TA' },
  { value: 'CS_TRACKED', label: 'CS' },
  { value: 'CS_P2', label: 'CS_P2' },
  { value: 'WATCH', label: 'WATCH' },
  { value: 'NEEDS_REVIEW', label: 'REVIEW' },
  { value: 'ECOSYSTEM', label: 'ECO' },
];

export const IMPL_CHIPS: { value: string; label: string }[] = [
  { value: IMPL_CHIP_ACTIVE_PMT, label: 'Active PMT' },
  { value: IMPL_CHIP_GO_LIVE_GROWTH, label: 'Go-Live & Growth' },
  { value: 'Recently live (2026)', label: 'Live 2026' },
  { value: 'Recently live (H2 2025)', label: 'Live H2 2025' },
  { value: 'Established', label: 'Established' },
];
