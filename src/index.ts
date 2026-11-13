import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {tavily} from "@tavily/core";
import { describeOrder, orderPlan, type StockLevels } from "./order.js";
import { checkProductSize } from "./size.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const dbPath = resolve(currentDir, "../inventory.db");

config({ path: resolve(currentDir, "../.env"), quiet: true });

const db = new Database(dbPath);
db.pragma("busy_timeout = 3000");

// Separate read-only connection for read_query, so AI-written SQL can never change data.
const readOnlyDb = new Database(dbPath, { readonly: true });

db.exec(`
    CREATE TABLE IF NOT EXISTS stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL REFERENCES inventory(sku),
        change_pcs INTEGER NOT NULL,
        stock_before INTEGER NOT NULL,
        stock_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        type TEXT NOT NULL DEFAULT 'koreksi'
    );
    CREATE TABLE IF NOT EXISTS insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
`);

// Why stock changed. Analytics count only 'terjual' as sales, so damaged or lost goods never inflate sales.
const MOVEMENT_TYPES = ["terjual", "barang_datang", "rusak", "hilang", "koreksi"] as const;

// Databases made before the type column existed get it once, filled in from the old free-text reason.
const movementColumns = db.prepare(`PRAGMA table_info(stock_movements)`).all() as { name: string }[];

if (!movementColumns.some((column) => column.name === "type")) {
    db.exec(`
        ALTER TABLE stock_movements ADD COLUMN type TEXT NOT NULL DEFAULT 'koreksi';
        UPDATE stock_movements SET type = CASE
            WHEN reason LIKE 'terjual%' OR reason LIKE '%jual%' THEN 'terjual'
            WHEN reason LIKE 'barang datang%' THEN 'barang_datang'
            WHEN reason LIKE '%rusak%' OR reason LIKE '%expired%' OR reason LIKE '%kedaluwarsa%' OR reason LIKE '%kadaluarsa%' THEN 'rusak'
            WHEN reason LIKE '%hilang%' THEN 'hilang'
            ELSE 'koreksi'
        END;
    `);
}

// Supplier pricing searches are restricted to these marketplace/distributor domains.
const SUPPLIER_DOMAINS = [
    "indotrading.com",
    "tokopedia.com",
    "shopee.co.id",
    "blibli.com",
    "bukalapak.com",
];

// Pack words with a fixed number of items, the same for every product.
const FIXED_PACK_UNITS: Record<string, number> = {
    pcs: 1, pc: 1, biji: 1, bungkus: 1, sachet: 1, botol: 1, kaleng: 1, pouch: 1,
    lusin: 12,
    kodi: 20,
};

// Pack words whose item count depends on the product; filled from inventory.units_per_carton.
const CARTON_UNITS = ["dus", "karton", "carton", "ctn"];

const server = new McpServer({
    name: "InventoryWatch",
    version: "1.0.0",
});

server.registerTool(
    "check_stock",
    {
        description: "Check stock levels and identify products below their safety threshold",
        inputSchema: {
            productId: z.string().describe("Product SKU (e.g. SKU001) or words from the product name (e.g. Indomie Rendang)"),
        },
    },
       async ({ productId }) => {
        // Every word must appear somewhere in the name or keyword, in any order,
        // so "Indomie Rendang" finds "Indomie Goreng Rendang 91g".
        const words = productId.trim().split(/\s+/).filter(Boolean).slice(0, 8);
        const products = db.prepare(`
            SELECT sku, item_name, current_stock, safety_threshold
            FROM inventory
            WHERE sku = ?
               OR (${words.map(() => "(item_name || ' ' || COALESCE(search_keyword, '')) LIKE ?").join(" AND ") || "0"})
        `).all(productId.trim(), ...words.map((word) => `%${word}%`)) as {
            sku: string;
            item_name: string;
            current_stock: number;
            safety_threshold: number;
        }[];

        if (products.length === 0) {
            // No literal match: give the AI every product so it can match by meaning
            // (typos, cabe/cabai, ijo/hijau, missing words) instead of saying the product does not exist.
            const all = db.prepare(`SELECT sku, item_name FROM inventory ORDER BY item_name LIMIT 200`).all() as { sku: string; item_name: string }[];

            return {
                content: [{
                    type: "text" as const,
                    text: `No product name contains all the words of "${productId}". All products:\n`
                        + all.map((p) => `- ${p.sku}: ${p.item_name}`).join("\n")
                        + `\nIf one of these is clearly what the user means (typo, synonym, regional spelling, missing word), `
                        + `call check_stock again with its SKU. If several could fit or none does, ask the user.`,
                }],
            };
        }

        const result = products.map((product) => {
            const lowStock =
                product.current_stock < product.safety_threshold;

            return [
                `Product: ${product.item_name}`,
                `SKU: ${product.sku}`,
                `Current stock: ${product.current_stock}`,
                `Safety threshold: ${product.safety_threshold}`,
                `Status: ${lowStock ? "LOW STOCK - Replenishment may be needed" : "Stock is sufficient"}`,
            ].join("\n");
        });

        return {
            content: [{
                type: "text" as const,
                text: result.join("\n\n"),
            }],
        };
    }, 
);


server.registerTool(
    "list_inventory",
    {
        description: "List all products in the inventory database",
        inputSchema: {},
    },
    async () => {
        const products = db.prepare(`
            SELECT sku, item_name, current_stock, safety_threshold
            FROM inventory
            ORDER BY item_name
        `).all() as {
            sku: string;
            item_name: string;
            current_stock: number;
            safety_threshold: number;
        }[];

        if (products.length === 0) {
            return {
                content: [{
                    type: "text" as const,
                    text: "The inventory database is empty.",
                }],
            };
        }

        const output = products.map((product) => {
            const lowStock =
                product.current_stock < product.safety_threshold;

            return [
                `Product: ${product.item_name}`,
                `SKU: ${product.sku}`,
                `Current stock: ${product.current_stock}`,
                `Safety threshold: ${product.safety_threshold}`,
                `Status: ${lowStock ? "LOW STOCK" : "Stock is sufficient"}`,
            ].join("\n");
        }).join("\n\n");

        return {
            content: [{
                type: "text" as const,
                text: `Inventory list:\n\n${output}`,
            }],
        };
    },
);


// Average daily sales over the last 30 days (stock_movements rows of type 'terjual' only),
// and how many days the current stock lasts at that pace. Computed here so the AI never estimates it.
function describeSales(sku: string, currentStock: number) {
    const { sold } = db.prepare(`
        SELECT COALESCE(SUM(-change_pcs), 0) AS sold FROM stock_movements
        WHERE sku = ? AND type = 'terjual' AND created_at >= datetime('now', '-30 days')
    `).get(sku) as { sold: number };

    if (sold === 0) {
        return "Sales last 30 days: no sales recorded";
    }

    const perDay = sold / 30;
    return `Sales last 30 days: ${sold} pcs (about ${perDay.toFixed(1)} pcs/day), current stock lasts about ${Math.floor(currentStock / perDay)} day(s)`;
}

// A purchase order that is already on the way (created from the GUI draft). The tables are created by
// the web GUI, so they may not exist when only the CLI was used.
function describeOpenOrder(sku: string) {
    try {
        const open = db.prepare(`
            SELECT o.id, o.ordered_at, i.receive_pcs, i.supplier_name FROM purchase_order_items i
            JOIN purchase_orders o ON o.id = i.order_id
            WHERE i.sku = ? AND i.status = 'dipesan' ORDER BY o.id
        `).all(sku) as { id: number; ordered_at: string; receive_pcs: number; supplier_name: string | null }[];

        if (open.length === 0) return null;

        return "Already ordered, waiting for delivery (do not suggest ordering again): " + open.map((o) =>
            `PO-${String(o.id).padStart(4, "0")} ordered ${o.ordered_at} UTC, ${o.receive_pcs} pcs from ${o.supplier_name ?? "supplier not set"}`).join("; ");
    } catch {
        return null;
    }
}

server.registerTool(
    "get_low_stock",
    {
        description: "Return only products where current_stock is below safety_threshold, with the suggested order quantity. Call this before search_supplier_prices for restock recommendations.",
        inputSchema: {},
    },
    async () => {
        const products = db.prepare(`
            SELECT sku, item_name, current_stock, safety_threshold, max_stock, units_per_carton
            FROM inventory
            WHERE current_stock < safety_threshold
            ORDER BY item_name
        `).all() as ({
            sku: string;
            item_name: string;
            current_stock: number;
            safety_threshold: number;
        } & StockLevels)[];

        if (products.length === 0) {
            return {
                content: [{
                    type: "text" as const,
                    text: "No products are below their safety threshold.",
                }],
            };
        }

        const output = products.map((product) => [
            `Product: ${product.item_name}`,
            `SKU: ${product.sku}`,
            `Current stock: ${product.current_stock}`,
            `Safety threshold: ${product.safety_threshold}`,
            describeSales(product.sku, product.current_stock),
            describeOpenOrder(product.sku) ?? describeOrder(product),
        ].join("\n")).join("\n\n");

        return {
            content: [{
                type: "text" as const,
                text: `Low-stock products (current_stock < safety_threshold):\n\n${output}`,
            }],
        };
    },
);


server.registerTool(
    "search_supplier_prices",
    {
        description: "Search the web for supplier prices. Allowed only for products where current_stock < safety_threshold; other products are blocked.",
        inputSchema: {
            productName: z.string().describe("SKU (for example SKU001) or exact item name of a low-stock product"),
        },
    },
    async ({ productName }) => {
        const matches = db.prepare(`
            SELECT sku, item_name, current_stock, safety_threshold, search_keyword
            FROM inventory
            WHERE sku = ? OR item_name = ? COLLATE NOCASE
        `).all(productName, productName) as {
            sku: string;
            item_name: string;
            current_stock: number;
            safety_threshold: number;
            search_keyword: string | null;
        }[];

        if (matches.length !== 1) {
            return {
                content: [{
                    type: "text" as const,
                    text: `BLOCKED: "${productName}" must match exactly one product by SKU or item name. Supplier pricing was not searched.`,
                }],
                isError: true,
            };
        }

        const product = matches[0];

        if (!(product.current_stock < product.safety_threshold)) {
            return {
                content: [{
                    type: "text" as const,
                    text: `BLOCKED: ${product.item_name} (${product.sku}) has current stock ${product.current_stock} and safety threshold ${product.safety_threshold}. Supplier pricing is only allowed when current_stock < safety_threshold. Supplier pricing was not searched.`,
                }],
                isError: true,
            };
        }

        const apiKey = process.env.TAVILY_API_KEY;

        if (!apiKey) {
            return {
                content: [{
                    type: "text" as const,
                    text: "TAVILY_API_KEY is not configured.",
                }],
            };
        }

        // search_keyword is a more specific name for the web search; fall back to item_name if it is empty.
        const keyword = product.search_keyword?.trim() || product.item_name;

        try {
            const client = tavily({ apiKey });

            const result = await client.search(
                `${keyword} harga grosir supplier Indonesia`,
                {
                    maxResults: 5,
                    searchDepth: "basic",
                    includeDomains: SUPPLIER_DOMAINS,
                    includeDomainsMode: "restrict",
                }
            );

            if (result.results.length === 0) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `No search results found for ${product.item_name} (search keyword: "${keyword}").`,
                    }],
                };
            }

            const output = result.results.map((item, index) => [
                `${index + 1}. ${item.title}`,
                `URL: ${item.url}`,
                `Content: ${item.content}`,
            ].join("\n")).join("\n\n");

            return {
                content: [{
                    type: "text" as const,
                    text: `Search results for ${product.item_name} (${product.sku}, stock ${product.current_stock} < threshold ${product.safety_threshold}):\n\n${output}`,
                }],
            };
        } catch (error) {
            return {
                content: [{
                    type: "text" as const,
                    text: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
                }],
            };
        }
    });


server.registerTool(
    "compare_supplier_offers",
    {
        description: "Compare supplier offers for one product by price per unit and return the cheapest. Offers without a price or units per pack are excluded, not guessed.",
        inputSchema: {
            productName: z.string().describe("SKU or item name of the product being compared"),
            offers: z.array(z.object({
                supplier: z.string().describe("Supplier, store, or page title"),
                url: z.string().describe("Source URL of the offer"),
                price: z.number().optional().describe("Price in Rupiah as written in the search result; for a price range use the lowest price"),
                unitsPerPack: z.number().optional().describe("Number of single items (bungkus, sachet, botol, kotak) the price buys, only if written, e.g. 40 for 'dus isi 40'"),
                packQuantity: z.number().optional().describe("How many packs the price buys as written, e.g. 2 for '2 lusin'; default 1"),
                packUnit: z.string().optional().describe("Pack word as written, e.g. 'dus', 'karton', 'lusin', 'kodi', 'pcs'"),
                unitSize: z.string().optional().describe("Size of one item as written, e.g. '200ml', '1 liter', '85g'"),
                packDescription: z.string().optional().describe("Pack description, e.g. '1 dus isi 40 pcs'"),
            })).describe("Offers extracted from search_supplier_prices results"),
        },
    },
    async ({ productName, offers }) => {
        // Prices are only comparable per item of the same size, so offers are grouped by unitSize.
        const sizeKey = (size?: string) => size
            ?.toLowerCase()
            .replace(/\s+/g, "")
            .replace(/(gram|gr)$/, "g")
            .replace(/(liter|litre|ltr)$/, "l") || "size not stated";

        // The store's own carton size for this product, used when a listing says "1 dus" without the count.
        const product = db.prepare(`
            SELECT sku, current_stock, max_stock, units_per_carton
            FROM inventory
            WHERE sku = ? OR item_name = ? COLLATE NOCASE
        `).get(productName, productName) as (StockLevels & { sku: string }) | undefined;
        const unitsPerCarton = product?.units_per_carton ?? null;
        const plan = product ? orderPlan(product) : null;

        const isCount = (value?: number) => typeof value === "number" && Number.isInteger(value) && value >= 1;

        // Item count the price buys, in priority order: written in the listing, fixed pack word, store carton data.
        const resolveUnits = (offer: typeof offers[number]) => {
            if (isCount(offer.unitsPerPack)) {
                return { units: offer.unitsPerPack!, assumption: "" };
            }

            const quantity = isCount(offer.packQuantity) ? offer.packQuantity! : 1;
            // Keep letters only, so "1dus", "Dus " and "(KARTON)" all match.
            const unit = offer.packUnit?.toLowerCase().replace(/[^a-z]/g, "") ?? "";

            if (unit in FIXED_PACK_UNITS) {
                return { units: quantity * FIXED_PACK_UNITS[unit], assumption: "" };
            }

            if (CARTON_UNITS.includes(unit) && unitsPerCarton) {
                return {
                    units: quantity * unitsPerCarton,
                    assumption: `count not written; assumed ${unitsPerCarton} pcs per ${unit} from store data`,
                };
            }

            return null;
        };

        const valid = [];
        const excluded = [];

        for (const offer of offers) {
            const hasPrice = typeof offer.price === "number" && offer.price > 0;
            const resolved = resolveUnits(offer);

            if (hasPrice && resolved) {
                valid.push({ ...offer, ...resolved, unitPrice: offer.price! / resolved.units });
            } else {
                excluded.push(`${offer.supplier} (${!hasPrice ? "no price" : "units per pack unknown"}) - ${offer.url}`);
            }
        }

        const rupiah = (value: number) => `Rp${Math.round(value).toLocaleString("id-ID")}`;
        const excludedText = excluded.length > 0
            ? `\n\nExcluded from comparison:\n${excluded.map((line) => `- ${line}`).join("\n")}`
            : "";

        if (valid.length === 0) {
            return {
                content: [{
                    type: "text" as const,
                    text: `No comparable offers for ${productName}: every offer is missing a price or a known number of units per pack.${excludedText}`,
                }],
            };
        }

        valid.sort((a, b) => a.unitPrice - b.unitPrice);

        const groups = new Map<string, typeof valid>();

        for (const offer of valid) {
            const key = sizeKey(offer.unitSize);
            groups.set(key, [...(groups.get(key) ?? []), offer]);
        }

        const sections = [...groups.entries()].map(([size, group]) => {
            const cheapest = group[0];
            const ranking = group.map((offer, index) => [
                `${index + 1}. ${offer.supplier}`,
                `   Price: ${rupiah(offer.price!)} for ${offer.units} pcs${offer.packDescription ? ` (${offer.packDescription})` : ""}`,
                ...(offer.assumption ? [`   Note: ${offer.assumption}`] : []),
                `   Price per pcs: ${rupiah(offer.unitPrice)}`,
                `   URL: ${offer.url}`,
            ].join("\n")).join("\n");

            // Estimated cost using the cheapest supplier's own pack size: whole packs, rounded up, to cover what is needed.
            const packs = plan && plan.needed > 0 ? Math.ceil(plan.needed / cheapest.units) : 0;
            const estimate = packs > 0
                ? `\nEstimated cost from this supplier: ${packs} pack(s) x ${rupiah(cheapest.price!)} = ${rupiah(packs * cheapest.price!)} for ${packs * cheapest.units} pcs (needed ${plan!.needed} pcs to reach max_stock)`
                : "";

            return `Size: ${size}\nCheapest: ${cheapest.supplier} at ${rupiah(cheapest.unitPrice)} per pcs (${rupiah(cheapest.price!)} for ${cheapest.units} pcs${cheapest.assumption ? `, ${cheapest.assumption}` : ""}) - ${cheapest.url}${estimate}\nRanking by price per pcs:\n${ranking}`;
        });

        const orderLine = product ? `\n${describeOrder(product)}` : "";

        // Every comparable offer as data, so the GUI can list them in the draft order without re-reading Gemini's text.
        const offerData = valid.map((offer) => ({
            size: sizeKey(offer.unitSize),
            supplier: offer.supplier,
            url: offer.url,
            price: offer.price!,
            unitsPerPack: offer.units,
            unitPrice: offer.unitPrice,
            assumption: offer.assumption,
        }));

        const note = groups.size > 1
            ? "\n\nNote: offers have different item sizes, so each size is compared separately. Prices are not comparable across sizes."
            : "";

        return {
            content: [{
                type: "text" as const,
                text: `Supplier comparison for ${productName}:${orderLine}\n\n${sections.join("\n\n")}${note}${excludedText}`,
            }],
            structuredContent: { sku: product?.sku ?? null, offers: offerData },
        };
    },
);

// ---------------------------------------------------------------------------
// Schema exploration
// ---------------------------------------------------------------------------

const text = (value: string, isError = false) => ({
    content: [{ type: "text" as const, text: value }],
    ...(isError ? { isError: true } : {}),
});

const tableNames = () => (db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
`).all() as { name: string }[]).map((row) => row.name);

server.registerTool(
    "list_tables",
    {
        description: "List all tables in the InventoryWatch SQLite database with their row counts.",
        inputSchema: {},
    },
    async () => {
        const lines = tableNames().map((name) => {
            const { count } = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number };
            return `- ${name} (${count} rows)`;
        });

        return text(`Tables:\n${lines.join("\n")}`);
    },
);

server.registerTool(
    "describe_table",
    {
        description: "Show the columns, types, keys, and foreign keys of one table.",
        inputSchema: {
            table: z.string().describe("Table name from list_tables"),
        },
    },
    async ({ table }) => {
        // Only names that really exist are used in the PRAGMA, so the input cannot inject SQL.
        if (!tableNames().includes(table)) {
            return text(`Table "${table}" does not exist. Available tables: ${tableNames().join(", ")}`, true);
        }

        const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as {
            name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
        }[];
        const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
            from: string; table: string; to: string;
        }[];

        const columnLines = columns.map((c) => `- ${c.name} ${c.type || "ANY"}`
            + `${c.pk ? " PRIMARY KEY" : ""}${c.notnull ? " NOT NULL" : ""}`
            + `${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""}`);
        const fkLines = foreignKeys.map((fk) => `- ${fk.from} -> ${fk.table}.${fk.to}`);

        return text(`Table ${table}:\nColumns:\n${columnLines.join("\n")}`
            + (fkLines.length ? `\nForeign keys:\n${fkLines.join("\n")}` : ""));
    },
);

// ---------------------------------------------------------------------------
// Advanced analytics (read-only SQL written by the AI)
// ---------------------------------------------------------------------------

const MAX_ROWS = 100;

server.registerTool(
    "read_query",
    {
        description: "Run one read-only SQL SELECT query (aggregates, JOINs, GROUP BY) for analytics. Writes are rejected; use the data tools to change data. Call list_tables / describe_table first if unsure of column names.",
        inputSchema: {
            sql: z.string().describe("A single SQLite SELECT statement"),
        },
    },
    async ({ sql }) => {
        try {
            const statement = readOnlyDb.prepare(sql);

            if (!statement.reader) {
                return text("REJECTED: read_query only runs statements that return rows (SELECT). Use adjust_stock, add_product, or update_product to change data.", true);
            }

            const rows = statement.all() as Record<string, unknown>[];
            const shown = rows.slice(0, MAX_ROWS);
            const more = rows.length > MAX_ROWS ? `\n(${rows.length - MAX_ROWS} more rows not shown)` : "";

            return text(`${rows.length} row(s):\n${shown.map((row) => JSON.stringify(row)).join("\n")}${more}`);
        } catch (error) {
            return text(`Query failed: ${error instanceof Error ? error.message : String(error)}`, true);
        }
    },
);

// ---------------------------------------------------------------------------
// Data manipulation (validated INSERT / UPDATE, no free-form write SQL)
// ---------------------------------------------------------------------------

type InventoryRow = {
    sku: string;
    item_name: string;
    current_stock: number;
    safety_threshold: number;
    max_stock: number | null;
    units_per_carton: number | null;
    search_keyword: string | null;
};

const getBySku = (sku: string) => db.prepare(`SELECT * FROM inventory WHERE sku = ?`).get(sku) as InventoryRow | undefined;

const isWhole = (value: number | undefined, min: number) => value === undefined || (Number.isInteger(value) && value >= min);

server.registerTool(
    "adjust_stock",
    {
        description: "Add or subtract stock for one product. Only call it when the exact product (SKU), the quantity, the unit, and the type of change are clear; otherwise ask the user first.",
        inputSchema: {
            sku: z.string().describe("Exact SKU, e.g. SKU001 (find it with check_stock first)"),
            quantity: z.number().describe("How many. The type decides the direction (terjual/rusak/hilang subtract, barang_datang adds); only for koreksi use negative to subtract, e.g. -4"),
            unit: z.enum(["pcs", "dus"]).describe("Unit of quantity; 'dus' is converted with the product's units_per_carton"),
            type: z.enum(MOVEMENT_TYPES).describe("terjual = sold (subtract), barang_datang = goods received (add), rusak = damaged or expired (subtract), hilang = lost or stolen (subtract), koreksi = stock count correction (add or subtract)"),
            reason: z.string().optional().describe("Optional extra note, e.g. 'kemasan sobek' or 'PO-0001'"),
        },
    },
    async ({ sku, quantity, unit, type, reason }) => {
        const product = getBySku(sku);

        if (!product) {
            return text(`REJECTED: no product with SKU "${sku}". Use check_stock to find the SKU.`, true);
        }
        if (!Number.isInteger(quantity) || quantity === 0) {
            return text("REJECTED: quantity must be a non-zero whole number.", true);
        }
        if (unit === "dus" && !product.units_per_carton) {
            return text(`REJECTED: units_per_carton is not set for ${product.item_name}, so 'dus' cannot be converted. Ask the user for the quantity in pcs.`, true);
        }
        // The type decides the direction, so a sale can never add stock and a delivery can never remove it.
        // Only a stock count correction (koreksi) keeps the sign it was given.
        const signed = type === "koreksi" ? quantity
            : type === "barang_datang" ? Math.abs(quantity)
            : -Math.abs(quantity);
        const note = reason?.trim() || type.replace("_", " ");

        const changePcs = unit === "dus" ? signed * product.units_per_carton! : signed;
        const stockAfter = product.current_stock + changePcs;

        if (stockAfter < 0) {
            return text(`REJECTED: ${product.item_name} has ${product.current_stock} pcs; subtracting ${-changePcs} pcs would make stock negative.`, true);
        }

        db.transaction(() => {
            db.prepare(`UPDATE inventory SET current_stock = ? WHERE sku = ?`).run(stockAfter, sku);
            db.prepare(`
                INSERT INTO stock_movements (sku, change_pcs, stock_before, stock_after, type, reason) VALUES (?, ?, ?, ?, ?, ?)
            `).run(sku, changePcs, product.current_stock, stockAfter, type, note);
        })();

        const status = stockAfter < product.safety_threshold ? "still LOW STOCK" : "stock is sufficient";

        return text(`Updated ${product.item_name} (${sku}): ${product.current_stock} -> ${stockAfter} pcs (${changePcs > 0 ? "+" : ""}${changePcs} pcs, type: ${type}, note: ${note}). Safety threshold ${product.safety_threshold}: ${status}.`);
    },
);

server.registerTool(
    "add_product",
    {
        description: "Add a new product to the inventory. The SKU is generated automatically. Only call it when the full product name (brand, variant, size), current stock, and safety threshold are known; ask the user for anything missing.",
        inputSchema: {
            itemName: z.string().describe("Full product name with brand, variant, and size, e.g. 'Minyak Goreng Bimoli 2L'"),
            currentStock: z.number().describe("Current stock in pcs"),
            safetyThreshold: z.number().describe("Minimum stock in pcs before restocking"),
            maxStock: z.number().optional().describe("Stock level to refill up to, in pcs"),
            unitsPerCarton: z.number().optional().describe("Items in one dus/karton from the supplier"),
            searchKeyword: z.string().optional().describe("More specific name for supplier web search; defaults to itemName"),
        },
    },
    async ({ itemName, currentStock, safetyThreshold, maxStock, unitsPerCarton, searchKeyword }) => {
        const name = itemName.trim();

        if (name.length < 3) {
            return text("REJECTED: itemName is too short; ask for the full product name.", true);
        }

        const sizeProblem = checkProductSize(name);

        if (sizeProblem) {
            return text(`REJECTED: ${sizeProblem}`, true);
        }
        if (!isWhole(currentStock, 0) || !isWhole(safetyThreshold, 1) || !isWhole(maxStock, 1) || !isWhole(unitsPerCarton, 1)) {
            return text("REJECTED: stock, threshold, max stock, and units per carton must be whole numbers (threshold and the others at least 1, stock at least 0).", true);
        }
        if (maxStock !== undefined && maxStock <= safetyThreshold) {
            return text("REJECTED: maxStock must be higher than safetyThreshold.", true);
        }

        const duplicate = db.prepare(`SELECT sku, item_name FROM inventory WHERE item_name = ? COLLATE NOCASE`).get(name) as { sku: string; item_name: string } | undefined;

        if (duplicate) {
            return text(`REJECTED: "${duplicate.item_name}" already exists as ${duplicate.sku}. Use adjust_stock or update_product instead.`, true);
        }

        const { next } = db.prepare(`
            SELECT COALESCE(MAX(CAST(SUBSTR(sku, 4) AS INTEGER)), 0) + 1 AS next FROM inventory WHERE sku LIKE 'SKU%'
        `).get() as { next: number };
        const sku = `SKU${String(next).padStart(3, "0")}`;

        db.prepare(`
            INSERT INTO inventory (sku, item_name, current_stock, safety_threshold, search_keyword, units_per_carton, max_stock)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sku, name, currentStock, safetyThreshold, searchKeyword?.trim() || name, unitsPerCarton ?? null, maxStock ?? null);

        const missing = [maxStock === undefined && "max stock", unitsPerCarton === undefined && "units per carton"].filter(Boolean);

        return text(`Added ${name} as ${sku}: stock ${currentStock}, safety threshold ${safetyThreshold}`
            + `${maxStock !== undefined ? `, max stock ${maxStock}` : ""}${unitsPerCarton !== undefined ? `, ${unitsPerCarton} pcs per dus` : ""}.`
            + (missing.length ? ` Not set yet: ${missing.join(", ")} (needed for order quantities).` : ""));
    },
);

server.registerTool(
    "update_product",
    {
        description: "Change product settings: name, safety threshold, max stock, units per carton, or search keyword. Do not use it for stock quantities; use adjust_stock for that.",
        inputSchema: {
            sku: z.string().describe("Exact SKU, e.g. SKU002"),
            itemName: z.string().optional(),
            safetyThreshold: z.number().optional(),
            maxStock: z.number().optional(),
            unitsPerCarton: z.number().optional(),
            searchKeyword: z.string().optional(),
        },
    },
    async ({ sku, itemName, safetyThreshold, maxStock, unitsPerCarton, searchKeyword }) => {
        const product = getBySku(sku);

        if (!product) {
            return text(`REJECTED: no product with SKU "${sku}".`, true);
        }
        if (!isWhole(safetyThreshold, 1) || !isWhole(maxStock, 1) || !isWhole(unitsPerCarton, 1)) {
            return text("REJECTED: threshold, max stock, and units per carton must be whole numbers of at least 1.", true);
        }

        const sizeProblem = itemName?.trim() ? checkProductSize(itemName.trim()) : null;

        if (sizeProblem) {
            return text(`REJECTED: ${sizeProblem}`, true);
        }

        const next = {
            item_name: itemName?.trim() || product.item_name,
            safety_threshold: safetyThreshold ?? product.safety_threshold,
            max_stock: maxStock ?? product.max_stock,
            units_per_carton: unitsPerCarton ?? product.units_per_carton,
            search_keyword: searchKeyword?.trim() || product.search_keyword,
        };

        if (next.max_stock !== null && next.max_stock <= next.safety_threshold) {
            return text(`REJECTED: max stock (${next.max_stock}) must be higher than the safety threshold (${next.safety_threshold}).`, true);
        }

        const changes = (Object.keys(next) as (keyof typeof next)[])
            .filter((key) => next[key] !== product[key])
            .map((key) => `${key}: ${product[key]} -> ${next[key]}`);

        if (changes.length === 0) {
            return text("No changes: every given value is the same as before, or no field was given.", true);
        }

        db.prepare(`
            UPDATE inventory
            SET item_name = @item_name, safety_threshold = @safety_threshold, max_stock = @max_stock,
                units_per_carton = @units_per_carton, search_keyword = @search_keyword
            WHERE sku = @sku
        `).run({ ...next, sku });

        return text(`Updated ${product.item_name} (${sku}):\n${changes.map((c) => `- ${c}`).join("\n")}`);
    },
);

server.registerTool(
    "delete_product",
    {
        description: "Permanently delete one product (e.g. added by mistake or no longer sold), together with its draft order item, saved supplier offers, and stock movement history. Only call it with the exact SKU after the user clearly asked to delete that product.",
        inputSchema: {
            sku: z.string().describe("Exact SKU of the product to delete, e.g. SKU006 (find it with check_stock first)"),
        },
    },
    async ({ sku }) => {
        const product = getBySku(sku);

        if (!product) {
            return text(`REJECTED: no product with SKU "${sku}". Use check_stock to find the SKU.`, true);
        }

        // Child rows reference inventory(sku), so they are removed first, all in one transaction.
        const removed = db.transaction(() => ({
            draft: db.prepare(`DELETE FROM draft_order_items WHERE sku = ?`).run(sku).changes,
            offers: db.prepare(`DELETE FROM supplier_offers WHERE sku = ?`).run(sku).changes,
            movements: db.prepare(`DELETE FROM stock_movements WHERE sku = ?`).run(sku).changes,
            product: db.prepare(`DELETE FROM inventory WHERE sku = ?`).run(sku).changes,
        }))();

        return text(`Deleted ${product.item_name} (${sku}), last stock ${product.current_stock} pcs. `
            + `Also removed: ${removed.draft} draft order item(s), ${removed.offers} supplier offer(s), ${removed.movements} stock movement(s).`);
    },
);

// ---------------------------------------------------------------------------
// Automatic insights (memo resource)
// ---------------------------------------------------------------------------

function insightsMemo() {
    const rows = db.prepare(`SELECT text, created_at FROM insights ORDER BY id`).all() as { text: string; created_at: string }[];

    if (rows.length === 0) {
        return "# Insight InventoryWatch\n\nBelum ada insight yang dicatat.";
    }

    return `# Insight InventoryWatch\n\n${rows.map((row) => `- [${row.created_at} UTC] ${row.text}`).join("\n")}`;
}

server.registerResource(
    "insights",
    "memo://insights",
    {
        title: "Business insights memo",
        description: "Running memo of business insights the agent recorded while analysing inventory and supplier data.",
        mimeType: "text/markdown",
    },
    async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: insightsMemo() }],
    }),
);

server.registerTool(
    "append_insight",
    {
        description: "Record one business insight in the memo://insights resource after analysing data, e.g. which products are most critical or which supplier is cheapest. Returns the whole memo.",
        inputSchema: {
            insight: z.string().describe("One short, factual insight based on tool results, in the user's language"),
        },
    },
    async ({ insight }) => {
        const value = insight.trim();

        if (value.length < 10) {
            return text("REJECTED: the insight is too short.", true);
        }

        db.prepare(`INSERT INTO insights (text) VALUES (?)`).run(value);

        return text(`Insight saved.\n\n${insightsMemo()}`);
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("InventoryWatch MCP Server started");
