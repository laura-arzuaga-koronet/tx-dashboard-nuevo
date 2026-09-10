/**
 * evidence_adapter_v3.js — TX Dashboard V3 Evidence Adapter
 * Koronet Revenue OS · Chapter TX
 *
 * V3 upgrade: loads accounts_v3.json (430 accounts with classification),
 * sell/buy/fees monthly cubes, GMV pacing, and external GMV estimates,
 * ON TOP of the V2 evidence files (buyers, vendors, temporal, inventory,
 * benchmarks, config, hardgoods, skus_online_offline).
 *
 * API (same as V2):
 *   init()                              → Promise
 *   getAccountEvidence(companyId, tf)    → Object | null
 *   getAccountByName(companyName, tf)    → Object | null
 *   getAllAccountIds()                   → string[]
 *   getLoadedState()                     → Object
 *
 * Keying: company_id (string) is the primary key.
 * V2 evidence files keyed by company_name use the name→id lookup.
 *
 * Timeframe tokens: 'ytd' | 'current_month' | 'prior_month' | 'l12m'
 *
 * Evidence states: 'observed' | 'proxy' | 'model' | 'gap'
 *
 * Graceful fallback: any missing file or field returns null, never crash.
 */

(function (root) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────────────── */
  var _state = {
    loaded: false,
    loadPromise: null,

    // ── V3 new data ──
    accountsV3: [],           // accounts_v3.json .accounts (list)
    anchorMonth: null,        // last closed month of the sell cube (set on first use)
    sellCube: [],             // sell_monthly.json .data (list)
    buyCube: [],              // buy_monthly.json .data (list)
    feesCube: [],             // fees_monthly.json .data (list)
    indirectCube: [],         // indirect_fees_monthly.json .data (list)
    whUniverse: null,         // portfolio set → { sfdc_id: true } or null
    wh618: null,              // 618-only set (registered, NOT in the portfolio)
    gmvPacing: [],            // gmv_pacing.json .pacing (list)
    gmvExternal: [],          // gmv_estimates_external.json .estimates (list)

    // ── V2 legacy data ──
    buyers: {},               // buyers_evidence_v2.json .companies (name → obj)
    vendors: [],              // vendors_evidence_v2.json .companies (list)
    temporal: {},             // temporal_evidence_v2.json (raw)
    inventory: {},            // inventory_current_v1.json .companies (id → obj)
    benchmarks: {},           // benchmarks_v2.json .benchmarks
    config: {},               // config_evidence_v2.json .companies (id → obj)
    hardgoods: [],            // hardgoods_v2.json .companies (list)
    skusOnlineOffline: {},    // skus_online_offline.json .companies (name → obj)

    // ── Derived lookup maps ──
    accountById: {},          // company_id → accounts_v3 record
    idToName: {},             // company_id → company_name
    nameToId: {},             // company_name → company_id
    sellCubeById: {},         // company_id → [ rows ]
    buyCubeById: {},          // company_id → [ rows ]
    feesCubeById: {},         // company_id → [ rows ]
    indirectCubeById: {},     // buyer company_id → [ rows ]
    pacingById: {},           // company_id → pacing record
    externalById: {},         // company_id → external estimate record
    vendorsByName: {},        // company_name → vendor record
    hardgoodsByName: {},      // company_name → hardgoods record
    temporalSellAnticipation: {},
    temporalVarietyFreshness: {},
    temporalForwardInventory: {},

    // ── id-keyed maps (preferred join; name maps kept as fallback) ──
    vendorsById: {},          // company_id → vendor record
    skusById: {},             // company_id → skus record
    buyersById: {},           // company_id → buyers record
    temporalSAById: {},       // company_id → [ sell_anticipation rows ]
    temporalVFById: {},       // company_id → [ variety_freshness rows ]
    temporalFIById: {},       // company_id → [ forward_inventory rows ]
  };

  /* ─────────────────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────────────── */
  var DATA_BASE = 'data/';

  var FILES = {
    // V3 new files
    accountsV3:     DATA_BASE + 'accounts_v3.json',
    sellCube:       DATA_BASE + 'current/sell_monthly.json',
    buyCube:        DATA_BASE + 'current/buy_monthly.json',
    feesCube:       DATA_BASE + 'current/fees_monthly.json',
    indirectCube:   DATA_BASE + 'current/indirect_fees_monthly.json',
    gmvPacing:      DATA_BASE + 'gmv_pacing.json',
    gmvExternal:    DATA_BASE + 'gmv_estimates_external.json',
    whUniverse:     DATA_BASE + 'wholesaler_universe.json',
    // V2 legacy files
    buyers:            DATA_BASE + 'buyers_evidence_v2.json',
    vendors:           DATA_BASE + 'vendors_evidence_v2.json',
    temporal:          DATA_BASE + 'temporal_evidence_v2.json',
    inventory:         DATA_BASE + 'inventory_current_v1.json',
    benchmarks:        DATA_BASE + 'benchmarks_v2.json',
    config:            DATA_BASE + 'config_evidence_v2.json',
    hardgoods:         DATA_BASE + 'hardgoods_v2.json',
    skusOnlineOffline: DATA_BASE + 'skus_online_offline.json',
  };

  // Training/sandbox/demo accounts to exclude
  var EXCLUDED_IDS = {
    '561353': true, '549016': true, '6316': true,   '554582': true,
    '531246': true, '531265': true, '55326': true,  '751276': true,
    '132431': true, '468006': true, '398804': true, '806094': true,
  };

  /* ─────────────────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  function _fetchJson(url) {
    return fetch(url)
      .then(function (r) {
        if (!r.ok) { console.warn('[EvidenceAdapterV3] 404:', url); return null; }
        return r.json();
      })
      .catch(function (e) {
        console.warn('[EvidenceAdapterV3] fetch error:', url, e);
        return null;
      });
  }

  function _sid(id) {
    return id == null ? null : String(id);
  }

  function _num(val) {
    if (val == null) return null;
    var n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  function _ev(value, state, note) {
    return { value: value, ev: state || 'gap', note: note || null };
  }

  function _delta(current, prior) {
    if (current == null || prior == null || prior === 0) return null;
    var diff = current - prior;
    var pct  = (diff / prior) * 100;
    return {
      value: diff,
      pct: pct,
      direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
    };
  }

  /**
   * Pick the most recent month key from a monthly dict { 'YYYY-MM': ... }.
   * offset=0 → current, offset=1 → prior, etc.
   */
  function _latestMonthKey(monthlyDict, offset) {
    if (!monthlyDict || typeof monthlyDict !== 'object') return null;
    var keys = Object.keys(monthlyDict).sort();
    var idx = keys.length - 1 - (offset || 0);
    return idx >= 0 ? keys[idx] : null;
  }

  /**
   * Pick the most recent month from a monthly list [{ month: 'YYYY-MM', ... }].
   * offset=0 → current, offset=1 → prior
   */
  function _latestMonthItem(monthlyList, offset) {
    if (!Array.isArray(monthlyList) || !monthlyList.length) return null;
    var sorted = monthlyList.slice().sort(function (a, b) {
      return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
    });
    var idx = sorted.length - 1 - (offset || 0);
    return idx >= 0 ? sorted[idx] : null;
  }

  function _selectPeriod(monthlyData, timeframe, isList) {
    if (!monthlyData) return { current: null, prior: null };
    var currentItem, priorItem;

    if (timeframe === 'prior_month') {
      if (isList) {
        currentItem = _latestMonthItem(monthlyData, 1);
        priorItem   = _latestMonthItem(monthlyData, 2);
      } else {
        var k0 = _latestMonthKey(monthlyData, 1);
        var k1 = _latestMonthKey(monthlyData, 2);
        currentItem = k0 ? monthlyData[k0] : null;
        priorItem   = k1 ? monthlyData[k1] : null;
      }
    } else {
      if (isList) {
        currentItem = _latestMonthItem(monthlyData, 0);
        priorItem   = _latestMonthItem(monthlyData, 1);
      } else {
        var ck = _latestMonthKey(monthlyData, 0);
        var pk = _latestMonthKey(monthlyData, 1);
        currentItem = ck ? monthlyData[ck] : null;
        priorItem   = pk ? monthlyData[pk] : null;
      }
    }

    return { current: currentItem, prior: priorItem };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     CUBE AGGREGATION HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * Rule 6 of the model: online = eCommerce + K2K + API.
   * The sell cube changed its channel labels mid-series: months 2024-08 through
   * 2025-07 use 'eCommerce' / 'K2K' / 'API' / 'Offline', and from 2025-08
   * onwards they collapse to 'Online' / 'Offline'. Matching only 'Online' —
   * which is what this adapter used to do — silently counted every online sale
   * before Aug-2025 as offline, deflating online % for any timeframe that
   * reaches back that far.
   */
  var ONLINE_CHANNELS = { 'online': 1, 'ecommerce': 1, 'k2k': 1, 'api': 1 };
  function _isOnlineChannel(channel) {
    return ONLINE_CHANNELS[String(channel || '').toLowerCase()] === 1;
  }

  /**
   * From a list of cube rows for one company, aggregate by timeframe.
   * Sell cube rows: { month, channel, sell_gmv }
   * Returns { total, online, offline, months: [sorted unique months] }
   */
  function _aggregateSellCube(rows, timeframe) {
    if (!rows || !rows.length) return null;

    var filtered = _filterByTimeframe(rows, timeframe);
    if (!filtered.length) return null;

    var total = 0, online = 0, offline = 0, selfSale = 0, selfOnline = 0;
    filtered.forEach(function (r) {
      var v = _num(r.sell_gmv) || 0;
      total += v;
      if (_isOnlineChannel(r.channel)) online += v;
      else offline += v;
      /* self_sale_gmv son filas de SALE_DETAILS cuyo customer_name es la propia
         compañía: no son ventas, son sus compras por canales Koronet espejadas
         en la tabla de ventas. Quedan fuera de total/online/offline (el cubo ya
         las separa) y se exponen aparte porque el monto es la señal de cuánto
         compra la cuenta — cruza contra las compras atribuidas de indirect fees. */
      var sv = _num(r.self_sale_gmv) || 0;
      selfSale += sv;
      if (_isOnlineChannel(r.channel)) selfOnline += sv;
    });

    var months = _uniqueMonths(filtered);
    return { total: total, online: online, offline: offline, months: months,
             self_sale: selfSale, self_sale_online: selfOnline };
  }

  /**
   * From a list of buy cube rows for one company, aggregate by timeframe.
   * Buy cube rows: { month, buy_gmv, buy_online, buy_offline }
   */
  function _aggregateBuyCube(rows, timeframe) {
    if (!rows || !rows.length) return null;

    var filtered = _filterByTimeframe(rows, timeframe);
    if (!filtered.length) return null;

    var total = 0, online = 0, offline = 0;
    filtered.forEach(function (r) {
      total   += _num(r.buy_gmv) || 0;
      online  += _num(r.buy_online) || 0;
      offline += _num(r.buy_offline) || 0;
    });

    var months = _uniqueMonths(filtered);
    return { total: total, online: online, offline: offline, months: months };
  }

  /**
   * From a list of fees cube rows for one company, aggregate.
   * Fees cube rows: { company_id, period, fee_channel, fee_amount }
   * The fees cube now has real monthly grain (2025-01 → 2026-08), so it is
   * filtered by timeframe exactly like the sell and buy cubes. Before this fix
   * every fee row of the company was summed regardless of month, and the old
   * cube stored prior-year YTD as a single row with month '2025-01' and
   * fee_channel 'total' — so "Fees YTD" reported 2026 + 2025 ($2.51M instead of
   * $1.47M at network level).
   */
  function _aggregateFeesCube(rows, timeframe) {
    if (!rows || !rows.length) return null;

    rows = _filterByTimeframe(rows, timeframe);
    if (!rows.length) return null;

    var total = 0;
    var byChannel = { ecom: 0, k2k: 0, api: 0, indirect: 0 };
    rows.forEach(function (r) {
      var v = _num(r.fee_amount) || 0;
      total += v;
      var ch = (r.fee_channel || '').toLowerCase();
      if (ch === 'ecom') byChannel.ecom += v;
      else if (ch === 'k2k') byChannel.k2k += v;
      else if (ch === 'api') byChannel.api += v;
      else byChannel.indirect += v;
    });

    return { total: total, byChannel: byChannel };
  }

  /**
   * Filter cube rows by timeframe.
   * Each row has a .month field ('YYYY-MM').
   */
  /**
   * Anchor month for relative periods: the last closed month of the sell cube.
   * Set once at load. Using each cube's own last month instead would put every
   * metric on a slightly different 12-month window.
   */
  function _anchorMonth() {
    if (_state.anchorMonth) return _state.anchorMonth;
    var max = null;
    (_state.sellCube || []).forEach(function (r) {
      if (r.month && (max === null || r.month > max)) max = r.month;
    });
    _state.anchorMonth = max || '2026-07';
    return _state.anchorMonth;
  }

  function _shiftMonth(m, n) {
    var y = parseInt(m.slice(0, 4), 10);
    var mo = parseInt(m.slice(5, 7), 10) + n;
    y += Math.floor((mo - 1) / 12);
    mo = ((mo - 1) % 12 + 12) % 12 + 1;
    return y + '-' + (mo < 10 ? '0' + mo : String(mo));
  }

  /**
   * Explicit month range for each timeframe token. Every period is a real
   * [from, to] window, so a metric can never silently include months outside
   * the period the user selected.
   *
   *   ytd        2026 year to date        (Jan 2026 → anchor)
   *   h1_2026    first half of 2026       (Jan → Jun 2026)
   *   full_2025  all of 2025              (Jan → Dec 2025)
   *   l12m       last 12 months           (anchor-11 → anchor)
   */
  function _timeframeRange(timeframe) {
    var anchor = _anchorMonth();
    switch (timeframe) {
      case 'h1_2026':   return { from: '2026-01', to: '2026-06' };
      case 'full_2025': return { from: '2025-01', to: '2025-12' };
      case 'l12m':      return { from: _shiftMonth(anchor, -11), to: anchor };
      case 'ytd':
      default:          return { from: anchor.slice(0, 4) + '-01', to: anchor };
    }
  }

  /* Fraction of a year the timeframe covers — the factor that brings the annual
     Est GMV down to the window every other column is measured over. The estimate
     has no monthly series behind it (the cascade, ORA and the external model all
     emit one yearly figure), so this is a flat split: 8/12 for YTD through
     August, 6/12 for H1, 1 for the two 12-month windows. Even seasonality is an
     assumption, and a wrong one month to month for flowers — but it is the only
     split the source supports, and far less wrong than eight months of measured
     flow over twelve months of estimate. */
  function _timeframeMonths(timeframe) {
    var win = _timeframeRange(timeframe);
    var f = win.from.split('-').map(Number);
    var t = win.to.split('-').map(Number);
    return (t[0] - f[0]) * 12 + (t[1] - f[1]) + 1;
  }

  function _periodFraction(timeframe) {
    var m = _timeframeMonths(timeframe);
    return m > 0 ? m / 12 : 1;
  }

  function _filterByTimeframe(rows, timeframe) {
    if (!rows || !rows.length) return [];

    var allMonths = _uniqueMonths(rows);

    if (timeframe === 'current_month') {
      var latest = allMonths[allMonths.length - 1];
      return latest ? rows.filter(function (r) { return r.month === latest; }) : [];
    }

    if (timeframe === 'prior_month') {
      var prior = allMonths.length >= 2 ? allMonths[allMonths.length - 2] : null;
      return prior ? rows.filter(function (r) { return r.month === prior; }) : [];
    }

    var win = _timeframeRange(timeframe);
    return rows.filter(function (r) {
      return r.month && r.month >= win.from && r.month <= win.to;
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     INDIRECT FEES
  ─────────────────────────────────────────────────────────────────────────

     Koronet charges the transaction fee to the SELLER. So when one of our
     accounts *buys* through a Koronet channel, the fee is paid by its
     supplier and never shows up against the buyer. Indirect fees estimate
     that buy-side value: 1.5% of what the account bought through channels
     that carry a fee (eCommerce, K2K, API — Offline is excluded).

     The buyer is identified through K2K_CONNECTIONS, not by matching names:
     SALE_DETAILS (company_id = seller, customer_id) → k2k_customer_id = the
     buyer's real company_id. It is a deterministic join on ids. An earlier
     attempt matched customer_name with Jaro-Winkler ≥ 0.93 and could not
     discriminate in floral naming — "Flowers By Dick & Son" scored the same
     against "Flowers By Cindy" as the true "Mayesh Wholesale" match.

     Connection status is kept per row so the included set can change without
     re-querying Snowflake. Default is Active + Suspended: a connection that
     is suspended today does not invalidate purchases that already happened
     inside the period — the status is a current state, not a historical one.

     THE RATE IS NOT A FLAT 1.5%. It is each seller's REALISED rate — the fees
     Koronet actually billed that seller on that channel, divided by that
     seller's sales we measure on the same channel and window. The cube ships
     `indirect_fee` already computed that way; `fee_rates_by_seller.json` holds
     the 280 rates and their inputs.

     Why realised and not the configured rate: the configuration does not
     predict what gets billed. Kennicott has 0.75% configured on eCommerce and
     realises 0.068%; Rosaprima has 1.5% on API and realises 0.003%.

     Why this is self-consistent: numerator (billed fees) and denominator (our
     measured sales) come from the same window, and the attributed purchases we
     multiply by come from the same table with the same filters — so any gap
     between Koronet's billing base and ours cancels out.

     Effect vs the flat 1.5%: K2K barely moves (−0.3%, so 1.5% really is the
     K2K rate), eCommerce drops 33.9% and API drops 99.3%. 89% of the total
     change comes from five seller × channel pairs whose suppliers demonstrably
     pay near zero on those channels. Overall $3.75M → $2.62M.

     Below $100K of seller sales on a channel the ratio is noise, so the cube
     falls back to that channel's network rate.
  */
  var INDIRECT_FEE_RATE = 0.015;   // solo fallback si el cubo no trae indirect_fee
  var INDIRECT_STATUSES = { 'Active': 1, 'Suspended': 1 };

  function _aggregateIndirectCube(rows, timeframe) {
    if (!rows || !rows.length) return null;
    rows = _filterByTimeframe(rows, timeframe);
    if (!rows.length) return null;

    var attributed = 0, fees = 0;
    var byChannel = { ecom: 0, k2k: 0, api: 0 };
    var counted = false;
    rows.forEach(function (r) {
      if (INDIRECT_STATUSES[r.connection_status] !== 1) return;
      var v = _num(r.buy_online_attributed) || 0;
      attributed += v;
      // El cubo trae el fee con la tasa real del vendedor; el 1,5% queda solo
      // como red de seguridad si algún día el campo faltara.
      var f = r.indirect_fee != null ? (_num(r.indirect_fee) || 0) : v * INDIRECT_FEE_RATE;
      fees += f;
      counted = true;
      var ch = (r.fee_channel || '').toLowerCase();
      if (byChannel[ch] !== undefined) byChannel[ch] += v;
    });
    if (!counted) return null;

    return {
      attributed: attributed,
      fees: fees,
      effective_rate: attributed > 0 ? fees / attributed : null,
      byChannel: byChannel
    };
  }

  function _indirectMonthlyTotals(rows) {
    if (!rows || !rows.length) return [];
    var byMonth = {};
    rows.forEach(function (r) {
      if (!r.month || INDIRECT_STATUSES[r.connection_status] !== 1) return;
      if (!byMonth[r.month]) byMonth[r.month] = { month: r.month, fee_amount: 0 };
      byMonth[r.month].fee_amount += (r.indirect_fee != null
        ? (_num(r.indirect_fee) || 0)
        : (_num(r.buy_online_attributed) || 0) * INDIRECT_FEE_RATE);
    });
    return Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; });
  }

  /**
   * Prior-year window for a like-for-like comparison.
   * Given the months actually present in the current period, returns the same
   * window shifted back 12 months. Before this, the prior windows were
   * hardcoded to '2025-01'..'2025-07', which stopped being like-for-like the
   * moment a cube gained an eighth month (comparing 8 months against 7 invents
   * growth).
   */
  function _priorYearWindow(months) {
    if (!months || !months.length) return null;
    function shift(m) {
      var y = parseInt(m.slice(0, 4), 10);
      return (y - 1) + m.slice(4);
    }
    return { from: shift(months[0]), to: shift(months[months.length - 1]) };
  }

  /**
   * Earliest month present anywhere in a whole cube (not in one company's
   * rows). Coverage is a property of the cube: a company with no fee rows in
   * January simply earned no fees that month — that is a zero, not a gap.
   * Checking per-company rows instead would drop legitimate baselines.
   */
  /**
   * The months a timeframe covers, derived from the WHOLE cube rather than
   * from one company's rows. A period is a property of the data, not of the
   * account: if each account defined its own window, an account that only
   * traded in March would compare Mar–Aug against Mar–Aug while its neighbour
   * compared Jan–Aug, and the portfolio total would stop meaning anything.
   */
  var _periodMonthsCache = {};
  function _periodMonths(cubeName, allRows, timeframe) {
    var key = cubeName + '|' + (timeframe || 'ytd');
    if (_periodMonthsCache[key] !== undefined) return _periodMonthsCache[key];
    var months = _uniqueMonths(_filterByTimeframe(allRows || [], timeframe));
    _periodMonthsCache[key] = months;
    return months;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DATA QUALITY — known-bad cube rows
  ─────────────────────────────────────────────────────────────────────────

     Ninfa Flowers (640977) reports Apr–Oct 2025 at three orders of magnitude
     above its own baseline: $268,182,503 in April 2025 alone, against months
     of $6K–$627K before and after. In the source, that April has 16 lines over
     $100K including a single line of $31,239,146, and June jumps to 22,930
     lines against 1,429 in March — so it is not a handful of bad rows but a
     whole period, most likely an unconverted currency or a duplicated import.
     Left in, it is 20% of the entire buy cube. From Nov-2025 the account runs
     at ~$500K a month, an order of magnitude above its 2024 baseline: that
     looks like genuine growth and is kept.

     PROCUREMENT_DETAILS has no equivalent of the sales < 100000 guard, so
     nothing upstream filters this. It needs a fix at the source.

     Note on CONNECTION FLOWERS SAS (617226): the cube generated on 2026-08-13
     showed $10.4B for April 2025 — 64% of that whole cube — and used to be
     excluded here. The regenerated sell cube applies the model's
     `sales < 100000` guard, which drops the offending lines on its own: that
     window now sums $143,353 across 17 orders, a plausible figure. The
     exclusion was removed rather than kept "just in case", because it would
     now delete real sales. The underlying rows are still wrong in the source
     (April 2025 has 9 lines over $100K, the largest $6.2M), so loosening that
     threshold would let the account contaminate the cube again.
  */
  var BAD_CUBE_ROWS = {
    buy: [
      { company_id: '640977', from: '2025-04', to: '2025-10',
        reason: 'Valores 3 órdenes de magnitud sobre su propia línea base (verificado 2026-09-08)' }
    ],
    sell: []
  };

  function _isBadCubeRow(cube, row) {
    if (!row) return false;
    var rules = BAD_CUBE_ROWS[cube];
    if (!rules || !rules.length) return false;
    var id = _sid(row.company_id);
    var m = row.month;
    if (!id || !m) return false;
    for (var i = 0; i < rules.length; i++) {
      var b = rules[i];
      if (b.company_id === id && m >= b.from && m <= b.to) return true;
    }
    return false;
  }

  var _cubeStartCache = {};
  function _cubeStart(cubeName, allRows) {
    if (_cubeStartCache[cubeName] !== undefined) return _cubeStartCache[cubeName];
    var min = null;
    (allRows || []).forEach(function (r) {
      if (r.month && (min === null || r.month < min)) min = r.month;
    });
    _cubeStartCache[cubeName] = min;
    return min;
  }

  /**
   * Sum one field of the cube rows inside an explicit [from, to] month window.
   * Returns null when the CUBE does not reach back far enough to cover the
   * window, so a partial baseline never masquerades as a real prior-period
   * figure (the sell cube starts 2024-08 and the fees cube 2025-01, so e.g.
   * "Full year 2025" has no sell YoY and "Last 12 months" has no fees YoY).
   */
  /**
   * Same as _sumWindow but only over rows the predicate accepts — used for the
   * online slice of the sell/buy cubes and for the indirect cube's status
   * filter, where the prior-period figure needs the same subset as the current
   * one or the comparison is meaningless.
   */
  function _sumWindowWhere(rows, field, win, cubeName, allRows, pred) {
    if (!win) return null;
    var start = _cubeStart(cubeName, allRows);
    if (start === null || start > win.from) return null;
    if (!rows || !rows.length) return 0;
    var t = 0;
    rows.forEach(function (r) {
      if (r.month && r.month >= win.from && r.month <= win.to && pred(r)) t += _num(r[field]) || 0;
    });
    return t;
  }

  /** Number of calendar months in an inclusive [from, to] window. */
  function _monthSpan(win) {
    if (!win) return 0;
    var y1 = parseInt(win.from.slice(0, 4), 10), m1 = parseInt(win.from.slice(5, 7), 10);
    var y2 = parseInt(win.to.slice(0, 4), 10),   m2 = parseInt(win.to.slice(5, 7), 10);
    return (y2 - y1) * 12 + (m2 - m1) + 1;
  }

  /**
   * Percent change against the prior period.
   * Returns { pct } normally; { from_zero: true } when the account went from
   * nothing to something, because a percentage off a zero (or near-zero)
   * baseline is either infinite or a four-digit number that tells the reader
   * less than the words "new" would. Kennicott's buy really did go from $980K
   * to $35.9M after onboarding procurement — +3,561% is accurate and unreadable.
   */
  var TREND_BASELINE_FLOOR = 1000;
  function _pctChange(curr, prior) {
    if (curr == null) return null;
    if (prior == null) return null;
    if (prior < TREND_BASELINE_FLOOR) {
      return (curr >= TREND_BASELINE_FLOOR) ? { from_zero: true } : null;
    }
    return { pct: ((curr - prior) / prior) * 100 };
  }

  /** Difference in percentage points, for metrics that are already percentages. */
  function _ppChange(curr, prior) {
    if (curr == null || prior == null) return null;
    return { pp: curr - prior };
  }

  function _sumWindow(rows, field, win, cubeName, allRows) {
    if (!win) return null;
    var start = _cubeStart(cubeName, allRows);
    if (start === null || start > win.from) return null;   // cube starts too late
    if (!rows || !rows.length) return 0;                   // covered, but nothing happened
    var t = 0;
    rows.forEach(function (r) {
      if (r.month && r.month >= win.from && r.month <= win.to) t += _num(r[field]) || 0;
    });
    return t;
  }

  function _uniqueMonths(rows) {
    var monthSet = {};
    rows.forEach(function (r) { if (r.month) monthSet[r.month] = true; });
    return Object.keys(monthSet).sort();
  }

  /**
   * Get monthly totals for sell cube rows (both channels summed per month).
   * Returns sorted array of { month, sell_gmv, sell_online, sell_offline }
   */
  function _sellMonthlyTotals(rows) {
    if (!rows || !rows.length) return [];
    var byMonth = {};
    rows.forEach(function (r) {
      var m = r.month;
      if (!m) return;
      if (!byMonth[m]) byMonth[m] = { month: m, sell_gmv: 0, sell_online: 0, sell_offline: 0 };
      var v = _num(r.sell_gmv) || 0;
      byMonth[m].sell_gmv += v;
      byMonth[m].self_sale_gmv = (byMonth[m].self_sale_gmv || 0) + (_num(r.self_sale_gmv) || 0);
      if (_isOnlineChannel(r.channel)) byMonth[m].sell_online += v;
      else byMonth[m].sell_offline += v;
    });
    return Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; });
  }

  /**
   * Get monthly totals for buy cube rows.
   * Returns sorted array of { month, buy_gmv, buy_online, buy_offline }
   */
  function _buyMonthlyTotals(rows) {
    if (!rows || !rows.length) return [];
    var byMonth = {};
    rows.forEach(function (r) {
      var m = r.month;
      if (!m) return;
      if (!byMonth[m]) byMonth[m] = { month: m, buy_gmv: 0, buy_online: 0, buy_offline: 0 };
      byMonth[m].buy_gmv    += _num(r.buy_gmv) || 0;
      byMonth[m].buy_online += _num(r.buy_online) || 0;
      byMonth[m].buy_offline += _num(r.buy_offline) || 0;
    });
    return Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; });
  }

  /**
   * Get monthly totals for fees cube rows (all fee channels summed per month).
   * Returns sorted array of { month, fee_amount, ecom, k2k, api }.
   * Only meaningful since the cube was regenerated with real monthly grain.
   */
  function _feesMonthlyTotals(rows) {
    if (!rows || !rows.length) return [];
    var byMonth = {};
    rows.forEach(function (r) {
      var m = r.month;
      if (!m) return;
      if (!byMonth[m]) byMonth[m] = { month: m, fee_amount: 0, ecom: 0, k2k: 0, api: 0 };
      var v = _num(r.fee_amount) || 0;
      byMonth[m].fee_amount += v;
      var ch = (r.fee_channel || '').toLowerCase();
      if (ch === 'ecom' || ch === 'k2k' || ch === 'api') byMonth[m][ch] += v;
    });
    return Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     LOAD ALL FILES
  ───────────────────────────────────────────────────────────────────────── */

  function _buildLookups() {
    // accounts_v3 → accountById, idToName, nameToId
    if (Array.isArray(_state.accountsV3)) {
      _state.accountsV3.forEach(function (rec) {
        var id = _sid(rec.company_id);
        if (id && EXCLUDED_IDS[id]) return;
        if (!id) {
          // Prospects / accounts without a Koronet company_id: key by sfdc_id
          // so they are browsable (empty transaction cards, TAM/potential only).
          if (!rec.sfdc_id) return;
          id = 'sfdc:' + rec.sfdc_id;
        }
        _state.accountById[id] = rec;
        _state.idToName[id] = rec.company_name;
        if (rec.company_name) {
          // Real company_ids win the name→id mapping; synthetic only fills gaps.
          if (id.indexOf('sfdc:') === 0) {
            if (!_state.nameToId[rec.company_name]) _state.nameToId[rec.company_name] = id;
          } else {
            _state.nameToId[rec.company_name] = id;
          }
        }
      });
    }

    // sell cube → sellCubeById (dropping known-bad company-months first)
    if (Array.isArray(_state.sellCube)) {
      _state.sellCube = _state.sellCube.filter(function (row) {
        return !_isBadCubeRow('sell', row);
      });
      _state.sellCube.forEach(function (row) {
        var id = _sid(row.company_id);
        if (!id) return;
        if (!_state.sellCubeById[id]) _state.sellCubeById[id] = [];
        _state.sellCubeById[id].push(row);
      });
    }

    // indirect fees cube → indirectCubeById (keyed by the BUYER's company_id)
    if (Array.isArray(_state.indirectCube)) {
      _state.indirectCube.forEach(function (row) {
        var id = _sid(row.buyer_company_id);
        if (!id) return;
        if (!_state.indirectCubeById[id]) _state.indirectCubeById[id] = [];
        _state.indirectCubeById[id].push(row);
      });
    }

    // buy cube → buyCubeById (dropping known-bad company-months first)
    if (Array.isArray(_state.buyCube)) {
      _state.buyCube = _state.buyCube.filter(function (row) {
        return !_isBadCubeRow('buy', row);
      });
      _state.buyCube.forEach(function (row) {
        var id = _sid(row.company_id);
        if (!id) return;
        if (!_state.buyCubeById[id]) _state.buyCubeById[id] = [];
        _state.buyCubeById[id].push(row);
      });
    }

    // fees cube → feesCubeById
    if (Array.isArray(_state.feesCube)) {
      _state.feesCube.forEach(function (row) {
        var id = _sid(row.company_id);
        if (!id) return;
        if (!_state.feesCubeById[id]) _state.feesCubeById[id] = [];
        _state.feesCubeById[id].push(row);
      });
    }

    // gmv pacing → pacingById
    if (Array.isArray(_state.gmvPacing)) {
      _state.gmvPacing.forEach(function (rec) {
        var id = _sid(rec.company_id);
        if (id) _state.pacingById[id] = rec;
      });
    }

    // gmv external → externalById
    if (Array.isArray(_state.gmvExternal)) {
      _state.gmvExternal.forEach(function (rec) {
        var id = _sid(rec.company_id);
        if (id) _state.externalById[id] = rec;
      });
    }

    // vendors list → dict by name (+ by id)
    if (Array.isArray(_state.vendors)) {
      _state.vendors.forEach(function (rec) {
        if (rec.company_name) _state.vendorsByName[rec.company_name] = rec;
        var vid = _sid(rec.company_id);
        if (vid) _state.vendorsById[vid] = rec;
      });
    }

    // skus_online_offline (name → obj) → also index by id
    if (_state.skusOnlineOffline && typeof _state.skusOnlineOffline === 'object') {
      Object.keys(_state.skusOnlineOffline).forEach(function (nm) {
        var rec = _state.skusOnlineOffline[nm];
        var sid = rec && _sid(rec.company_id);
        if (sid) _state.skusById[sid] = rec;
      });
    }

    // buyers (name → obj) → also index by id
    if (_state.buyers && typeof _state.buyers === 'object') {
      Object.keys(_state.buyers).forEach(function (nm) {
        var rec = _state.buyers[nm];
        var bid = rec && _sid(rec.company_id);
        if (bid) _state.buyersById[bid] = rec;
      });
    }

    // hardgoods list → dict by name
    if (Array.isArray(_state.hardgoods)) {
      _state.hardgoods.forEach(function (rec) {
        if (rec.company_name) _state.hardgoodsByName[rec.company_name] = rec;
      });
    }

    // temporal: sell_anticipation by company_name
    var tempSA = (_state.temporal && _state.temporal.sell_anticipation && _state.temporal.sell_anticipation.data) || [];
    tempSA.forEach(function (row) {
      var n = row.company_name;
      if (n) {
        if (!_state.temporalSellAnticipation[n]) _state.temporalSellAnticipation[n] = [];
        _state.temporalSellAnticipation[n].push(row);
      }
      var rid = _sid(row.company_id);
      if (rid) {
        if (!_state.temporalSAById[rid]) _state.temporalSAById[rid] = [];
        _state.temporalSAById[rid].push(row);
      }
    });

    // temporal: variety_freshness by company_name
    var tempVF = (_state.temporal && _state.temporal.variety_freshness && _state.temporal.variety_freshness.data) || [];
    tempVF.forEach(function (row) {
      var n = row.company_name;
      if (n) {
        if (!_state.temporalVarietyFreshness[n]) _state.temporalVarietyFreshness[n] = [];
        _state.temporalVarietyFreshness[n].push(row);
      }
      var rid = _sid(row.company_id);
      if (rid) {
        if (!_state.temporalVFById[rid]) _state.temporalVFById[rid] = [];
        _state.temporalVFById[rid].push(row);
      }
    });

    // temporal: forward_inventory_depth by company_name
    var tempFI = (_state.temporal && _state.temporal.forward_inventory_depth && _state.temporal.forward_inventory_depth.data) || [];
    tempFI.forEach(function (row) {
      var n = row.company_name;
      if (n) {
        if (!_state.temporalForwardInventory[n]) _state.temporalForwardInventory[n] = [];
        _state.temporalForwardInventory[n].push(row);
      }
      var rid = _sid(row.company_id);
      if (rid) {
        if (!_state.temporalFIById[rid]) _state.temporalFIById[rid] = [];
        _state.temporalFIById[rid].push(row);
      }
    });

    // Supplement name→id from V2 evidence files (buyers, vendors) for accounts
    // not in accounts_v3 but present in V2 data
    if (_state.buyers && typeof _state.buyers === 'object') {
      Object.keys(_state.buyers).forEach(function (name) {
        if (!_state.nameToId[name]) {
          // Try to find id from sell cube or buy cube data
          // Not critical — V2 compat only
        }
      });
    }
  }

  function _loadAll() {
    if (_state.loadPromise) return _state.loadPromise;

    var promises = Object.keys(FILES).map(function (key) {
      return _fetchJson(FILES[key]).then(function (data) {
        return { key: key, data: data };
      });
    });

    _state.loadPromise = Promise.all(promises).then(function (results) {
      results.forEach(function (r) {
        if (!r.data) return;

        switch (r.key) {
          // V3 new files
          case 'accountsV3':
            _state.accountsV3 = (r.data && Array.isArray(r.data.accounts)) ? r.data.accounts : [];
            break;
          case 'sellCube':
            _state.sellCube = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
            break;
          case 'buyCube':
            _state.buyCube = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
            break;
          case 'indirectCube':
            _state.indirectCube = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
            break;
          case 'feesCube':
            _state.feesCube = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
            break;
          case 'gmvPacing':
            _state.gmvPacing = (r.data && Array.isArray(r.data.pacing)) ? r.data.pacing : [];
            break;
          case 'whUniverse': {
            var _pids = (r.data && Array.isArray(r.data.portfolio_sfdc_ids)) ? r.data.portfolio_sfdc_ids : null;
            if (_pids) {
              _state.whUniverse = {};
              _pids.forEach(function (x) { if (x) _state.whUniverse[String(x)] = true; });
            }
            var _oids = (r.data && Array.isArray(r.data.only_618_sfdc_ids)) ? r.data.only_618_sfdc_ids : null;
            if (_oids) {
              _state.wh618 = {};
              _oids.forEach(function (x) { if (x) _state.wh618[String(x)] = true; });
            }
            break;
          }

          case 'gmvExternal':
            _state.gmvExternal = (r.data && Array.isArray(r.data.estimates)) ? r.data.estimates : [];
            break;

          // V2 legacy files
          case 'buyers':
            _state.buyers = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'vendors':
            _state.vendors = (r.data && Array.isArray(r.data.companies)) ? r.data.companies : [];
            break;
          case 'temporal':
            _state.temporal = r.data || {};
            break;
          case 'inventory':
            _state.inventory = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'benchmarks':
            _state.benchmarks = (r.data && r.data.benchmarks) ? r.data.benchmarks : {};
            break;
          case 'config':
            _state.config = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'hardgoods':
            _state.hardgoods = (r.data && Array.isArray(r.data.companies)) ? r.data.companies : [];
            break;
          case 'skusOnlineOffline':
            _state.skusOnlineOffline = (r.data && r.data.companies) ? r.data.companies : {};
            break;
        }
      });

      _buildLookups();
      _state.loaded = true;
    });

    return _state.loadPromise;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SECTION BUILDERS
  ───────────────────────────────────────────────────────────────────────── */

  /** IDENTITY — from accounts_v3 (primary) */
  function _buildIdentity(companyId) {
    var id  = _sid(companyId);
    var rec = _state.accountById[id];
    if (!rec) return null;

    return {
      company_id:       rec.company_id != null ? _sid(rec.company_id) : null,
      company_name:     rec.company_name || null,
      account_class:    rec.account_class || null,
      business_type:    rec.business_type || null,
      segment:          rec.segment || null,
      product_tier:     rec.product_tier || null,
      sell_channel:     rec.sell_channel || null,
      potential_tier:   rec.potential_tier || null,
      impl_stage_display: rec.impl_stage_display || null,
      digital_pct_caveat: rec.digital_pct_caveat || null,
      has_active_pmt:   rec.has_active_pmt || false,
      pmt_lead:         rec.pmt_lead || null,
      pmt_status:       rec.pmt_status || null,
      pmt_health:       rec.pmt_health || null,
      priority_level:   rec.priority_level || null,
      engagement_status: rec.engagement_status || null,
      komet_status:     rec.komet_status || null,
      industry:         rec.industry || null,
      sfdc_id:          rec.sfdc_id || null,
      impl_stage:       rec.impl_stage || null,
      impl_type:        rec.impl_type || null,
      ct_id:            rec.ct_id || null,
      sfdc_type:        rec.sfdc_type || null,
      digital_pct:      _num(rec.digital_pct),
      has_eshop:        rec.has_eshop || false,
      has_procurement:  rec.has_procurement || false,
      in_christine_sheet: rec.in_christine_sheet || false,
      // V2 compat — not in accounts_v3 yet
      city:             null,
      location:         null,
      am_name:          null,
      account_manager:  null,
      status:           null,
    };
  }

  /** POTENTIAL — GMV + sell/buy/fees from cubes + pacing + external estimates */
  function _buildPotential(companyId, timeframe) {
    var _frac = _periodFraction(timeframe);
    var id   = _sid(companyId);
    var acct = _state.accountById[id] || {};
    var name = _state.idToName[id];

    // ── GMV reference (from accounts_v3 — Christine cascade)
    var gmvRef      = _num(acct.gmv_reference);
    var gmvSource   = acct.gmv_source || null;
    var gmvIsFloor  = acct.gmv_is_floor || false;
    /* `gmv_is_floor` de accounts_v3 NO alcanza para decir "esto es nuestra
       medición": 47 cuentas lo traen en true con gmv_source = 'Estimado' y sin
       ficha en los archivos de estimación, así que su significado no es
       rastreable. Solo confiamos en el piso que derivamos nosotros acá. */
    var floorDerivedHere = false;
    var buyGmvEst   = _num(acct.buy_gmv_estimated);
    /* De dónde salió el Est Buy que se muestra: cuando la compra medida supera
       la estimación del 45%, la regla del piso la reemplaza y el número que se
       ve es medición, no modelo. */
    var buyEstSource = buyGmvEst ? 'ratio' : null;

    // GMV confidence: derive from source
    var gmvConfidence = null;
    /* 'Medido (parcial)' = dejó de vender dentro de la ventana, así que el valor
       es la suma real sin proyectar. 'Medido (histórico)' = medición nuestra pero
       de otra ventana: sigue siendo medición, pero vieja. */
    if (gmvSource === 'Medido') gmvConfidence = 'Alta';
    else if (gmvSource === 'Piso de red') gmvConfidence = 'Alta';
    else if (gmvSource === 'Medido (parcial)') gmvConfidence = 'Alta';
    else if (gmvSource === 'Medido (histórico)') gmvConfidence = 'Baja';
    else if (gmvSource === 'ORA' || gmvSource === 'FCS') gmvConfidence = 'Baja';
    else if (gmvSource === 'not in Christine cascade' || gmvSource === 'Sin dato') gmvConfidence = null;

    // ── Pacing
    var paceRec  = _state.pacingById[id] || null;
    var gmvPace  = null;
    if (paceRec) {
      gmvPace = {
        value: _num(paceRec.annual_pace),
        daily_rate: _num(paceRec.daily_rate),
        confidence: paceRec.confidence || null,
      };
    }

    // ── External estimate
    var extRec = _state.externalById[id] || null;
    var gmvExternal = null;
    if (extRec) {
      gmvExternal = {
        value: _num(extRec.estimated_gmv_mid),
        methods: extRec.methods_used || [],
        confidence: extRec.confidence || null,
      };
    }

    // ── GMV ORA (from pacing record if source is ORA)
    var gmvOra = null;
    if (gmvSource === 'ORA' && gmvRef) {
      gmvOra = { value: gmvRef };
    }

    // ── Sell cube aggregation
    var sellRows  = _state.sellCubeById[id] || [];
    var sellAgg   = _aggregateSellCube(sellRows, timeframe);
    var sellAggYtd = _aggregateSellCube(sellRows, 'ytd');

    // ── Sell YTD 2025 (from cube — sum months 2025-01 to 2025-07)
    // Like-for-like: mirror the months actually present in the current period.
    var sellPeriodMonths = _periodMonths('sell', _state.sellCube, timeframe);
    var sellYtd2025 = _sumWindow(sellRows, 'sell_gmv', _priorYearWindow(sellPeriodMonths), 'sell', _state.sellCube);

    // ── Buy cube aggregation
    var buyRows  = _state.buyCubeById[id] || [];
    var buyAgg   = _aggregateBuyCube(buyRows, timeframe);
    var buyAggYtd = _aggregateBuyCube(buyRows, 'ytd');

    // ── Buy YTD 2025
    // Like-for-like: mirror the months actually present in the current period.
    var buyPeriodMonths = _periodMonths('buy', _state.buyCube, timeframe);
    var buyYtd2025 = _sumWindow(buyRows, 'buy_gmv', _priorYearWindow(buyPeriodMonths), 'buy', _state.buyCube);

    // ── Fees cube aggregation
    var feesRows = _state.feesCubeById[id] || [];
    var feesAgg  = _aggregateFeesCube(feesRows, timeframe);
    var feesYtd2026 = feesAgg ? feesAgg.total : null;
    var feesByChannel = feesAgg ? feesAgg.byChannel : null;

    // ── Prior-period fees — now available: the cube has real monthly grain
    // from 2025-01, so the same window shifted back 12 months can be summed
    // directly. This enables the fees YoY that was always null before.
    var feesMonths = _periodMonths('fees', _state.feesCube, timeframe);
    var feesYtd2025 = _sumWindow(feesRows, 'fee_amount', _priorYearWindow(feesMonths), 'fees', _state.feesCube);

    // ── Indirect fees (buy side) — 1.5% of what this account bought through
    // fee-carrying channels, attributed via K2K_CONNECTIONS.
    var indirectRows = _state.indirectCubeById[id] || [];
    var indirectAgg  = _aggregateIndirectCube(indirectRows, timeframe);
    var feesIndirect = indirectAgg ? indirectAgg.fees : null;
    var buyAttributed = indirectAgg ? indirectAgg.attributed : null;

    // Direct fees are what the fees cube already measures (the sell side).
    var feesDirect = feesYtd2026;
    var feesTotal = (feesDirect || 0) + (feesIndirect || 0);
    if (!feesDirect && !feesIndirect) feesTotal = null;

    // Offline amounts
    var sellOfflineYtd = sellAgg ? (sellAgg.offline > 0 ? sellAgg.offline : null) : null;
    var buyOfflineYtd  = buyAgg  ? (buyAgg.offline  > 0 ? buyAgg.offline  : null) : null;

    // ── Koronet YTD totals
    var koronetSellYtd = sellAgg ? sellAgg.total : null;
    var koronetBuyYtd  = buyAgg  ? buyAgg.total  : null;

    // ── Online amounts (for online % calculation below)
    var onlineSellYtd = sellAgg ? sellAgg.online : 0;
    var onlineBuyYtd  = buyAgg  ? buyAgg.online  : 0;

    // ── Penetration + Piso logic
    // Rule: Est GMV can never be less than what we already measure.
    // If annualized Koronet sell > gmv_reference → the estimate was wrong.
    // Upgrade to "Piso de red" (network floor = measured minimum).
    var sellPenetration = null;
    var sellPenEv = 'gap';
    var sellPenNote = null;
    var buyPenetration = null;
    var buyPenEv = 'gap';
    var buyPenNote = null;

    /* Dos preguntas distintas, y confundirlas era el bug.
     *
     * El PISO es anual y es sobre la cuenta: ¿lo que mueve en un año supera el
     * estimado anual? No puede depender de la ventana elegida — condicionado a
     * que haya actividad dentro del período, una cuenta sin ventas en el 1er
     * semestre se quedaba con un estimado viejo y bajaba de banda de GMV con
     * solo cambiar el selector.
     *
     * La PENETRACIÓN es período contra período: lo que capturamos en la
     * ventana sobre el estimado prorrateado a esa misma ventana. */
    var sellYearAgg = _aggregateSellCube(sellRows, 'l12m');
    var buyYearAgg  = _aggregateBuyCube(buyRows, 'l12m');
    var yearSellMonths = sellYearAgg ? sellYearAgg.months.length : 0;
    var yearBuyMonths  = buyYearAgg  ? buyYearAgg.months.length  : 0;
    /* Misma regla que scripts/rebuild_accounts_gmv.py, que produce el
       gmv_reference contra el que esto se compara: se anualiza solo si la cuenta
       seguía vendiendo en el último mes de la ventana. Si paró adentro, proyectar
       sus meses activos a doce inventaría volumen que ya no genera. */
    var _floorWin = _timeframeRange('l12m');
    var _mesesVentana = (sellYearAgg && sellYearAgg.months) ? sellYearAgg.months.slice().sort() : [];
    var _ultimoEnVentana = _mesesVentana.length ? _mesesVentana[_mesesVentana.length - 1] : null;
    var _paroEnVentana = _ultimoEnVentana != null && _ultimoEnVentana < _floorWin.to;
    var annualizedSell = (sellYearAgg && yearSellMonths > 0)
      ? sellYearAgg.total * (_paroEnVentana ? 1 : (12 / yearSellMonths)) : null;
    var annualizedBuy = (buyYearAgg && yearBuyMonths > 0)
      ? buyYearAgg.total * (12 / yearBuyMonths) : null;

    // Regla D: sin Est GMV pero con actividad Koronet → Piso de red automático
    if ((!gmvRef || gmvRef <= 0 || gmvSource === 'not in Christine cascade' || gmvSource === 'Sin dato')
        && annualizedSell && annualizedSell > 0) {
      gmvRef = annualizedSell;
      gmvSource = 'Piso de red';
      gmvConfidence = 'Alta';
      gmvIsFloor = true;
      floorDerivedHere = true;
      buyGmvEst = gmvRef * 0.45;
      buyEstSource = 'ratio';
    }

    var hasReference = gmvRef && gmvRef > 0
      && gmvSource !== 'not in Christine cascade' && gmvSource !== 'Sin dato';

    if (hasReference && annualizedSell && annualizedSell > gmvRef
        && !/^(Medido|Piso)/.test(gmvSource || '')) {
      // El estimado estaba mal: Koronet ya lo supera en un año completo.
      gmvRef = annualizedSell;
      gmvSource = 'Piso de red';
      gmvConfidence = 'Alta';
      gmvIsFloor = true;
      floorDerivedHere = true;
      buyGmvEst = gmvRef * 0.45;
      buyEstSource = 'ratio';
    }
    if (hasReference && buyGmvEst && buyGmvEst > 0 && annualizedBuy && annualizedBuy > buyGmvEst) {
      buyGmvEst = annualizedBuy;
      buyEstSource = 'floor';
    }

    /* Confiar, pero verificar. Una etiqueta de Medido / Piso de red se gana el
       ~100% tautológico solo si la cifra coincide con el cubo de sell sobre un
       año completo; si no, calculamos la penetración real y marcamos el origen
       como no verificado. accounts_v3 se generó sobre otra ventana y antes de
       que el cubo tuviera el guard R4, la deduplicación por sale_item_id y la
       separación de auto-ventas: la mediana de las 41 cuentas etiquetadas mide
       0,83 de su etiqueta, y Ninfa 0,13. */
    var claimsMeasured = /^(Medido|Piso)/.test(gmvSource || '') && gmvSource !== 'Medido (histórico)';
    var cubeAgrees = (annualizedSell != null && gmvRef > 0
      && Math.abs(annualizedSell - gmvRef) / gmvRef <= 0.10);
    var estUnverified = claimsMeasured && !cubeAgrees;
    var estIsMeasured = (floorDerivedHere || claimsMeasured) && !estUnverified;

    /* Prorrateo al período. Para un estimado externo (ORA, framework) el
       reparto plano es todo lo que la fuente soporta. Pero cuando el estimado
       ES nuestra medición, el reparto plano pelea contra la medición de la que
       salió: la cifra anual se calcula sobre una ventana fija para que el
       tamaño de cuenta no se mueva con el selector, y partirla en partes
       iguales subestima cualquier ventana donde la cuenta estuvo más activa que
       su promedio anual. Metropetals compró $466K entre enero y agosto de 2026
       contra un "estimado" prorrateado de $371K — 126%, escondido por el tope
       del 100%.

       Y en cualquier caso, el estimado no puede quedar por debajo de lo que
       medimos DENTRO de esa misma ventana: es la regla del piso de red aplicada
       al período. FreshLink arrastra un estimado de $639 etiquetado "Medido"
       contra $3,92M de venta medida en 2025, y la tabla mostraba un prolijo
       100%; la regla anual no lo alcanzaba porque dejó de vender en 2026 y la
       ventana fija no tiene filas que anualizar. */
    function _proratePeriod(annual, measured, isMeasured) {
      if (annual == null) return null;
      if (isMeasured && measured && measured > 0) return measured;
      var slice = annual * _frac;
      return (measured && measured > slice) ? measured : slice;
    }
    var gmvRefPeriod2    = _proratePeriod(gmvRef, koronetSellYtd, estIsMeasured);
    var buyGmvEstPeriod2 = _proratePeriod(buyGmvEst, koronetBuyYtd, buyEstSource === 'floor');
    var sellPeriodFloored = !estIsMeasured && koronetSellYtd != null && gmvRef != null
      && koronetSellYtd > gmvRef * _frac;
    var buyPeriodFloored = buyEstSource !== 'floor' && koronetBuyYtd != null && buyGmvEst != null
      && koronetBuyYtd > buyGmvEst * _frac;

    if (gmvRef && gmvRef > 0 && gmvSource !== 'not in Christine cascade' && gmvSource !== 'Sin dato') {
      var isTautological = claimsMeasured && cubeAgrees;

      if (koronetSellYtd && koronetSellYtd > 0) {
        sellPenetration = isTautological ? 100 : (koronetSellYtd / (gmvRefPeriod2 != null ? gmvRefPeriod2 : gmvRef * _frac)) * 100;
        sellPenEv = isTautological ? 'tautological' : (estUnverified ? 'proxy' : (gmvConfidence === 'Alta' ? 'model' : 'proxy'));
        sellPenNote = sellPeriodFloored ? (gmvSource + ' — estimado por debajo de lo medido en el período')
          : (estUnverified ? (gmvSource + ' — no verificado') : gmvSource);
      }

      if (buyGmvEst && buyGmvEst > 0 && koronetBuyYtd && koronetBuyYtd > 0) {
        /* La compra es tautológica SOLO cuando su propio estimado salió del
           piso medido: ahí el denominador ES el numerador anualizado.
           Heredar la tautología del lado de venta era un error del mismo tipo
           que el que arreglamos en venta: 35 cuentas con Est Buy de modelo
           mostraban ~100% sin haber comparado nada (Pacifica Produce compra $0
           contra un estimado de $23K; Chilfresh el 3,8%; Mayesh el 85,9%). */
        var buyTaut = buyEstSource === 'floor';
        buyPenetration = buyTaut ? 100 : (koronetBuyYtd / (buyGmvEstPeriod2 != null ? buyGmvEstPeriod2 : buyGmvEst * _frac)) * 100;
        buyPenEv = buyTaut ? 'tautological' : (estUnverified ? 'proxy' : (gmvConfidence === 'Alta' ? 'model' : 'proxy'));
        buyPenNote = buyTaut ? (gmvSource + ' — identidad: el estimado es la compra medida')
          : buyPeriodFloored ? (gmvSource + ' — estimado por debajo de lo comprado en el período')
          : (estUnverified ? (gmvSource + ' — no verificado') : gmvSource);
      }
    }

    // El estimado prorrateado todavía puede quedar debajo de un mes concentrado.
    if (sellPenetration != null && sellPenetration > 100) sellPenetration = 100;
    if (buyPenetration  != null && buyPenetration  > 100) buyPenetration  = 100;

    // ── Online % = online in the period / Est GMV prorated to that period
    // "What fraction of their business in this window is digital through us"
    // Same denominator as penetration → online% ≤ penetration always
    var sellMonthCount = sellAgg ? sellAgg.months.length : 0;
    var buyMonthCount  = buyAgg  ? buyAgg.months.length  : 0;

    var sellOnlinePct = null;
    if (koronetSellYtd && koronetSellYtd > 0 && gmvRef && gmvRef > 0) {
      if (onlineSellYtd > 0 && sellMonthCount > 0) {
        sellOnlinePct = (onlineSellYtd / (gmvRefPeriod2 != null ? gmvRefPeriod2 : gmvRef * _frac)) * 100;
      } else {
        sellOnlinePct = 0;  // has sell but no online → 0%, not null
      }
    }
    var buyOnlinePct = null;
    if (koronetBuyYtd && koronetBuyYtd > 0 && buyGmvEst && buyGmvEst > 0) {
      if (onlineBuyYtd > 0 && buyMonthCount > 0) {
        buyOnlinePct = (onlineBuyYtd / (buyGmvEstPeriod2 != null ? buyGmvEstPeriod2 : buyGmvEst * _frac)) * 100;
      } else {
        buyOnlinePct = 0;
      }
    }

    // Logical constraint: online ⊂ total → online% ≤ penetration%
    // Small overages are period/rounding artifacts, not real
    if (sellOnlinePct != null && sellPenetration != null && sellOnlinePct > sellPenetration) {
      sellOnlinePct = sellPenetration;
    }
    if (buyOnlinePct != null && buyPenetration != null && buyOnlinePct > buyPenetration) {
      buyOnlinePct = buyPenetration;
    }

    // ── Take rate = fees_ytd / koronet_sell_ytd
    // Only meaningful with sufficient sell volume (> $10K YTD)
    /* Take rate = (Direct Fees + Indirect Fees) / (Estimated Buy + Estimated Sell)
     *
     * Was: fees / koronet_sell — fees actually captured over the volume we
     * already move. That measures execution on the business we have, and is
     * tautologically bounded by the fee rate itself.
     *
     * The new denominator is the account's whole addressable flow (what it
     * sells plus what it buys, estimated), and the numerator now includes the
     * buy side. So take rate answers "how much of everything this account
     * moves do we monetize", which is the question the team is actually
     * asking. It reads much lower than the old one — that is the point, not a
     * regression.
     *
     * Guard: needs a real denominator. Below $10K of estimated flow the ratio
     * is noise. */
    var takeRate = null;
    /* Ya calculados arriba con la regla del piso por período: el take rate tiene
       que usar el mismo denominador que la penetración, no el reparto plano. */
    var gmvRefPeriod    = gmvRefPeriod2;
    var buyGmvEstPeriod = buyGmvEstPeriod2;
    /* Both sides now span the same months: fees billed in the window over the
       flow estimated for that window. Against the annual denominator the YTD
       take rate came out 12/8 too low purely from the unit mismatch. */
    var estFlow = (gmvRefPeriod || 0) + (buyGmvEstPeriod || 0);
    if (feesTotal && estFlow > 10000 * _frac) {
      takeRate = (feesTotal / estFlow) * 100;
    }

    /* ── TREND on every column ───────────────────────────────────────────────
     *
     * Each metric is recomputed over the prior-year window — the same months
     * shifted back 12 — with the SAME formula and the same denominator, so the
     * delta reflects the metric moving and not the method changing. Amounts
     * trend in %, percentages trend in percentage points (pp): a penetration
     * going 4% → 6% is +2pp, and calling that "+50%" would be true but useless
     * on a dashboard.
     *
     * Est GMV and Est Buy get no trend: they are a single annual figure with no
     * time series behind them, so any delta would be an artifact of the
     * estimate being revised, not of the account changing. Shown as "—".
     */
    var sellPriorWin = _priorYearWindow(sellPeriodMonths);
    var buyPriorWin  = _priorYearWindow(buyPeriodMonths);
    var feesPriorWin = _priorYearWindow(feesMonths);
    var indPeriodMonths = _periodMonths('indirect', _state.indirectCube, timeframe);
    var indPriorWin  = _priorYearWindow(indPeriodMonths);

    /* El split online/offline del cubo de buy no existe antes de nov-2024: los
       10 primeros meses de 2024 traen buy_gmv y buy_offline reales pero
       buy_online en cero, porque sales_channel no traía Web/Procurement/API.
       Comparar contra esa ventana daría un salto inventado del 0% a lo que
       sea, así que la tendencia de buy online % se suprime cuando el período
       anterior la toca. El valor del período actual no se ve afectado: ningún
       período seleccionable empieza antes de 2025. */
    var BUY_ONLINE_FROM = '2024-11';

    var priorSellOnline = _sumWindowWhere(sellRows, 'sell_gmv', sellPriorWin, 'sell', _state.sellCube,
      function (r) { return _isOnlineChannel(r.channel); });
    var buyOnlineCovered = !!buyPriorWin && buyPriorWin.from >= BUY_ONLINE_FROM;
    var priorBuyOnline  = buyOnlineCovered
      ? _sumWindow(buyRows, 'buy_online', buyPriorWin, 'buy', _state.buyCube)
      : null;
    var priorIndirectBuy = _sumWindowWhere(indirectRows, 'buy_online_attributed', indPriorWin, 'indirect', _state.indirectCube,
      function (r) { return INDIRECT_STATUSES[r.connection_status] === 1; });
    var priorIndirectFees = _sumWindowWhere(indirectRows, 'indirect_fee', indPriorWin, 'indirect', _state.indirectCube,
      function (r) { return INDIRECT_STATUSES[r.connection_status] === 1; });

    var priorSellMonths = sellPriorWin ? _monthSpan(sellPriorWin) : 0;
    var priorBuyMonths  = buyPriorWin  ? _monthSpan(buyPriorWin)  : 0;

    /* La ventana anterior es el mismo rango corrido un año, así que abarca la
       misma cantidad de meses y lleva el mismo denominador prorrateado. Usar el
       estimado anual de un lado y el prorrateado del otro mostraría un
       crecimiento que no es más que el cambio de unidad. */
    function _pen(amount, denomAnnual) {
      if (amount == null || !(denomAnnual > 0)) return null;
      return (amount / (denomAnnual * _frac)) * 100;
    }
    var priorSellPen    = _pen(sellYtd2025, gmvRef);
    var priorSellOnPct  = _pen(priorSellOnline, gmvRef);
    var priorBuyPen     = _pen(buyYtd2025, buyGmvEst);
    var priorBuyOnPct   = _pen(priorBuyOnline, buyGmvEst);
    // Same ceiling rule as the current period, or the pp delta compares a
    // capped number against an uncapped one.
    if (priorSellOnPct != null && priorSellPen != null && priorSellOnPct > priorSellPen) priorSellOnPct = priorSellPen;
    if (priorBuyOnPct  != null && priorBuyPen  != null && priorBuyOnPct  > priorBuyPen)  priorBuyOnPct  = priorBuyPen;

    var priorFeesTotal = (feesYtd2025 || 0) + (priorIndirectFees || 0);
    if (!feesYtd2025 && !priorIndirectFees) priorFeesTotal = null;
    var priorTakeRate = (priorFeesTotal && estFlow > 10000 * _frac) ? (priorFeesTotal / estFlow) * 100 : null;

    /* ── POR QUÉ una métrica está vacía ────────────────────────────────────
     *
     * "$0" y "sin dato" se leen igual en una tabla y son decisiones muy
     * distintas: una cuenta que no vende online genuinamente no genera fee, y
     * eso no es un hueco de datos. El adapter emite el motivo para que la UI
     * pueda distinguirlos en la celda en vez de dejar al lector adivinando.
     *
     * Cada motivo es 'cero' (el valor es correcto y es cero) o 'gap' (no
     * sabemos). Solo se emite cuando la métrica está vacía.
     */
    var cfgConf = (_state.config[id] || {}).config || {};
    var feeTodoApagado = (cfgConf.ecommerce_fee === false && cfgConf.k2k_fee === false && cfgConf.api_fee === false);
    var esCompradorK2K = !!(_state.indirectCubeById[id] && _state.indirectCubeById[id].length);
    var estaLive = (acct.komet_status === 'Production - Live');

    function _why(value, cases) {
      if (value != null && value !== 0) return null;
      for (var i = 0; i < cases.length; i++) {
        if (cases[i][0]) return { kind: cases[i][1], note: cases[i][2] };
      }
      return { kind: 'gap', note: 'no data' };
    }

    /* Último mes con venta en TODO el cubo, para distinguir "dejó de vender" de
       "no sabemos". Una cuenta que facturó hasta diciembre y nada en el período
       es un cero con historia, no un hueco de datos. */
    var _mesesConVenta = sellRows.filter(function (r) { return (_num(r.sell_gmv) || 0) > 0; })
      .map(function (r) { return r.month; }).sort();
    var lastSellMonth = _mesesConVenta.length ? _mesesConVenta[_mesesConVenta.length - 1] : null;
    var _win = _timeframeRange(timeframe);
    var churned = lastSellMonth != null && lastSellMonth < _win.from;

    var reasons = {
      gmv_reference: _why(gmvRef, [
        [gmvSource === 'No vende (Koronet)', 'cero', 'does not sell through Koronet'],
        [gmvSource === 'Sin dato' || !gmvSource, 'gap', 'outside the Est GMV cascade']
      ]),
      koronet_sell_ytd: _why(koronetSellYtd, [
        [!estaLive, 'cero', 'not live yet'],
        /* La cascada ya resolvió que no vende por Koronet: el cero es su
           consecuencia, no un dato faltante. */
        [gmvSource === 'No vende (Koronet)', 'cero', 'the Est GMV cascade records it as not selling through Koronet'],
        /* Procurement compra por Koronet y no vende: no hay lado de venta. */
        [acct.product_tier === 'Procurement', 'cero', 'Procurement tier: it buys through Koronet, it does not sell'],
        /* Sus filas de venta existen, pero el cliente es la propia empresa: son
           compras suyas espejadas en la tabla de ventas. Cero real, no hueco —
           sin este caso, 37 cuentas del portafolio se leían como "falta dato". */
        [(sellAgg && sellAgg.self_sale > 0), 'cero', 'its «sales» are its own purchases mirrored (self-sale): it does not sell through Koronet'],
        [churned, 'cero', 'last sale ' + lastSellMonth + ' — nothing in this period'],
        [true, 'gap', 'live but no sales in the period']
      ]),
      koronet_buy_ytd: _why(koronetBuyYtd, [
        [!estaLive, 'cero', 'not live yet'],
        [true, 'cero', 'does not buy through Koronet in the period']
      ]),
      sell_penetration: _why(sellPenetration, [
        [!gmvRef, 'gap', 'no Est GMV to compare against'],
        [!koronetSellYtd, 'cero', 'no sales in the period']
      ]),
      sell_online_pct: _why(sellOnlinePct, [
        [!koronetSellYtd, 'cero', 'no sales in the period'],
        [true, 'cero', 'sells, but nothing online']
      ]),
      buy_penetration: _why(buyPenetration, [
        [!buyGmvEst, 'gap', 'no Est Buy to compare against'],
        [!koronetBuyYtd, 'cero', 'no purchases in the period']
      ]),
      buy_online_pct: _why(buyOnlinePct, [
        [!koronetBuyYtd, 'cero', 'no purchases in the period'],
        [true, 'cero', 'buys, but all offline']
      ]),
      fees_direct: _why(feesDirect, [
        [feeTodoApagado, 'cero', 'fees disabled in its configuration'],
        [!sellOnlinePct, 'cero', 'no online sales: earns no fee'],
        [true, 'gap', 'sells online but records no fee — review']
      ]),
      fees_indirect: _why(feesIndirect, [
        [!esCompradorK2K, 'cero', 'not a buyer in any K2K connection'],
        [true, 'gap', 'K2K buyer but no attributed purchases']
      ]),
      take_rate: _why(takeRate, [
        [!feesTotal, 'cero', 'no fees in the period'],
        [estFlow <= 10000 * _frac, 'gap', 'Est Buy + Est Sell for the period too small: the ratio would be noise']
      ])
    };

    var trends = {
      /* El estimado se mueve YoY solo cuando ES nuestra medición: 'Medido' y
         'Piso de red' salen del cubo de sell y heredan su variación. Un ORA /
         FCS / externo es una cifra anual sin nada detrás; prorratearla a dos
         ventanas iguales imprimiría +0,0% y disfrazaría de estabilidad la
         ausencia de serie. */
      gmv_reference:     estIsMeasured ? _pctChange(koronetSellYtd, sellYtd2025) : null,
      buy_gmv_estimated: estIsMeasured ? _pctChange(koronetSellYtd, sellYtd2025) : null,
      koronet_sell:      _pctChange(koronetSellYtd, sellYtd2025),
      sell_penetration:  _ppChange(sellPenetration, priorSellPen),
      sell_online_pct:   _ppChange(sellOnlinePct, priorSellOnPct),
      koronet_buy:       _pctChange(koronetBuyYtd, buyYtd2025),
      buy_penetration:   _ppChange(buyPenetration, priorBuyPen),
      buy_online_pct:    _ppChange(buyOnlinePct, priorBuyOnPct),
      fees_direct:       _pctChange(feesDirect, feesYtd2025),
      fees_indirect:     _pctChange(feesIndirect, priorIndirectFees),
      take_rate:         _ppChange(takeRate, priorTakeRate)
    };

    // ── YoY sell delta (YTD 2026 vs YTD 2025)
    var sellYoyDelta = (koronetSellYtd && sellYtd2025) ? _delta(koronetSellYtd, sellYtd2025) : null;

    // ── Fees YoY — available now that the cube has monthly grain from 2025-01
    var feesYoyPct = (feesYtd2026 && feesYtd2025) ? _delta(feesYtd2026, feesYtd2025) : null;

    // ── MoM deltas (from cubes)
    var sellMomDelta = _computeMomDelta(_sellMonthlyTotals(sellRows), 'sell_gmv');
    var buyMomDelta  = _computeMomDelta(_buyMonthlyTotals(buyRows), 'buy_gmv');
    // Fees MoM — also available now (real monthly grain)
    var feesMomDelta = _computeMomDelta(_feesMonthlyTotals(feesRows), 'fee_amount');

    // ── Days observed (from pacing)
    var daysObserved = paceRec ? _num(paceRec.days_observed) : null;

    return {
      // GMV reference
      gmv_reference: {
        // Prorrateado al período; `annual` conserva la cifra anual, que es la
        // que segmenta el tamaño de cuenta (bandas de GMV).
        value: gmvRefPeriod2,
        annual: gmvRef,
        unverified: estUnverified,
        measured_annual: annualizedSell,
        period_floored: sellPeriodFloored,
        source: gmvSource,
        is_floor: gmvIsFloor,
        confidence: gmvConfidence,
        days_observed: daysObserved,
      },
      gmv_pace:     gmvPace,
      gmv_external: gmvExternal,
      gmv_ora:      gmvOra,
      buy_gmv_estimated: { value: buyGmvEstPeriod2, annual: buyGmvEst, source: buyEstSource, period_floored: buyPeriodFloored },

      // Koronet actuals from cubes
      koronet_sell_ytd: _ev(koronetSellYtd, koronetSellYtd ? 'observed' : 'gap', 'sell cube'),
      koronet_buy_ytd:  _ev(koronetBuyYtd,  koronetBuyYtd  ? 'observed' : 'gap', 'buy cube'),
      sell_ytd_2025:    _ev(sellYtd2025, sellYtd2025 ? 'observed' : 'gap', null),
      buy_ytd_2025:     _ev(buyYtd2025,  buyYtd2025  ? 'observed' : 'gap', null),

      // Online %
      sell_online_pct: _ev(sellOnlinePct, sellOnlinePct != null ? 'observed' : 'gap', null),
      buy_online_pct:  _ev(buyOnlinePct,  buyOnlinePct  != null ? 'observed' : 'gap', null),
      sell_offline_ytd: _ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap', null),
      buy_offline_ytd:  _ev(buyOfflineYtd,  buyOfflineYtd  ? 'observed' : 'gap', null),

      // Penetration — HONEST
      sell_penetration: _ev(sellPenetration, sellPenEv, sellPenNote),
      buy_penetration:  _ev(buyPenetration,  buyPenEv,  buyPenNote),

      // Fees from cube
      fees_ytd_2026:  _ev(feesYtd2026, feesYtd2026 ? 'observed' : 'gap', 'fees cube'),
      fees_ytd_2025:  _ev(feesYtd2025, feesYtd2025 ? 'observed' : 'gap', null),
      fees_by_channel: { value: feesByChannel },
      fees_yoy_pct:   _ev(feesYoyPct, feesYoyPct != null ? 'observed' : 'gap', null),

      // Direct (sell side, measured) vs indirect (buy side, modelled at 1.5%)
      fees_direct:    _ev(feesDirect, feesDirect ? 'observed' : 'gap', 'fees cube'),
      fees_indirect:  _ev(feesIndirect, feesIndirect ? 'model' : 'gap', 'K2K attribution × seller realised rate'),
      fees_total:     _ev(feesTotal, feesTotal ? 'model' : 'gap', null),
      buy_attributed: _ev(buyAttributed, buyAttributed ? 'observed' : 'gap', 'K2K attribution'),
      indirect_by_channel: { value: indirectAgg ? indirectAgg.byChannel : null },
      indirect_rate: _ev(indirectAgg && indirectAgg.effective_rate != null ? indirectAgg.effective_rate * 100 : null,
                         indirectAgg && indirectAgg.effective_rate != null ? 'observed' : 'gap',
                         'realised rate of this account’s sellers'),

      trends:         trends,
      reasons:        reasons,

      /* Auto-ventas: filas de venta cuyo cliente es la propia compañía. Ya están
         fuera de koronet_sell; se exponen para poder cruzarlas contra las compras
         atribuidas de indirect fees (en las cuentas afectadas los dos montos
         coinciden al 91-98%, porque son el mismo flujo visto de los dos lados). */
      self_sale_gmv:  _ev(sellAgg && sellAgg.self_sale ? sellAgg.self_sale : null,
                          sellAgg && sellAgg.self_sale ? 'observed' : 'gap',
                          'sell cube · customer_name = the company itself'),
      take_rate:      _ev(takeRate, takeRate != null ? 'model' : 'gap', '(direct+indirect fees) / (est buy + est sell)'),

      // Sell trend
      sell_yoy_delta: sellYoyDelta,

      // MoM deltas
      sell_mom_delta: sellMomDelta,
      buy_mom_delta:  buyMomDelta,
      fees_mom_delta: feesMomDelta,
    };
  }

  /**
   * Compute MoM delta from a sorted monthly totals array.
   * monthlyTotals: [{ month, sell_gmv/buy_gmv, ... }]
   * valueKey: 'sell_gmv' or 'buy_gmv'
   */
  function _computeMomDelta(monthlyTotals, valueKey) {
    if (!monthlyTotals || monthlyTotals.length < 2) return null;

    var currentMonth = monthlyTotals[monthlyTotals.length - 1];
    var priorMonth   = monthlyTotals[monthlyTotals.length - 2];

    var currVal = _num(currentMonth[valueKey]) || 0;
    var priorVal = _num(priorMonth[valueKey]) || 0;

    if (priorVal === 0) return null;

    return {
      pct: ((currVal - priorVal) / priorVal) * 100,
      absolute: currVal - priorVal,
      current_month: currentMonth.month,
      prior_month: priorMonth.month,
    };
  }

  /** BUY DOMAIN — V2 legacy (vendor lifecycle, k2k, categories, leakage, anticipation) */
  function _buildBuy(companyId, timeframe) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var vendRec = _state.vendorsById[id] || (name ? (_state.vendorsByName[name] || null) : null);
    var saRows  = _state.temporalSAById[id] || (name ? (_state.temporalSellAnticipation[name] || null) : null);
    var skusRec = _state.skusById[id] || (name ? (_state.skusOnlineOffline[name] || null) : null);

    // ── Monthly sourcing from buy cube
    var buyRows = _state.buyCubeById[id] || [];
    var buyMonthlyTotals = _buyMonthlyTotals(buyRows);
    var buyAggYtd = _aggregateBuyCube(buyRows, timeframe);
    // Like-for-like against the window actually covered by the cube.
    var buyYtdMonths = _periodMonths('buy', _state.buyCube, timeframe);
    var buyYtd2025 = _sumWindow(buyRows, 'buy_gmv', _priorYearWindow(buyYtdMonths), 'buy', _state.buyCube);

    var sourcingTable = null;
    if (buyMonthlyTotals.length) {
      var byMonthDict = {};
      buyMonthlyTotals.forEach(function (m) { byMonthDict[m.month] = m; });

      var sp = _selectPeriod(byMonthDict, timeframe, false);

      sourcingTable = {
        ytd_2026: buyAggYtd ? buyAggYtd.total : null,
        ytd_2025: buyYtd2025,
        yoy_delta: (buyAggYtd && buyYtd2025) ? _delta(buyAggYtd.total, buyYtd2025) : null,
        monthly: byMonthDict,
        current_month: sp.current || null,
        current_month_key: sp.current ? sp.current.month : null,
        prior_month: sp.prior || null,
        prior_month_key: sp.prior ? sp.prior.month : null,
        ev: 'observed',
      };
    }

    // ── K2K lifecycle + vendor lifecycle from vendors_evidence
    var k2kLifecycle    = null;
    var vendorLifecycle = null;
    var categoriesTop20 = null;
    var leakage         = null;

    if (vendRec) {
      k2kLifecycle    = vendRec.k2k_connections  || null;
      vendorLifecycle = vendRec.vendor_lifecycle  || null;
      categoriesTop20 = vendRec.categories_top20  || null;
      leakage         = vendRec.vendor_leakage    || null;
    }

    // ── Anticipation
    var anticipation = null;
    if (saRows && saRows.length) {
      var onlineRows  = saRows.filter(function (r) { return r.channel_type === 'online'; });
      var offlineRows = saRows.filter(function (r) { return r.channel_type === 'offline'; });

      function _summarizeBuckets(rows) {
        var buckets = {};
        var totalOrders = 0;
        var weightedDays = 0;
        rows.forEach(function (r) {
          buckets[r.bucket] = { orders: r.total_orders, gmv: r.total_gmv, avg_days: r.avg_days };
          totalOrders += (r.total_orders || 0);
          weightedDays += (r.avg_days || 0) * (r.total_orders || 0);
        });
        return {
          buckets: buckets,
          total_orders: totalOrders,
          avg_days: totalOrders > 0 ? weightedDays / totalOrders : null,
        };
      }

      anticipation = {
        online:  onlineRows.length  ? _summarizeBuckets(onlineRows)  : null,
        offline: offlineRows.length ? _summarizeBuckets(offlineRows) : null,
        ev: 'observed',
      };
    }

    return {
      sourcing_table:       sourcingTable ? _ev(sourcingTable, 'observed', 'buy cube + vendors_evidence_v2') : null,
      k2k_lifecycle:        k2kLifecycle  ? _ev(k2kLifecycle, 'observed', 'vendors_evidence_v2')  : null,
      vendor_lifecycle:     vendorLifecycle ? _ev(vendorLifecycle, 'observed', 'vendors_evidence_v2') : null,
      anticipation_online:  anticipation && anticipation.online  ? _ev(anticipation.online, 'observed', 'temporal sell_anticipation') : null,
      anticipation_offline: anticipation && anticipation.offline ? _ev(anticipation.offline, 'observed', 'temporal sell_anticipation') : null,
      categories_top20:     categoriesTop20 ? _ev(categoriesTop20, 'observed', 'vendors_evidence_v2') : null,
      leakage:              leakage ? _ev(leakage, 'observed', 'vendors_evidence_v2') : null,
      skus_online_offline:  skusRec ? _ev(skusRec, 'observed', 'skus_online_offline') : null,
    };
  }

  /** LIST DOMAIN — inventory, variety freshness, config (from V2) */
  function _buildList(companyId) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var invRec = _state.inventory[id] || null;
    var cfgRec = _state.config[id]    || null;
    var vfRows = _state.temporalVFById[id] || (name ? (_state.temporalVarietyFreshness[name] || null) : null);
    var fiRows = _state.temporalFIById[id] || (name ? (_state.temporalForwardInventory[name] || null) : null);

    // ── Inventory (current published)
    var inventoryCurrent = null;
    if (invRec) {
      inventoryCurrent = {
        by_type:     invRec.by_inventory_type     || null,
        by_division: invRec.by_inventory_division || null,
        totals:      invRec.totals                || null,
        ev:          'observed',
      };
    }

    // ── Variety freshness
    var varietyFreshness = null;
    if (vfRows && vfRows.length) {
      var onlineVF  = vfRows.filter(function (r) { return r.channel_type === 'online'; });
      var offlineVF = vfRows.filter(function (r) { return r.channel_type === 'offline'; });

      function _groupFreshness(rows) {
        var buckets = {};
        var totalVar = 0;
        rows.forEach(function (r) {
          buckets[r.freshness_bucket] = { variety_count: r.variety_count, avg_days: r.avg_days_since };
          totalVar += (r.variety_count || 0);
        });
        return { buckets: buckets, total_varieties: totalVar };
      }

      varietyFreshness = {
        online:  onlineVF.length  ? _groupFreshness(onlineVF)  : null,
        offline: offlineVF.length ? _groupFreshness(offlineVF) : null,
        ev:      'observed',
      };
    }

    // ── Forward inventory depth
    var forwardInventory = null;
    if (fiRows && fiRows.length) {
      var fiByBucket = {};
      fiRows.forEach(function (r) {
        fiByBucket[r.horizon_bucket] = {
          prebook_lines:    r.prebook_lines,
          total_value:      r.total_value,
          distinct_vendors: r.distinct_vendors,
          distinct_products: r.distinct_products,
        };
      });
      forwardInventory = { by_bucket: fiByBucket, ev: 'observed' };
    }

    // ── Config
    var config = null;
    if (cfgRec) {
      config = {
        raw:              cfgRec.config            || null,
        bunches_reality:  cfgRec.bunches_reality    || null,
        sfdc:             cfgRec.sfdc               || null,
        company_name:     cfgRec.company_name       || null,
        company_industry: cfgRec.company_industry   || null,
        ev:               'observed',
      };
    }

    return {
      inventory_current: inventoryCurrent ? _ev(inventoryCurrent, 'observed', 'inventory_current_v1') : null,
      variety_freshness: varietyFreshness  ? _ev(varietyFreshness, 'observed', 'temporal variety_freshness') : null,
      forward_inventory: forwardInventory ? _ev(forwardInventory, 'observed', 'temporal forward_inventory_depth') : null,
      tam_lost:          null,
      config:            config ? _ev(config, 'observed', 'config_evidence_v2') : null,
    };
  }

  /** SELL DOMAIN — buyers, CVR, repeat rate, concentration, hardgoods (from V2) + sell cube */
  function _buildSell(companyId, timeframe) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var buyRec = _state.buyersById[id] || (name ? (_state.buyers[name] || null) : null);
    var hgRec  = name ? (_state.hardgoodsByName[name] || null) : null;

    // ── Monthly sell series from cube
    var sellRows = _state.sellCubeById[id] || [];
    var monthlyTotals = _sellMonthlyTotals(sellRows);

    var currentMonth = monthlyTotals.length ? monthlyTotals[monthlyTotals.length - 1] : null;
    var priorMonth   = monthlyTotals.length >= 2 ? monthlyTotals[monthlyTotals.length - 2] : null;

    if (timeframe === 'prior_month') {
      currentMonth = monthlyTotals.length >= 2 ? monthlyTotals[monthlyTotals.length - 2] : null;
      priorMonth   = monthlyTotals.length >= 3 ? monthlyTotals[monthlyTotals.length - 3] : null;
    }

    // ── Buyers table
    var buyersTable = null;
    if (buyRec && buyRec.buyers) {
      var bd = buyRec.buyers;
      buyersTable = {
        online_buyers:  _num(bd.online_buyers),
        offline_buyers: _num(bd.offline_buyers),
        total_buyers:   _num(bd.total_buyers),
        l30d_online:    _num(bd.l30d_online),
        l30d_offline:   _num(bd.l30d_offline),
        aov_online:     _num(bd.aov_online) || null,
        aov_offline:    _num(bd.aov_offline) || null,
        new_month:      _num(bd.new_month) || null,
        churned:        _num(bd.churned) || null,
        ev:             'observed',
      };
    }

    // ── CVR
    var cvr        = buyRec ? buyRec.login_cvr    : null;
    var newUserCvr = buyRec ? buyRec.new_user_cvr : null;

    // ── Repeat rate
    var repeatRate = buyRec ? buyRec.repeat_rate : null;

    // ── Concentration
    var concentration = buyRec ? buyRec.concentration : null;

    // ── Hardgoods
    var hardgoods = null;
    if (hgRec) {
      hardgoods = {
        hardgoods_total:      _num(hgRec.hardgoods_total),
        hardgoods_online:     _num(hgRec.hardgoods_online),
        hardgoods_offline:    _num(hgRec.hardgoods_offline),
        hardgoods_online_pct: _num(hgRec.hardgoods_online_pct),
        plants_total:         _num(hgRec.plants_total),
        plants_online:        _num(hgRec.plants_online),
        plants_offline:       _num(hgRec.plants_offline),
        plants_online_pct:    _num(hgRec.plants_online_pct),
        ct_id:                hgRec.ct_id || null,
        ev:                   'observed',
      };
    }

    // ── Sell monthly — from cube
    var sellAggYtd = _aggregateSellCube(sellRows, timeframe);
    var sellOnlineYtd  = sellAggYtd ? (sellAggYtd.online  > 0 ? sellAggYtd.online  : null) : null;
    var sellOfflineYtd = sellAggYtd ? (sellAggYtd.offline > 0 ? sellAggYtd.offline : null) : null;
    var sellTotalYtd   = sellAggYtd ? (sellAggYtd.total   > 0 ? sellAggYtd.total   : null) : null;

    return {
      buyers_table:     buyersTable   ? _ev(buyersTable,   'observed', 'buyers_evidence_v2') : null,
      cvr:              cvr           ? _ev(cvr,           'observed', 'buyers_evidence_v2') : null,
      new_user_cvr:     newUserCvr    ? _ev(newUserCvr,    'observed', 'buyers_evidence_v2') : null,
      repeat_rate:      repeatRate    ? _ev(repeatRate,    'observed', 'buyers_evidence_v2') : null,
      concentration:    concentration ? _ev(concentration, 'observed', 'buyers_evidence_v2') : null,
      hardgoods:        hardgoods     ? _ev(hardgoods,     'observed', 'hardgoods_v2')       : null,
      sell_online_ytd:  _ev(sellOnlineYtd,  sellOnlineYtd  ? 'observed' : 'gap', null),
      sell_offline_ytd: _ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap', null),
      sell_total_ytd:   _ev(sellTotalYtd,   sellTotalYtd   ? 'observed' : 'gap', null),
      monthly_series:   monthlyTotals.length ? _ev(monthlyTotals, 'observed', 'sell cube') : null,
      current_month:    currentMonth || null,
      prior_month:      priorMonth   || null,
    };
  }

  /** BENCHMARKS — network + segment benchmarks (from V2) */
  function _buildBenchmarks(companyId) {
    var id   = _sid(companyId);
    var acct = _state.accountById[id];
    var ctId = acct ? (acct.ct_id || '') : '';

    var bmarks = _state.benchmarks;
    if (!bmarks || !Object.keys(bmarks).length) return null;

    var result = { segment: ctId, per_metric: {} };

    Object.keys(bmarks).forEach(function (key) {
      var bm      = bmarks[key];
      var network = bm.network || null;
      var segData = (bm.by_segment && ctId && bm.by_segment[ctId]) ? bm.by_segment[ctId] : null;

      result.per_metric[key] = {
        description:  bm.description || null,
        network:      network,
        segment:      segData,
        median:       network ? network.median       : null,
        p75:          network ? network.p75          : null,
        p90:          network ? network.p90          : null,
        best_account: network ? network.best_account : null,
        best_value:   network ? network.best_value   : null,
        seg_median:   segData ? segData.median       : null,
        seg_p75:      segData ? segData.p75          : null,
        seg_p90:      segData ? segData.p90          : null,
      };
    });

    return result;
  }

  /** FRESHNESS / TIMELINE — source coverage for this account */
  function _buildFreshness(companyId) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var sources = [];

    function _check(label, found, asOf) {
      sources.push({ source: label, found: !!found, as_of: asOf || null });
    }

    _check('accounts_v3',        !!_state.accountById[id],                         null);
    _check('sell_cube',          !!(_state.sellCubeById[id] && _state.sellCubeById[id].length), null);
    _check('buy_cube',           !!(_state.buyCubeById[id] && _state.buyCubeById[id].length),   null);
    _check('fees_cube',          !!(_state.feesCubeById[id] && _state.feesCubeById[id].length), null);
    _check('gmv_pacing',         !!_state.pacingById[id],                          null);
    _check('gmv_external',       !!_state.externalById[id],                        null);
    _check('buyers_evidence',    !!(_state.buyersById[id] || (name && _state.buyers[name])),   null);
    _check('vendors_evidence',   !!(_state.vendorsById[id] || (name && _state.vendorsByName[name])), null);
    _check('temporal',           !!((_state.temporalSAById[id] && _state.temporalSAById[id].length) || (name && _state.temporalSellAnticipation[name] && _state.temporalSellAnticipation[name].length)), null);
    _check('inventory_current',  !!_state.inventory[id],                           null);
    _check('benchmarks',         !!Object.keys(_state.benchmarks).length,          null);
    _check('config_evidence',    !!_state.config[id],                              null);
    _check('hardgoods',          name ? !!_state.hardgoodsByName[name] : false,    null);

    var foundCount = sources.filter(function (s) { return s.found; }).length;

    return {
      as_of:         new Date().toISOString().slice(0, 10),
      sources_used:  foundCount,
      sources_total: sources.length,
      coverage_pct:  Math.round((foundCount / sources.length) * 100),
      sources:       sources,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  function init() {
    return _loadAll();
  }

  /**
   * getAccountEvidence(companyId, timeframe)
   *
   * @param  {string|number} companyId
   * @param  {string}        timeframe — 'current_month' | 'prior_month' | 'ytd' | 'l12m'
   * @returns {Object|null}
   */
  function getAccountEvidence(companyId, timeframe) {
    if (!_state.loaded) {
      console.warn('[EvidenceAdapterV3] Data not loaded yet. Call init() first.');
      return null;
    }

    var id = _sid(companyId);
    if (!id) return null;

    var tf = timeframe || 'ytd';

    var identity = _buildIdentity(id);
    if (!identity) return null;

    var potential   = null;
    var buy         = null;
    var list        = null;
    var sell        = null;
    var benchmarks  = null;
    var freshness   = null;

    try { potential  = _buildPotential(id, tf); }  catch (e) { console.error('[EvidenceAdapterV3] potential error', id, e); }
    try { buy        = _buildBuy(id, tf); }         catch (e) { console.error('[EvidenceAdapterV3] buy error', id, e); }
    try { list       = _buildList(id); }             catch (e) { console.error('[EvidenceAdapterV3] list error', id, e); }
    try { sell       = _buildSell(id, tf); }         catch (e) { console.error('[EvidenceAdapterV3] sell error', id, e); }
    try { benchmarks = _buildBenchmarks(id); }       catch (e) { console.error('[EvidenceAdapterV3] benchmarks error', id, e); }
    try { freshness  = _buildFreshness(id); }        catch (e) { console.error('[EvidenceAdapterV3] freshness error', id, e); }

    return {
      _company_id:   id,
      _company_name: identity.company_name,
      _timeframe:    tf,

      identity:   identity,
      potential:  potential,
      buy:        buy,
      list:       list,
      sell:       sell,
      benchmarks: benchmarks,
      freshness:  freshness,
    };
  }

  /**
   * getAccountByName(companyName, timeframe)
   */
  function getAccountByName(companyName, timeframe) {
    if (!_state.loaded) {
      console.warn('[EvidenceAdapterV3] Data not loaded yet.');
      return null;
    }
    var id = _state.nameToId[companyName];
    if (!id) {
      console.warn('[EvidenceAdapterV3] No company_id found for name:', companyName);
      return null;
    }
    return getAccountEvidence(id, timeframe);
  }

  /**
   * getAllAccountIds()
   * Returns sorted array of company_ids from accounts_v3.json (NOT from old universe).
   */
  function getAllAccountIds() {
    return Object.keys(_state.accountById).sort();
  }

  /**
   * getLoadedState()
   */
  function getLoadedState() {
    return {
      loaded:                _state.loaded,
      accounts_v3_count:     Object.keys(_state.accountById).length,
      sell_cube_companies:   Object.keys(_state.sellCubeById).length,
      sell_cube_rows:        _state.sellCube.length,
      buy_cube_companies:    Object.keys(_state.buyCubeById).length,
      buy_cube_rows:         _state.buyCube.length,
      fees_cube_companies:   Object.keys(_state.feesCubeById).length,
      fees_cube_rows:        _state.feesCube.length,
      gmv_pacing_count:      Object.keys(_state.pacingById).length,
      gmv_external_count:    Object.keys(_state.externalById).length,
      buyers_count:          Object.keys(_state.buyers).length,
      vendors_count:         _state.vendors.length,
      inventory_count:       Object.keys(_state.inventory).length,
      benchmarks_count:      Object.keys(_state.benchmarks).length,
      config_count:          Object.keys(_state.config).length,
      hardgoods_count:       _state.hardgoods.length,
      name_to_id_count:      Object.keys(_state.nameToId).length,
      id_to_name_count:      Object.keys(_state.idToName).length,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     EXPORT
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * isClientWholesaler(ev) — Canonical filter for the prioritization universe.
   * Returns true if account is a Client + Wholesaler + known product tier.
   * EVERY view that prioritizes wholesalers MUST use this function.
   * Pre-live, Prospect, Unknown tier, non-Wholesaler → excluded.
   */
  /**
   * Canonical wholesaler universe.
   *
   * Was: Client + business_type Wholesaler + known product_tier → 127 accounts.
   * That rule dropped 19 accounts hand-curated in Christine/Facundo's sheet,
   * 18 of them excluded only for being Pre-live or Prospect — $77.1M of Est
   * GMV, with Alpha Fern and Baystate alone worth $40M. The portfolio universe
   * is therefore the union of the canonical filter and that sheet: **145
   * accounts**, an explicit set of sfdc_ids in data/wholesaler_universe.json
   * rather than a rule, because membership involves human judgement that no
   * combination of fields encodes.
   *
   * The external 618-profile research identifies a further 208 accounts as
   * wholesalers (69 of them already Clients booked in Salesforce as Importer,
   * Grower or Retailer). Those are **registered but deliberately kept out of
   * the portfolio and its KPIs** — see isOnly618() — because the 618 defines
   * "wholesaler" as selling wholesale to the trade, which in floral legitimately
   * includes importers. No business_type is changed in Salesforce; the team
   * validates the classification first.
   *
   * If the file is missing the old rule still applies, so the dashboard degrades
   * to its previous behaviour instead of showing an empty table.
   */
  function isClientWholesaler(ev) {
    if (!ev || !ev.identity) return false;
    var id = ev.identity;

    if (_state.whUniverse) {
      var sfdc = id.sfdc_id || (_state.accountById[_sid(id.company_id)] || {}).sfdc_id;
      if (sfdc) return _state.whUniverse[String(sfdc)] === true;
    }

    return id.account_class === 'Client'
      && id.business_type === 'Wholesaler'
      && id.product_tier
      && id.product_tier !== 'Unknown';
  }

  /**
   * Identified as a wholesaler ONLY by the 618-profile research: registered,
   * reviewable, and outside the portfolio until the team validates it.
   */
  function isOnly618(ev) {
    if (!ev || !ev.identity || !_state.wh618) return false;
    var sfdc = ev.identity.sfdc_id;
    return !!sfdc && _state.wh618[String(sfdc)] === true;
  }

  var EvidenceAdapter = {
    init:               init,
    getAccountEvidence: getAccountEvidence,
    getAccountByName:   getAccountByName,
    getAllAccountIds:    getAllAccountIds,
    getLoadedState:     getLoadedState,
    isClientWholesaler: isClientWholesaler,
    isOnly618:          isOnly618,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EvidenceAdapter;
  } else {
    root.EvidenceAdapter = EvidenceAdapter;
  }

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
