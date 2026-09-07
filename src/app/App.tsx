import { PortfolioView } from '../features/portfolio/PortfolioView';

/**
 * App shell. Today it renders the single Portfolio view; when the other
 * Revenue OS pages (Qué Cambió, Data Issues, Opportunities, Activación) are
 * migrated they plug in here behind a router.
 */
export default function App() {
  return <PortfolioView />;
}
