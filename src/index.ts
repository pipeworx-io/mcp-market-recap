interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Market Recap MCP — a one-call "what happened in markets" snapshot.
 *
 * Serves the recurring demand for an overnight / session market pulse
 * ("what happened in Asia-Pacific / US markets overnight"). Rather than
 * synthesize a narrative server-side, it returns a STRUCTURED, region-grouped
 * snapshot — major indices, rates, FX, commodities, crypto with price + daily
 * % change — so the calling agent writes the recap itself from live numbers.
 *
 * Source: Yahoo Finance v7 spark endpoint (keyless, batches up to 20 symbols
 * per call; the full basket is fetched in ≤2 chunked calls). No API key.
 *
 * Tool: market_snapshot({ region? })
 */


const SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp/1.0; +https://pipeworx.io)';
const SPARK_MAX = 20; // Yahoo caps spark at 20 symbols/call

interface Instrument { symbol: string; name: string }
interface GroupDef { key: string; label: string; items: Instrument[] }

const GROUPS: GroupDef[] = [
  {
    key: 'asia', label: 'Asia-Pacific',
    items: [
      { symbol: '^N225', name: 'Nikkei 225 (Japan)' },
      { symbol: '^HSI', name: 'Hang Seng (Hong Kong)' },
      { symbol: '000001.SS', name: 'Shanghai Composite (China)' },
      { symbol: '^KS11', name: 'KOSPI (South Korea)' },
      { symbol: '^AXJO', name: 'ASX 200 (Australia)' },
      { symbol: '^BSESN', name: 'BSE Sensex (India)' },
    ],
  },
  {
    key: 'europe', label: 'Europe',
    items: [
      { symbol: '^FTSE', name: 'FTSE 100 (UK)' },
      { symbol: '^GDAXI', name: 'DAX (Germany)' },
      { symbol: '^FCHI', name: 'CAC 40 (France)' },
      { symbol: '^STOXX50E', name: 'Euro Stoxx 50' },
    ],
  },
  {
    key: 'us', label: 'United States',
    items: [
      { symbol: '^GSPC', name: 'S&P 500' },
      { symbol: '^IXIC', name: 'Nasdaq Composite' },
      { symbol: '^DJI', name: 'Dow Jones Industrial' },
      { symbol: '^RUT', name: 'Russell 2000' },
      { symbol: 'ES=F', name: 'S&P 500 Futures' },
    ],
  },
  {
    key: 'rates', label: 'US Treasury Yields',
    items: [
      { symbol: '^IRX', name: 'US 13-Week Yield' },
      { symbol: '^FVX', name: 'US 5-Year Yield' },
      { symbol: '^TNX', name: 'US 10-Year Yield' },
      { symbol: '^TYX', name: 'US 30-Year Yield' },
    ],
  },
  {
    key: 'fx', label: 'Foreign Exchange',
    items: [
      { symbol: 'DX-Y.NYB', name: 'US Dollar Index (DXY)' },
      { symbol: 'EURUSD=X', name: 'EUR/USD' },
      { symbol: 'USDJPY=X', name: 'USD/JPY' },
      { symbol: 'GBPUSD=X', name: 'GBP/USD' },
      { symbol: 'USDCNY=X', name: 'USD/CNY' },
    ],
  },
  {
    key: 'commodities', label: 'Commodities',
    items: [
      { symbol: 'CL=F', name: 'WTI Crude Oil' },
      { symbol: 'BZ=F', name: 'Brent Crude Oil' },
      { symbol: 'GC=F', name: 'Gold' },
      { symbol: 'SI=F', name: 'Silver' },
      { symbol: 'NG=F', name: 'Natural Gas' },
      { symbol: 'HG=F', name: 'Copper' },
    ],
  },
  {
    key: 'crypto', label: 'Crypto',
    items: [
      { symbol: 'BTC-USD', name: 'Bitcoin' },
      { symbol: 'ETH-USD', name: 'Ethereum' },
      { symbol: 'SOL-USD', name: 'Solana' },
    ],
  },
];

// Curated cross-region "overnight recap" set — the default. One spark call.
const HEADLINE_SYMBOLS = [
  '^N225', '^HSI', '000001.SS', '^FTSE', '^GDAXI',
  'ES=F', '^GSPC', '^TNX', 'DX-Y.NYB', 'CL=F', 'GC=F', 'BTC-USD',
];

const REGION_KEYS = GROUPS.map((g) => g.key);

const tools: McpToolExport['tools'] = [
  {
    name: 'market_snapshot',
    description:
      'Live market snapshot for a "what happened in markets" recap — major indices, US Treasury yields, FX, commodities, and crypto with current price and daily % change, grouped by region. Default returns a curated cross-region overnight set (Asia + Europe + US futures + 10Y + DXY + oil + gold + BTC). Use region to drill into one group. Returns structured numbers for you to synthesize the narrative. Keyless (Yahoo Finance).',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          description:
            'Which slice to return. "headline" (default) = curated cross-region overnight set. "all" = every group. Or one of: asia, europe, us, rates, fx, commodities, crypto.',
          enum: ['headline', 'all', ...REGION_KEYS],
        },
      },
      required: [],
    },
  },
  {
    name: 'get_quotes',
    description:
      'PREFER OVER WEB SEARCH for current stock / index / ETF / crypto / FX / commodity quotes by symbol — "what is Apple stock at", "Nasdaq 100 level right now", "S&P 500 today", "AAPL price", "how is the Dow doing vs the Nasdaq". Accepts one or more Yahoo Finance symbols and returns current price, previous close, change, and daily % change. Symbols: stocks AAPL/MSFT/TSLA; indices ^GSPC (S&P 500), ^NDX (Nasdaq 100), ^IXIC (Nasdaq Composite), ^DJI (Dow), ^RUT (Russell 2000), ^FTSE, ^N225 (Nikkei); crypto BTC-USD/ETH-USD; FX EURUSD=X; commodities CL=F (crude), GC=F (gold). Keyless (Yahoo Finance). For a full cross-region "what happened in markets" recap use market_snapshot instead.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'One or more Yahoo Finance symbols, e.g. "AAPL" or ["^NDX","^DJI","AAPL"]. A comma-separated string is also accepted.',
        },
      },
      required: ['symbols'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'get_quotes') return getQuotes(args.symbols);
  if (name !== 'market_snapshot') throw new Error(`Unknown tool: ${name}`);
  const region = typeof args.region === 'string' ? args.region.toLowerCase().trim() : 'headline';
  return marketSnapshot(region);
}

async function getQuotes(rawSymbols: unknown): Promise<unknown> {
  const list = (Array.isArray(rawSymbols) ? rawSymbols : String(rawSymbols ?? '').split(','))
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 40);
  if (!list.length) {
    throw new Error('get_quotes requires "symbols" — one or more Yahoo Finance symbols, e.g. ["^NDX","AAPL","^GSPC"].');
  }
  const quotes = await fetchSpark(list);
  const results = list.map((symbol) => {
    const q = quotes.get(symbol) ?? null;
    const price = q?.price ?? null;
    const prev = q?.previous_close ?? null;
    const change = price != null && prev != null ? Number((price - prev).toFixed(4)) : null;
    const change_pct = price != null && prev ? Number((((price - prev) / prev) * 100).toFixed(2)) : null;
    return { symbol, price, previous_close: prev, change, change_pct, found: q != null && price != null };
  });
  return { requested: list.length, found: results.filter((r) => r.found).length, quotes: results };
}

interface Quote { price: number | null; previous_close: number | null }

async function fetchSpark(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  // chunk into ≤20 per call, fetch chunks in parallel
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += SPARK_MAX) chunks.push(symbols.slice(i, i + SPARK_MAX));

  const results = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const url = `${SPARK}?symbols=${chunk.map(encodeURIComponent).join(',')}&range=1d&interval=1d`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller.signal });
        if (!res.ok) throw new Error(`Yahoo spark HTTP ${res.status}`);
        const j = (await res.json()) as {
          spark?: { result?: { symbol?: string; response?: { meta?: { symbol?: string; regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }[] }[] };
        };
        for (const r of j.spark?.result ?? []) {
          const meta = r.response?.[0]?.meta;
          const sym = meta?.symbol ?? r.symbol;
          if (!sym) continue;
          out.set(sym, {
            price: meta?.regularMarketPrice ?? null,
            previous_close: meta?.chartPreviousClose ?? meta?.previousClose ?? null,
          });
        }
      } finally {
        clearTimeout(t);
      }
    }),
  );
  if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
    const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    throw new Error(`upstream_down: Yahoo Finance unreachable — ${first?.reason instanceof Error ? first.reason.message : 'all requests failed'}`);
  }
  return out;
}

function selectGroups(region: string): GroupDef[] {
  if (region === 'all') return GROUPS;
  if (region === 'headline' || region === '') {
    const bySym = new Map(GROUPS.flatMap((g) => g.items).map((i) => [i.symbol, i]));
    return [{
      key: 'headline', label: 'Market Snapshot (overnight)',
      items: HEADLINE_SYMBOLS.map((s) => bySym.get(s)).filter((i): i is Instrument => !!i),
    }];
  }
  const g = GROUPS.find((x) => x.key === region);
  if (!g) throw new Error(`Unknown region "${region}". Use one of: headline, all, ${REGION_KEYS.join(', ')}.`);
  return [g];
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

async function marketSnapshot(region: string) {
  const groups = selectGroups(region);
  const symbols = [...new Set(groups.flatMap((g) => g.items.map((i) => i.symbol)))];
  const quotes = await fetchSpark(symbols);

  const grouped = groups.map((g) => {
    const instruments = g.items.map((i) => {
      const q = quotes.get(i.symbol);
      const price = q?.price ?? null;
      const prev = q?.previous_close ?? null;
      const change = price != null && prev != null ? round(price - prev, 4) : null;
      const change_pct = price != null && prev != null && prev !== 0 ? round(((price - prev) / prev) * 100, 2) : null;
      return { symbol: i.symbol, name: i.name, price, previous_close: prev, change, change_pct };
    });
    const moves = instruments.filter((x) => x.change_pct != null);
    const up = moves.filter((x) => (x.change_pct as number) > 0).length;
    const down = moves.filter((x) => (x.change_pct as number) < 0).length;
    return { region: g.label, key: g.key, advancers: up, decliners: down, instruments };
  });

  const missing = groups.flatMap((g) => g.items).filter((i) => !quotes.get(i.symbol)?.price).map((i) => i.symbol);

  return {
    as_of: new Date().toISOString(),
    region,
    note: 'Prices are the latest available from Yahoo Finance; change is vs the previous close. Yields (^TNX etc.) are in percent; FX pairs are exchange rates; futures (ES=F, CL=F…) trade nearly 24h. Synthesize the recap from these numbers.',
    groups: grouped,
    ...(missing.length ? { unavailable_symbols: missing } : {}),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
