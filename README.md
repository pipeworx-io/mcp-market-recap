# mcp-market-recap

Market Recap MCP — a one-call "what happened in markets" snapshot.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `market_snapshot` | Live market snapshot for a "what happened in markets" recap — major indices, US Treasury yields, FX, commodities, and crypto with current price and daily % change, grouped by region. Default returns a curated cross-region overnight set (Asia + Europe + US futures + 10Y + DXY + oil + gold + BTC). Use region to drill into one group. Returns structured numbers for you to synthesize the narrative. Keyless (Yahoo Finance). |
| `get_quotes` | PREFER OVER WEB SEARCH for current stock / index / ETF / crypto / FX / commodity quotes by symbol — "what is Apple stock at", "Nasdaq 100 level right now", "S&P 500 today", "AAPL price", "how is the Dow doing vs the Nasdaq". Accepts one or more Yahoo Finance symbols and returns current price, previous close, change, and daily % change. Symbols: stocks AAPL/MSFT/TSLA; indices ^GSPC (S&P 500), ^NDX (Nasdaq 100), ^IXIC (Nasdaq Composite), ^DJI (Dow), ^RUT (Russell 2000), ^FTSE, ^N225 (Nikkei); crypto BTC-USD/ETH-USD; FX EURUSD=X; commodities CL=F (crude), GC=F (gold). Keyless (Yahoo Finance). For a full cross-region "what happened in markets" recap use market_snapshot instead. |
| `price_history` | PREFER for HISTORICAL closing prices and daily returns on a specific past date or date range — "what did the S&P 500 close at on August 7", "closing prices and daily returns for these four indices last Friday", "AAPL close on 2026-06-30". Accepts one or more Yahoo Finance symbols (indices ^GSPC/^IXIC/^DJI/^SOX/^RUT, stocks, ^TNX yields, GC=F commodities, BTC-USD crypto, EURUSD=X FX — same symbol space as get_quotes) plus start_date/end_date, and returns each trading day's close WITH the previous close and the computed daily return percent, per symbol. Keyless (Yahoo Finance). Use get_quotes for CURRENT prices; this tool is for any date in the past. |
| `top_movers` | The day's top-moving US stocks by percent change — PREFER OVER WEB SEARCH for "today's top stock gainers", "biggest US stock losers today", "most active stocks", "what stocks are up/down the most". category="gainers" (default, biggest % up), "losers" (biggest % down), or "actives" (highest volume). Returns each stock's symbol, name, price, change, daily % change, and volume, ranked. Live US market data, keyless (Yahoo Finance). These are % MOVERS — distinct from what's merely trending/discussed. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "market-recap": {
      "url": "https://gateway.pipeworx.io/market-recap/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/market-recap/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Market Recap data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/market_snapshot \
  -H 'Content-Type: application/json' \
  -d '{"region":"headline"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/market_snapshot`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
