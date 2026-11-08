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
                    text: `Search results for ${product.item_name} (${product.sku}, stock ${product.current_stock} < threshold ${product.safety_threshold}, search keyword: "${keyword}"):\n\n${output}`,
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

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("InventoryWatch MCP Server started");
