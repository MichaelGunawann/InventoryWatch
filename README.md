# InventoryWatch

InventoryWatch is a supermarket inventory and restock agent built on the **Model Context Protocol (MCP)**.
Ask it in plain language ("which products need restocking?") and it reads the SQLite inventory,
finds the products below their safety threshold, looks up supplier prices for **those products only**,
and recommends what to order and where.

```
User request ─► AI agent (Gemini) ─► MCP server ─► SQLite inventory
                                          │
                       current_stock < safety_threshold ?
                                          │ yes, low-stock products only
                                          ▼
                             Supplier price search (Tavily)
                                          │
                                          ▼
                       Compare price per unit ─► Recommendation
```

## Features

- **Stock checks.** Find products by SKU or by name, including typos and synonyms ("indomie rendang", "cabe ijo").
- **Restock workflow.** Low-stock detection, supplier price search, price-per-unit comparison and a suggested order quantity rounded to whole cartons.
- **Purchase orders.** Draft order → *dipesan* (ordered) → *diterima* (arrived) or *dibatalkan* (cancelled). Receiving an item adds its stock automatically.
- **Stock movements.** Every change is logged with a type: `terjual` (sold), `barang_datang` (delivery), `rusak` (damaged), `hilang` (lost) or `koreksi` (correction). Sales analytics count only `terjual`.
- **Analytics.** Read-only SQL over the database, for example top sellers, weekly trends and days until stock runs out.
- **Insights memo.** Key findings are saved to the `memo://insights` MCP resource and kept across chats.
- **Product management.** Add, update and delete products. Each change needs the user's confirmation, and deleting needs the confirm button.
- **Two front ends.** A web GUI and a terminal chat. Both are clients of the same MCP server.

## Requirements

- Node.js 20 or newer
- A [Gemini API key](https://aistudio.google.com/apikey), used by the web GUI and the terminal agent
- A [Tavily API key](https://tavily.com), used for the supplier price search

## Installation

```bash
git clone <repository-url>
cd InventoryWatch
npm install
```

Copy the example environment file, then fill in your keys:

```bash
cp .env.example .env
```

| Variable | Required | Used for |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Web GUI and terminal agent |
| `TAVILY_API_KEY` | Yes | Supplier price search |
| `GEMINI_FALLBACK_MODEL` | No | Second model, used only when the main model stays overloaded |
| `PORT` | No | Web GUI port (default `3000`) |

`.env` is git-ignored. Do not commit your keys.

The database is the single file `inventory.db`, which is included in the repository with sample data.
It needs no database server, user or password. Each clone has its own copy.

## Usage

### Web GUI

```bash
npm run web
```

Open http://localhost:3000. The page has two parts:

- **Chat.** Talk to the agent. Each answer shows which MCP tools were called.
- **Side panels.** Inventory, draft order, purchase orders and insights.

### Terminal agent

```bash
npm run agent
```

Type a request, or `exit` to quit. When the agent wants to add, update or delete a product, it asks `(y/n)` first.

### Example requests

```text
Produk apa saja yang stoknya di bawah batas aman?
Carikan harga supplier termurah untuk produk yang stoknya rendah
Tambah stok Indomie Goreng 2 dus, barang datang
Indomie rendang terjual 12 pcs
5 produk terlaris bulan ini apa?
Berapa hari lagi stok Kopi Kapal Api habis?
```

### Any MCP client

`src/index.ts` is a standard MCP server that runs over stdio.
Any MCP client can launch it with:

```bash
npx tsx /absolute/path/to/InventoryWatch/src/index.ts
```

**MCP Inspector** (browser UI for testing):

```bash
DANGEROUSLY_OMIT_AUTH=true npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

Open http://localhost:6274 and click **Connect**. Then open **Tools → List Tools** and **Resources → `memo://insights`**.

`DANGEROUSLY_OMIT_AUTH` turns off the Inspector's session token. That is acceptable here because the Inspector proxy only listens on `127.0.0.1`.
Without it, open the link printed in the terminal, which contains `MCP_PROXY_AUTH_TOKEN`.

The Inspector also has a command-line mode:

```bash
npx @modelcontextprotocol/inspector --cli npx tsx src/index.ts --method tools/list
npx @modelcontextprotocol/inspector --cli npx tsx src/index.ts --method tools/call --tool-name get_low_stock
```

**Claude Code:**

```bash
claude mcp add inventorywatch -- npx tsx /absolute/path/to/InventoryWatch/src/index.ts
```

**VS Code / Cursor.** Add the server to `.vscode/mcp.json` (Cursor: `.cursor/mcp.json`):

```json
{
  "servers": {
    "inventorywatch": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/InventoryWatch/src/index.ts"]
    }
  }
}
```

> Other clients call the tools directly, so the web and terminal agent's confirm step does not apply to them.
> `add_product`, `update_product`, `delete_product` and `adjust_stock` change `inventory.db` right away.
> Rely on the client's own tool-approval prompt.

## MCP tools and resources

| Tool | What it does |
|---|---|
| `check_stock` | Find a product by SKU or by name and report its stock |
| `list_inventory` | List every product |
| `get_low_stock` | Products below their safety threshold, with the suggested order, sales speed and any open order |
| `search_supplier_prices` | Web search for supplier prices. **Low-stock products only.** |
| `compare_supplier_offers` | Cheapest offer by price per unit. Offers without a price or pack size are excluded. |
| `list_tables` | Database tables and their row counts |
| `describe_table` | Columns, keys and foreign keys of one table |
| `read_query` | One read-only `SELECT` for analytics |
| `adjust_stock` | Add or subtract stock with a movement type. Logged in `stock_movements`. |
| `add_product` | Add a product. The SKU is generated. |
| `update_product` | Change the name, threshold, max stock, carton size or search keyword |
| `delete_product` | Delete a product and its related rows |
| `append_insight` | Save a finding to the insights memo |

| Resource | What it holds |
|---|---|
| `memo://insights` | Running memo of business insights |

## Rules enforced by the server

These rules live in the MCP server, so they hold for **every** client, not only for Gemini:

- Supplier prices are searched only when `current_stock < safety_threshold`.
- `read_query` uses a read-only database connection and accepts a single `SELECT` only.
- Stock can never go below zero.
- The movement type decides the direction. A delivery always adds stock, while a sale, damage or loss always subtracts it. Only `koreksi` keeps the sign it is given.
- Product sizes must be realistic: at most 50 kg, 50 L or 1000 pieces per item.

The agent (`src/agent-core.ts`) adds conversation rules on top. Gemini handles language understanding: typos, synonyms, spotting duplicate products by meaning, and asking when a request is unclear. The agent also adds the confirmation step for changes to products.

## Database

| Table | Purpose |
|---|---|
| `inventory` | Products: SKU, name, current stock, safety threshold, max stock, units per carton, search keyword |
| `stock_movements` | Every stock change, with its type, reason, and the stock before and after |
| `supplier_offers` | Supplier prices found by the search |
| `draft_order_items` | The current draft order |
| `purchase_orders`, `purchase_order_items` | Placed orders and the status of each item |
| `insights` | Rows behind the `memo://insights` resource |

The sales history in `stock_movements` contains 60 days of **simulated** data, marked `(simulasi)` in `reason`, so that the analytics have something to work with.
It was generated by `npm run seed:sales`, which refuses to run a second time.

## Project structure

```
src/
  index.ts        MCP server: tools, resource, database setup
  agent-core.ts   Gemini agent: MCP client, tool loop, confirmation step, retries
  agent.ts        Terminal chat
  web.ts          Web GUI server and REST API
  draft.ts        Draft order logic
  orders.ts       Purchase order logic
  order.ts        Order quantity rules (refill to max stock, round to cartons)
  size.ts         Product size parsing for the 50 kg / 50 L limit
public/
  index.html      Web GUI
scripts/
  seed-sales.ts   Simulated sales history
inventory.db      SQLite database
```

## Scripts

| Command | Description |
|---|---|
| `npm run web` | Start the web GUI |
| `npm run agent` | Start the terminal agent |
| `npm run server` | Start the MCP server alone, over stdio |
| `npm run typecheck` | Type-check the project |
| `npm run seed:sales` | Add the simulated sales history (runs once) |

## Limitations

- The MCP server uses the stdio transport. Each client starts its own server on the same machine, so remote access is not supported.
- The supplier search relies on Tavily. If no key is set or the search fails, there are no supplier prices.
- Each clone has its own `inventory.db`. Changes are not shared between machines.

## License

[ISC](https://choosealicense.com/licenses/isc/)
