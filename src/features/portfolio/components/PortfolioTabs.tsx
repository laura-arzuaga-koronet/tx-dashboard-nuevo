/**
 * The two tab rows above the table:
 *  1. Business type (Wholesalers / Importers / Growers / Retailers / All) — same value as the dropdown.
 *  2. Action (Portfolio / BUY / LIST / SELL / CONFIG / Declining) — narrows by opportunity flag.
 */
import { TabButton, TabsNav, TabsSpacer } from '../../../components/ui/TabButton';
import { ONLY_618_TAB, UNIVERSE_TAB, type ActionTab, type ActionTabCounts, type BusinessTypeCounts } from '../../../domain/filters';
import type { FiltersAction } from '../../../state/filtersReducer';
import { BUSINESS_TYPES } from '../filterOptions';

interface BusinessTypeTabsProps {
  value: string;
  counts: BusinessTypeCounts;
  dispatch: (action: FiltersAction) => void;
  onToggleDefinitions?: () => void;
  definitionsOpen?: boolean;
}

const BT_LABEL: Record<(typeof BUSINESS_TYPES)[number], string> = {
  Wholesaler: 'Wholesalers',
  Importer: 'Importers',
  Grower: 'Growers',
  Retailer: 'Retailers',
};

export function BusinessTypeTabs({ value, counts, dispatch, onToggleDefinitions, definitionsOpen }: BusinessTypeTabsProps) {
  const select = (bt: string) => dispatch({ type: 'set', key: 'businessType', value: bt });
  return (
    <TabsNav flush aria-label="Business type">
      {BUSINESS_TYPES.map((bt) => (
        <TabButton key={bt} active={value === bt} count={counts[bt]} onClick={() => select(bt)}>
          {BT_LABEL[bt]}
        </TabButton>
      ))}
      <TabButton active={value === ''} count={counts.all} onClick={() => select('')}>All</TabButton>
      <TabButton
        active={value === UNIVERSE_TAB}
        count={counts.universe}
        onClick={() => select(UNIVERSE_TAB)}
        title="Wholesaler portfolio: canonical filter + Christine/Facundo sheet"
      >
        WH universe
      </TabButton>
      <TabButton
        active={value === ONLY_618_TAB}
        count={counts.only618}
        onClick={() => select(ONLY_618_TAB)}
        title="Accounts that only the 618 universe research identifies as wholesalers. Recorded for review but NOT included in the portfolio or its KPIs, and their business_type is not changed in Salesforce."
      >
        618 · outside portfolio
      </TabButton>
      {onToggleDefinitions && (
        <>
          <TabsSpacer />
          <TabButton active={!!definitionsOpen} onClick={onToggleDefinitions}>Definitions &amp; Matrix</TabButton>
        </>
      )}
    </TabsNav>
  );
}

interface ActionTabsProps {
  value: ActionTab;
  counts: ActionTabCounts;
  dispatch: (action: FiltersAction) => void;
}

const ACTION_TABS: { id: ActionTab; label: string }[] = [
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'buy', label: 'BUY Leads' },
  { id: 'list', label: 'LIST Leads' },
  { id: 'sell', label: 'SELL Leads' },
  { id: 'config', label: 'CONFIG Leads' },
  { id: 'declining', label: 'Declining' },
];

export function ActionTabs({ value, counts, dispatch }: ActionTabsProps) {
  return (
    <TabsNav aria-label="Lead type">
      {ACTION_TABS.map((t) => (
        <TabButton key={t.id} active={value === t.id} count={counts[t.id]} onClick={() => dispatch({ type: 'setActionTab', tab: t.id })}>
          {t.label}
        </TabButton>
      ))}
    </TabsNav>
  );
}
