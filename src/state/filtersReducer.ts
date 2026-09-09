/**
 * Filter state reducer. Encodes the cross-filter interactions the legacy
 * dashboard implemented with scattered DOM writes:
 *  - choosing a Segment clears Account Class and widens Business Type to "All"
 *  - the business-type tabs and the Business Type dropdown are the same value
 *  - "clear all" resets everything (including the action tab)
 */
import { DEFAULT_FILTERS, type ActionTab, type FilterState } from '../domain/filters';

export type SingleFilterKey = 'accountClass' | 'businessType' | 'segment' | 'productTier' | 'gmvBand' | 'sellChannel' | 'potentialTier' | 'search';

export type FiltersAction =
  | { type: 'set'; key: SingleFilterKey; value: string }
  | { type: 'toggleChip'; group: 'priorities' | 'impl'; value: string }
  | { type: 'removeChip'; group: 'priorities' | 'impl'; value: string }
  | { type: 'setActionTab'; tab: ActionTab }
  | { type: 'clear'; key: SingleFilterKey }
  /** Varias claves de una: lo usa el drill-down de la matriz, que fija tipo de
   *  negocio, tier y banda de GMV en un solo paso. */
  | { type: 'setMany'; values: Partial<Record<SingleFilterKey, string>> }
  | { type: 'clearAll' }
  | { type: 'reset' };

function toggleIn(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function removeFrom(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

export function filtersReducer(state: FilterState, action: FiltersAction): FilterState {
  switch (action.type) {
    case 'set': {
      if (action.key === 'segment' && action.value) {
        // A segment shows the whole segment: drop class + business-type narrowing.
        return { ...state, segment: action.value, accountClass: '', businessType: '' };
      }
      return { ...state, [action.key]: action.value };
    }
    case 'toggleChip':
      return { ...state, [action.group]: toggleIn(state[action.group], action.value) };
    case 'removeChip':
      return { ...state, [action.group]: removeFrom(state[action.group], action.value) };
    case 'setActionTab':
      return { ...state, actionTab: action.tab };
    case 'setMany':
      return { ...state, ...action.values };
    case 'clear':
      return { ...state, [action.key]: '' };
    case 'clearAll':
      return {
        ...DEFAULT_FILTERS,
        accountClass: '',
        businessType: '',
        priorities: new Set(),
        impl: new Set(),
      };
    case 'reset':
      return { ...DEFAULT_FILTERS, priorities: new Set(), impl: new Set() };
  }
}
