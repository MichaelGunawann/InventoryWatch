import { config } from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

export const client = new Client({
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
            "Return only products whose current_stock is below safety_threshold, with the suggested order quantity (up to max_stock, rounded up to whole cartons). Use this to find which products need restocking before looking up supplier prices.",
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
    {
        name: "compare_supplier_offers",
        description:
            "Compare supplier offers for one product by price per unit (pcs) and return the cheapest. Call this after search_supplier_prices whenever the user asks for the cheapest supplier or a price comparison.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                productName: {
                    type: Type.STRING,
                    description: "The SKU or item name of the product being compared.",
                },
                offers: {
                    type: Type.ARRAY,
                    description: "Offers extracted from the search_supplier_prices result for this product.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            supplier: {
                                type: Type.STRING,
                                description: "Supplier, store, or page title.",
                            },
                            url: {
                                type: Type.STRING,
                                description: "Source URL of the offer.",
                            },
                            price: {
                                type: Type.NUMBER,
                                description: "Price in Rupiah exactly as written in the search result, as a plain number (Rp155.245 -> 155245). For a price range use the lowest price. Omit if no price is written.",
                            },
                            unitsPerPack: {
                                type: Type.NUMBER,
                                description: "How many single items (bungkus, sachet, botol, kotak) that price buys, only if the result states it (e.g. 'dus isi 40' -> 40, '12 renceng x 10 sachet' -> 120). If only a count of renceng/packs is written without the items inside each, omit it.",
                            },
                            packQuantity: {
                                type: Type.NUMBER,
                                description: "How many packs the price buys as written, e.g. '2 lusin' -> 2, '1 dus' -> 1. Omit if not written.",
                            },
                            packUnit: {
                                type: Type.STRING,
                                description: "The pack word exactly as written, e.g. 'dus', 'karton', 'lusin', 'kodi', 'renceng', 'pcs'. Do not convert it to a number yourself. Omit if not written.",
                            },
                            unitSize: {
                                type: Type.STRING,
                                description: "Size of one item as written in the result, e.g. '200ml', '1 liter', '85g'. Omit if not stated.",
                            },
                            packDescription: {
                                type: Type.STRING,
                                description: "Pack description as written, e.g. '1 dus isi 40 pcs'.",
                            },
                        },
                        required: ["supplier", "url"],
                    },
                },
            },
            required: ["productName", "offers"],
        },
    },
    {
        name: "list_tables",
        description: "List all tables in the SQLite database with row counts. Use for questions about how the data is organised.",
        parameters: { type: Type.OBJECT, properties: {} },
    },
    {
        name: "describe_table",
        description: "Show the columns, types, keys, and foreign keys of one table.",
        parameters: {
            type: Type.OBJECT,
            properties: { table: { type: Type.STRING, description: "Table name from list_tables." } },
            required: ["table"],
        },
    },
    {
        name: "read_query",
        description: "Run one read-only SQLite SELECT query for analytics (aggregates, JOINs, GROUP BY, percentages). Writes are rejected. Check column names with describe_table first if unsure.",
        parameters: {
            type: Type.OBJECT,
            properties: { sql: { type: Type.STRING, description: "A single SELECT statement." } },
            required: ["sql"],
        },
    },
    {
        name: "adjust_stock",
        description: "Add or subtract stock for one product. Only when the exact SKU, quantity, unit, and type of change are clear.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                sku: { type: Type.STRING, description: "Exact SKU from check_stock, e.g. SKU001." },
                quantity: { type: Type.NUMBER, description: "How many. The type decides add or subtract; only for koreksi use a negative number to subtract." },
                unit: { type: Type.STRING, enum: ["pcs", "dus"], description: "Unit the user gave: pcs or dus (karton)." },
                type: {
                    type: Type.STRING,
                    enum: ["terjual", "barang_datang", "rusak", "hilang", "koreksi"],
                    description: "terjual = sold (subtract), barang_datang = goods received (add), rusak = damaged/expired (subtract), hilang = lost/stolen (subtract), koreksi = stock count correction (add or subtract).",
                },
                reason: { type: Type.STRING, description: "Optional extra note from the user, e.g. 'kemasan sobek'." },
            },
            required: ["sku", "quantity", "unit", "type"],
        },
    },
    {
        name: "add_product",
        description: "Add a new product. The SKU is generated automatically. Only when the full name (brand, variant, size), current stock, and safety threshold are known.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                itemName: { type: Type.STRING, description: "Full product name with brand, variant, and size." },
                currentStock: { type: Type.NUMBER, description: "Current stock in pcs." },
                safetyThreshold: { type: Type.NUMBER, description: "Minimum stock in pcs." },
                maxStock: { type: Type.NUMBER, description: "Stock to refill up to, in pcs (optional)." },
                unitsPerCarton: { type: Type.NUMBER, description: "Items per dus/karton (optional)." },
                searchKeyword: { type: Type.STRING, description: "Specific name for supplier search (optional)." },
            },
            required: ["itemName", "currentStock", "safetyThreshold"],
        },
    },
    {
        name: "update_product",
        description: "Change product settings (name, safety threshold, max stock, units per carton, search keyword). Not for stock quantities.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                sku: { type: Type.STRING, description: "Exact SKU." },
                itemName: { type: Type.STRING },
                safetyThreshold: { type: Type.NUMBER },
                maxStock: { type: Type.NUMBER },
                unitsPerCarton: { type: Type.NUMBER },
                searchKeyword: { type: Type.STRING },
            },
            required: ["sku"],
        },
    },
    {
        name: "delete_product",
        description: "Permanently delete one product with its draft item, supplier offers, and stock history. Only when the user clearly asks to delete that exact product.",
        parameters: {
            type: Type.OBJECT,
            properties: { sku: { type: Type.STRING, description: "Exact SKU (find it with check_stock first)." } },
            required: ["sku"],
        },
    },
    {
        name: "append_insight",
        description: "Save one short business insight to the memo://insights memo after analysing data. Use when the user asks to record or summarise insights, or after an analytics question.",
        parameters: {
            type: Type.OBJECT,
            properties: { insight: { type: Type.STRING, description: "One factual insight based on tool results, in Indonesian." } },
            required: ["insight"],
        },
    },
];

// One MCP tool call made while answering, shown as a step in the GUI.
export type AgentStep = {
    name: string;
    args: Record<string, unknown>;
    isError: boolean;
    // Data part of the tool result (structuredContent), if the tool sent one.
    structured?: unknown;
    // Why the tool failed (e.g. a BLOCKED message), shown under the step in the GUI.
    message?: string;
    // True when the call was held back until the user confirms it (nothing was saved).
    pending?: boolean;
};

// Earlier turns of one conversation, so the agent can ask a follow-up question and understand the answer.
export type ChatHistory = { role: "user" | "model"; parts: { text: string }[] }[];

const MAX_HISTORY = 20;

export async function connectAgent() {
    await client.connect(transport);
    return client.listTools();
}

const SYSTEM_PROMPT = `You are the AI agent for InventoryWatch.

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
- For restock recommendations, report the suggested order quantity exactly as returned by get_low_stock or compare_supplier_offers (cartons, pcs, stock after order, and any note about exceeding max_stock), and the estimated cost from compare_supplier_offers when available. Never calculate order quantities or totals yourself; prices exclude shipping.
- Only a product with current_stock < safety_threshold (as returned by get_low_stock or check_stock) may be passed to search_supplier_prices. Never call search_supplier_prices for a product that is not below its safety threshold. The tool also blocks such requests; if it returns BLOCKED, report that to the user and do not retry.
- If the user asks for both stock and price, call both tools.
- Base stock status only on check_stock results.
- Base supplier price information only on search_supplier_prices results.
- Never invent prices, supplier names, stock quantities, or SKUs.
- If supplier search fails or returns no useful prices, clearly say that verified pricing is unavailable.
- If the user asks for both stock and price, call both tools.
- When the user asks for the cheapest supplier or a price comparison, after search_supplier_prices call compare_supplier_offers once per product:
  - Include only listings that are clearly the same product (same brand and variant; same size if the product name has a size). Leave out other products and other variants, for example Teh Gelas when comparing Teh Botol, or Indomie Goreng Jumbo / Cabe Ijo when comparing Indomie Goreng.
  - Copy price, unitsPerPack, packQuantity, packUnit, and unitSize only from what the search result text says. Omit a field when it is not written; never estimate it. Never guess how many items are in a dus or karton; the tool fills that from store data.
  - If the tool notes that a pack size was assumed from store data, tell the user.
  - Never calculate price per unit or choose the cheapest yourself; report the result of compare_supplier_offers, including its source URL.
  - If compare_supplier_offers returns several sizes, report the cheapest for each size and say the sizes are not comparable with each other.
  - Say that the cheapest is among the search results found, and that prices exclude shipping and minimum order.
- Treat tool results as the source of truth.
- If a tool returns an error or cannot find a product, explain that clearly.
- Schema questions (tables, columns, how data is organised): call list_tables and describe_table.
- Analytics questions (totals, percentages, rankings, comparisons across tables, best sellers, trends): write a SELECT for read_query. Products are in the table inventory (there is no products table). stock_movements.type says why stock changed: 'terjual' = sales (sold pcs = -change_pcs), 'barang_datang' = deliveries, 'rusak' = damaged/expired, 'hilang' = lost, 'koreksi' = stock count correction. Count ONLY type = 'terjual' as sales; never count rusak, hilang, or koreksi as sales (they can be reported separately as losses). created_at is UTC text 'YYYY-MM-DD HH:MM:SS'; use date()/strftime() for daily or weekly grouping, and datetime('now', '-30 days') for 'this month' unless the user names a calendar month. Some history is simulated demo data (reason contains '(simulasi)'); mention that when presenting sales figures. Purchase orders made from the draft are in purchase_orders and purchase_order_items (status 'dipesan' = on the way, 'diterima' = arrived, 'dibatalkan' = cancelled).
- If get_low_stock says a product is already ordered, tell the user it is on the way (with the PO number) instead of recommending a new order or searching supplier prices for it, unless the user explicitly asks. Check column names with describe_table first if unsure. Explain the result in plain Indonesian, not as raw JSON.
- Changing data: use adjust_stock (stock quantities), add_product (new product), update_product (settings), or delete_product (remove a product completely). Only delete when the user explicitly asks to delete or remove a product; never delete to 'fix' something else. If the name matches several products, ask which SKU.
  - For adjust_stock, the type of change must be clear. If the user does not say why stock goes up or down (for example "kurangi 5 indomie" or "tambah 10 aqua"), ask whether it is terjual, rusak/kedaluwarsa, hilang, barang datang, or koreksi stock opname. Never guess the type.
  - Before changing data, the request must be unambiguous. First find the product with check_stock. If several products match (for example different sizes or variants), if the quantity is missing, or if it is unclear whether the quantity is in pcs or dus, ask the user a short follow-up question and do NOT call the tool yet.
  - For add_product, ask for any missing required detail: full name with brand, variant, and size; current stock; safety threshold. Also ask for max stock and units per dus, but the user may skip them.
  - Keep the product name and size as the user wrote them. You may fix an obvious typo (for example "600mk" -> "600ml", "gireng" -> "goreng"), because the name is shown to the user for confirmation, but never add a brand, variant, or flavour the user did not write (for example "inmie" may become "Indomie", but NOT "Indomie Goreng Rendang"). If a size looks unrealistic for that kind of product (for example instant noodles of several kg), ask the user to double-check.
  - If the user gives conflicting numbers (for example two different stock values), ask which one is right.
  - add_product, update_product, and delete_product are held back by code until the user confirms, and code shows confirm buttons. So when the request is clear, CALL THE TOOL; do not ask the user to type "ya" yourself before calling it (no tool call means no button).
  - The add_product confirmation result lists the existing products. Compare by meaning, not exact spelling (cabe = cabai, ijo = hijau, typos, size written differently or missing). If it looks like an existing product, say so with its SKU and ask whether the user meant that one.
  - When a tool result says NOT DONE YET, list the exact values (for add/update: name, stock, threshold, max stock, units per dus; for delete: SKU, name, current stock, and that its stock history and supplier offers are deleted too) and tell the user to press the confirm button below.
  - On the user's next reply: if it clearly agrees to exactly that action (any wording), call the same tool again with exactly the same values. Deletes cannot be confirmed by text; ask the user to press the button. If the reply corrects something, asks for something else, or is unclear, do not repeat the call; treat it as a new request and ask if unsure which action the user wants.
  - Never guess a SKU, quantity, unit, or size. After the change, report the before and after values from the tool result.
- Insights: when the user asks to save or summarise insights, or after answering an analytics question when the user asks for it, call append_insight with one short factual insight based on tool results.
- If the user refers to something that is not in this conversation (for example "itu", "yang tadi", "yang aneh" right after a new chat), do not guess which product they mean; ask.
- Use earlier messages in this conversation to understand short follow-up answers (for example "yang 85g, 2 dus").
- Do not confuse InventoryWatch with a wristwatch.`;

// add_product, update_product and delete_product change product data, so code holds them back and the user
// confirms first. Gemini understands the reply; code only checks that what runs is exactly what was shown:
// - the waiting call lives for one turn only (the user's very next message), then it is dropped;
// - add/update run when Gemini repeats exactly the same call after the user's reply;
// - delete runs only from the confirm button (or the CLI y/n prompt), never from typed text, because it cannot be undone.
const CONFIRM_TOOLS = new Set(["add_product", "update_product", "delete_product"]);
const BUTTON_ONLY = new Set(["delete_product"]);

type PendingCall = { name: string; args: Record<string, unknown>; key: string };
const pendingCalls = new WeakMap<ChatHistory, PendingCall>();

export type AskOptions = {
    // True when the user pressed the confirm button: code runs the waiting call itself, unchanged.
    confirm?: boolean;
};

function callKey(name: string, args: Record<string, unknown>) {
    const sorted = Object.keys(args).sort().map((key) => [key, typeof args[key] === "string" ? (args[key] as string).trim() : args[key]]);
    return JSON.stringify([name, sorted]);
}

function functionResponse(call: { name?: string; id?: string }, response: Record<string, unknown>) {
    return { role: "user", parts: [{ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response } }] };
}

const MODEL = "gemini-3.5-flash-lite";
// Optional second model (set GEMINI_FALLBACK_MODEL in .env) used only when the main one stays overloaded.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL?.trim() || null;
// 503 = model overloaded, 429 = rate limit, 500 = temporary server error. Other errors (bad key, bad request) are not retried.
const RETRYABLE = new Set([429, 500, 503]);
const RETRY_DELAYS_MS = [2000, 4000, 8000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Asking Gemini has no side effects (tools run only after a response arrives), so a failed call is safe to repeat.
async function generateWithRetry(contents: any[]) {
    const models = FALLBACK_MODEL ? [MODEL, FALLBACK_MODEL] : [MODEL];
    let lastError: unknown;

    for (const model of models) {
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                return await ai.models.generateContent({
                    model,
                    contents,
                    config: {
                        systemInstruction: SYSTEM_PROMPT,
                        tools: [{ functionDeclarations: toolDeclarations }],
                    },
                });
            } catch (error) {
                lastError = error;
                const status = (error as { status?: number }).status;

                // "fetch failed" = the request never reached Google (internet dropped, DNS, timeout).
                if (!isNetworkError(error) && !(status && RETRYABLE.has(status))) {
                    throw error;
                }

                if (attempt < RETRY_DELAYS_MS.length) {
                    console.log(`[Gemini ${model} ${status ?? "network error"}, retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s]`);
                    await sleep(RETRY_DELAYS_MS[attempt]);
                }
            }
        }
    }

    const status = (lastError as { status?: number }).status;
    throw new Error(
        isNetworkError(lastError)
            ? "Tidak bisa terhubung ke Gemini (koneksi internet bermasalah, sudah dicoba ulang beberapa kali). Cek internet lalu kirim lagi."
            : status === 429
                ? "Kuota/limit Gemini sedang habis. Tunggu sebentar lalu coba lagi."
                : "Server Gemini sedang sibuk (sudah dicoba ulang beberapa kali). Coba lagi sebentar lagi.",
    );
}

function isNetworkError(error: unknown) {
    return error instanceof TypeError && /fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(
        `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`,
    );
}

export async function askGemini(prompt: string, steps: AgentStep[] = [], history: ChatHistory = [], options: AskOptions = {}): Promise<string> {
    // A waiting call can only be confirmed by the very next message, so it is taken out now.
    const previous = pendingCalls.get(history);
    pendingCalls.delete(history);

    let geminiPrompt = prompt;

    if (options.confirm) {
        if (!previous) {
            const answer = "Tidak ada perubahan yang sedang menunggu konfirmasi. Kirim ulang permintaanmu.";
            history.push({ role: "user", parts: [{ text: prompt }] }, { role: "model", parts: [{ text: answer }] });
            return answer;
        }

        // The button runs exactly the call the user saw; Gemini only reports the result.
        const result = await runTool(previous.name, previous.args, steps);
        geminiPrompt = `${prompt}\n\n[The user pressed the confirm button. Code already ran ${previous.name} with ${JSON.stringify(previous.args)}. `
            + `Result: ${result.text}\nReport this result to the user. Do not call ${previous.name} again.]`;
    }

    const contents: any[] = [
        ...history,
        { role: "user", parts: [{ text: geminiPrompt }] },
    ];

    for (let turn = 0; turn < 8; turn++) {
        const response = await generateWithRetry(contents);

        const functionCalls = response.functionCalls;

        if (!functionCalls || functionCalls.length === 0) {
            const answer = response.text || "Gemini did not return a response.";

            // Keep only the text of each turn; tool details stay out of the history to keep it small.
            history.push({ role: "user", parts: [{ text: prompt }] }, { role: "model", parts: [{ text: answer }] });
            history.splice(0, Math.max(history.length - MAX_HISTORY, 0));

            return answer;
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

            const args = call.args ?? {};
            const key = callKey(call.name, args);

            if (CONFIRM_TOOLS.has(call.name)) {
                const confirmedByReply = previous?.key === key && !BUTTON_ONLY.has(call.name);

                if (!confirmedByReply) {
                    pendingCalls.set(history, { name: call.name, args, key });

                    // A new product is compared with every existing product (by Gemini, by meaning), so
                    // "Indomie Goreng Cabai Hijau" is noticed when "Indomie Goreng Cabe Ijo 95g" already exists.
                    const existing = call.name === "add_product" ? (await runTool("list_inventory", {}, steps)).text : "";

                    steps.push({ name: call.name, args, isError: false, pending: true, message: "Belum dijalankan: menunggu konfirmasi pengguna." });
                    contents.push(functionResponse(call, {
                        result: "NOT DONE YET (code requires the user's confirmation; a confirm button is shown below your answer). "
                            + (existing
                                ? "Existing products:\n" + existing + "\nFirst compare the new product with these by meaning, not exact spelling "
                                    + "(cabe = cabai, ijo = hijau, typos, size written differently or missing). If one is probably the same product, "
                                    + "warn the user, name it with its SKU, and ask whether they meant that one (then use adjust_stock instead) or really "
                                    + "want a separate new product (then press the button). "
                                : "")
                            + "Show the user every value you passed, especially the exact product name, and tell them to press the confirm button"
                            + (BUTTON_ONLY.has(call.name) ? " (deleting can only be confirmed with the button)." : " or reply to confirm or correct it.")
                            + " Do not call this tool again in this turn.",
                    }));
                    continue;
                }
            }

            const result = await runTool(call.name, args, steps);
            contents.push(functionResponse(call, result.error
                ? { error: result.error }
                : { result: result.content, isError: result.isError }));
        }
    }

    return "Permintaan membutuhkan terlalu banyak pemanggilan tool. Coba pertanyaan yang lebih spesifik.";
}

// Calls one MCP tool and records it as a step for the GUI.
async function runTool(name: string, args: Record<string, unknown>, steps: AgentStep[]) {
    try {
        const result = await client.callTool({ name, arguments: args });
        const isError = Boolean(result.isError);
        const text = firstText(result.content) ?? "";

        // Only the GUI message is shortened; Gemini gets the full text (e.g. the whole product list).
        steps.push({ name, args, isError, structured: result.structuredContent, message: isError ? text.slice(0, 300) : undefined });
        return { content: result.content, isError, text, error: undefined };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        steps.push({ name, args, isError: true, message });
        return { content: undefined, isError: true, text: message, error: message };
    }
}

const TIMEOUT_MS = 180000;

// askGemini with a time limit, so one slow request cannot hang the CLI or the GUI.
export async function askWithTimeout(prompt: string, steps: AgentStep[] = [], history: ChatHistory = [], options: AskOptions = {}): Promise<string> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            askGemini(prompt, steps, history, options),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`Gemini timed out after ${TIMEOUT_MS / 1000} seconds`)),
                    TIMEOUT_MS,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

function firstText(content: unknown): string | undefined {
    const parts = Array.isArray(content) ? content : [];
    const part = parts.find((p) => p && typeof p === "object" && (p as { type?: string }).type === "text") as { text?: string } | undefined;
    return part?.text;
}
