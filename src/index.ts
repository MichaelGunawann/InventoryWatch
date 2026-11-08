import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {tavily} from "@tavily/core";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const dbPath = resolve(currentDir, "../inventory.db");

config({ path: resolve(currentDir, "../.env"), quiet: true });

const db = new Database(dbPath);

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
            productId: z.string().describe("Product SKU, for example SKU001"),
        },
    },
       async ({ productId }) => {
        const products = db.prepare(`
            SELECT sku, item_name, current_stock, safety_threshold
            FROM inventory
            WHERE sku = ?
               OR item_name LIKE ?
        `).all(productId, `%${productId}%`) as {
            sku: string;
            item_name: string;
            current_stock: number;
            safety_threshold: number;
        }[];

        if (products.length === 0) {
            return {
                content: [{
                    type: "text" as const,
                    text: `No products found for "${productId}".`,
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


server.registerTool(
    "get_low_stock",
    {
        description: "Return only products where current_stock is below safety_threshold. Call this before search_supplier_prices for restock recommendations.",
        inputSchema: {},
    },
    async () => {
        const products = db.prepare(`
            SELECT sku, item_name, current_stock, safety_threshold
            FROM inventory
            WHERE current_stock < safety_threshold
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
                    text: "No products are below their safety threshold.",
                }],
            };
        }

        const output = products.map((product) => [
            `Product: ${product.item_name}`,
            `SKU: ${product.sku}`,
            `Current stock: ${product.current_stock}`,
            `Safety threshold: ${product.safety_threshold}`,
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
            SELECT units_per_carton
            FROM inventory
            WHERE sku = ? OR item_name = ? COLLATE NOCASE
        `).get(productName, productName) as { units_per_carton: number | null } | undefined;
        const unitsPerCarton = product?.units_per_carton ?? null;

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

            return `Size: ${size}\nCheapest: ${cheapest.supplier} at ${rupiah(cheapest.unitPrice)} per pcs (${rupiah(cheapest.price!)} for ${cheapest.units} pcs${cheapest.assumption ? `, ${cheapest.assumption}` : ""}) - ${cheapest.url}\nRanking by price per pcs:\n${ranking}`;
        });

        const note = groups.size > 1
            ? "\n\nNote: offers have different item sizes, so each size is compared separately. Prices are not comparable across sizes."
            : "";

        return {
            content: [{
                type: "text" as const,
                text: `Supplier comparison for ${productName}:\n\n${sections.join("\n\n")}${note}${excludedText}`,
            }],
        };
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("InventoryWatch MCP Server started");
