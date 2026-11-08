
import { config } from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(currentDir, "index.ts");

config({ path: resolve(currentDir, "../.env"), quiet: true });

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in .env");
}

const ai = new GoogleGenAI({ apiKey });

const client = new Client({
    name: "inventorywatch-agent",
    version: "1.0.0",
});

const transport = new StdioClientTransport({
    command: "npx",
    args: [
        "tsx",
        serverPath,
    ],
});

const toolDeclarations: any[] = [
    {
        name: "check_stock",
        description:
            "Check actual inventory stock for a product using its SKU or product name. Use this whenever the user asks about stock or whether a product needs restocking.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                productId: {
                    type: Type.STRING,
                    description:
                        "The product SKU or product name mentioned by the user.",
                },
            },
            required: ["productId"],
        },
    },
        {
        name: "list_inventory",
        description:
            "List all products in the inventory database. MUST call this tool when the user asks what products they have, what items are available, or requests a list of all inventory.",
        parameters: {
            type: Type.OBJECT,
            properties: {},
        },
    },
    {
        name: "get_low_stock",
        description:
            "Return only products whose current_stock is below safety_threshold. Use this to find which products need restocking before looking up supplier prices.",
        parameters: {
            type: Type.OBJECT,
            properties: {},
        },
    },
    {
        name: "search_supplier_prices",
        description:
            "Search the web for supplier prices for a low-stock product in Indonesia. The tool blocks products whose current_stock is not below safety_threshold. Use this whenever the user asks for supplier prices of a product that needs restocking.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                productName: {
                    type: Type.STRING,
                    description: "The SKU (for example SKU001) or exact item name of the product.",
                },
            },
            required: ["productName"],
        },
    },
];

async function askGemini(prompt: string): Promise<string> {
    const contents: any[] = [
        {
            role: "user",
            parts: [
                {
                    text: `You are the AI agent for InventoryWatch.

Rules:
  
- When reporting supplier search results, always include the source URL for every result.
- Never omit URLs returned by search_supplier_prices.
- Present each result with the supplier or page title, reported price if available, product/package details if available, and clickable source URL.
- Do not claim a search result contains a price unless that price appears in the tool result.
- If no price is available, say "Harga tidak tercantum pada sumber" and include the source URL.
- Answer in Indonesian unless the user uses another language.
- Use MCP tools to retrieve actual stock and supplier prices.
- Never invent SKUs, stock quantities, safety thresholds, or prices.
- For stock questions, call check_stock.
- When the user asks what products are in inventory or requests a list of all products, call list_inventory.
- For current supplier price questions, call search_supplier_prices.
  - If the user asks for a restock recommendation, first call get_low_stock to get actual low-stock products.
- Only a product with current_stock < safety_threshold (as returned by get_low_stock or check_stock) may be passed to search_supplier_prices. Never call search_supplier_prices for a product that is not below its safety threshold. The tool also blocks such requests; if it returns BLOCKED, report that to the user and do not retry.
- If the user asks for both stock and price, call both tools.
- Base stock status only on check_stock results.
- Base supplier price information only on search_supplier_prices results.
- Never invent prices, supplier names, stock quantities, or SKUs.
- If supplier search fails or returns no useful prices, clearly say that verified pricing is unavailable.
- If the user asks for both stock and price, call both tools.
- Treat tool results as the source of truth.
- If a tool returns an error or cannot find a product, explain that clearly.
- Do not confuse InventoryWatch with a wristwatch.

User request: ${prompt}`,
                },
            ],
        },
    ];

    for (let turn = 0; turn < 5; turn++) {
        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash-lite",
            contents,
            config: {
                tools: [
                    {
                        functionDeclarations: toolDeclarations,
                    },
                ],
            },
        });

        const functionCalls = response.functionCalls;

        if (!functionCalls || functionCalls.length === 0) {
            return response.text || "Gemini did not return a response.";
        }

        const modelContent = response.candidates?.[0]?.content;

        if (modelContent) {
            contents.push(modelContent);
        }

        for (const call of functionCalls) {
            if (!call.name) {
                continue;
            }

            console.log(`\n[Calling MCP tool: ${call.name}]`);
            console.log("Arguments:", call.args);

            try {
                const result = await client.callTool({
                    name: call.name,
                    arguments: call.args ?? {},
                });

                contents.push({
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: call.name,
                                ...(call.id ? { id: call.id } : {}),
                                response: {
                                    result: result.content,
                                    isError: result.isError ?? false,
                                },
                            },
                        },
                    ],
                });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);

                contents.push({
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: call.name,
                                ...(call.id ? { id: call.id } : {}),
                                response: {
                                    error: message,
                                },
                            },
                        },
                    ],
                });
            }
        }
    }

    return "Permintaan membutuhkan terlalu banyak pemanggilan tool. Coba pertanyaan yang lebih spesifik.";
}

async function main() {
    await client.connect(transport);

    const tools = await client.listTools();

    console.log("InventoryWatch Agent is ready.");
    console.log("Available tools:");

    for (const tool of tools.tools) {
        console.log(`- ${tool.name}`);
    }

    const rl = readline.createInterface({
        input: stdin,
        output: stdout,
    });

    try {
        while (true) {
            const prompt = await rl.question("\nYou: ");

            if (prompt.trim().toLowerCase() === "exit") {
                break;
            }

            if (!prompt.trim()) {
                continue;
            }

            let timeout: ReturnType<typeof setTimeout> | undefined;

            try {
                const answer = await Promise.race([
                    askGemini(prompt),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        "Gemini timed out after 30 seconds",
                                    ),
                                ),
                            30000,
                        );
                    }),
                ]);

                console.log("\nGemini:", answer);
            } catch (error) {
                console.error(
                    "\nRequest failed:",
                    error instanceof Error ? error.message : error,
                );
            } finally {
                if (timeout) {
                    clearTimeout(timeout);
                }
            }
        }
    } finally {
        rl.close();
        await client.close();
    }
}

main().catch((error) => {
    console.error("Agent error:", error);
    process.exitCode = 1;
});


