import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { askWithTimeout, client, connectAgent, type AgentStep, type ChatHistory } from "./agent-core.js";
import { createDraft, DraftError, type Offer } from "./draft.js";
import { createOrders, orderCode, type OrderItem } from "./orders.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(currentDir, "../public/index.html");
const PORT = Number(process.env.PORT) || 3000;

// The GUI reads inventory and writes the draft and order tables; stock changes and all agent work go through the MCP server.
const db = new Database(resolve(currentDir, "../inventory.db"));
db.pragma("busy_timeout = 3000");
const draft = createDraft(db);
const orders = createOrders(db, draft);

function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body = "";

    for await (const chunk of req) {
        body += chunk;

        if (body.length > 10_000) {
            throw new DraftError(413, "Permintaan terlalu besar.");
        }
    }

    try {
        const parsed = JSON.parse(body || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        throw new DraftError(400, "Permintaan tidak valid.");
    }
}

// compare_supplier_offers results are saved as the latest offers for that SKU.
function rememberOffers(steps: AgentStep[]) {
    for (const step of steps) {
        const data = step.structured as { sku?: string | null; offers?: Offer[] } | undefined;

        if (step.name === "compare_supplier_offers" && data?.sku && data.offers?.length) {
            draft.saveOffers(data.sku, data.offers);
        }
    }
}

// Requests are answered one at a time because they share one MCP connection.
let queue: Promise<unknown> = Promise.resolve();

// One conversation for the GUI (single local user); "Chat baru" clears it.
let history: ChatHistory = [];

async function handleChat(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const message = String(body.message ?? "").trim();
    // Set by the "Ya, simpan / Ya, hapus" button: code runs the waiting change exactly as shown.
    const confirm = body.confirm === true;

    if (!message) {
        return sendJson(res, 400, { error: "Pesan kosong." });
    }

    const steps: AgentStep[] = [];
    const run = queue.then(() => askWithTimeout(message, steps, history, { confirm }));
    queue = run.catch(() => undefined);

    try {
        const answer = await run;
        rememberOffers(steps);
        sendJson(res, 200, { answer, steps });
    } catch (error) {
        sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
            steps,
        });
    }
}

// The tools and resources the MCP server offers, read live from the server.
async function handleMcp(res: ServerResponse) {
    const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);

    sendJson(res, 200, {
        tools: tools.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
        resources: resources.resources.map((r) => ({ uri: r.uri, name: r.name, description: r.description ?? "" })),
    });
}

// The memo://insights resource, read through MCP like any MCP client would.
async function handleInsights(res: ServerResponse) {
    const result = await client.readResource({ uri: "memo://insights" });
    const first = result.contents[0] as { text?: string } | undefined;

    sendJson(res, 200, { uri: "memo://insights", text: first?.text ?? "" });
}

function handleInventory(res: ServerResponse) {
    const products = db.prepare(`
        SELECT sku, item_name, current_stock, safety_threshold, max_stock, units_per_carton
        FROM inventory
        ORDER BY item_name
    `).all();

    sendJson(res, 200, { products });
}

// PATCH body: { quantity: number | null } | { offerId: number | null } | { manualSupplier: {...} } | { removed: false }
async function handleDraftPatch(req: IncomingMessage, sku: string) {
    const body = await readJson(req);

    if ("quantity" in body) {
        draft.setQuantity(sku, body.quantity === null ? null : Number(body.quantity));
    } else if ("offerId" in body) {
        draft.chooseOffer(sku, body.offerId === null ? null : Number(body.offerId));
    } else if ("manualSupplier" in body) {
        draft.setManualSupplier(sku, (body.manualSupplier ?? {}) as Record<string, unknown>);
    } else if (body.removed === false) {
        draft.restore(sku);
    } else {
        throw new DraftError(400, "Tidak ada perubahan.");
    }
}

// "Sudah sampai": stock goes up through the MCP adjust_stock tool (validated and logged in stock_movements),
// and only when that succeeds is the order item marked as received.
async function receiveItem(item: OrderItem) {
    const result = await client.callTool({
        name: "adjust_stock",
        arguments: { sku: item.sku, quantity: item.receive_pcs, unit: "pcs", type: "barang_datang", reason: orderCode(item.order_id) },
    });
    const content = result.content as { type: string; text?: string }[];
    const text = content.find((part) => part.type === "text")?.text ?? "";

    if (result.isError) {
        throw new DraftError(400, `${item.item_name}: stok gagal ditambah. ${text}`);
    }

    orders.close(item.id, "diterima");
    return text;
}

function ordersState() {
    return { orders: orders.list(), open: orders.openCount(), draft: draft.get() };
}

const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const item = url.match(/^\/api\/draft-order\/items\/([A-Za-z0-9_-]+)(\/offers)?$/);
    const orderItem = url.match(/^\/api\/orders\/items\/(\d+)\/(receive|cancel)$/);
    const wholeOrder = url.match(/^\/api\/orders\/(\d+)\/receive-all$/);

    try {
        if (req.method === "GET" && url === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(await readFile(pagePath));
        } else if (req.method === "GET" && url === "/api/inventory") {
            handleInventory(res);
        } else if (req.method === "POST" && url === "/api/chat") {
            await handleChat(req, res);
        } else if (req.method === "POST" && url === "/api/chat/reset") {
            history = [];
            sendJson(res, 200, { ok: true });
        } else if (req.method === "GET" && url === "/api/mcp") {
            await handleMcp(res);
        } else if (req.method === "GET" && url === "/api/insights") {
            await handleInsights(res);
        } else if (req.method === "GET" && url === "/api/draft-order") {
            sendJson(res, 200, draft.get());
        } else if (req.method === "GET" && url === "/api/draft-order/products") {
            sendJson(res, 200, { products: draft.products() });
        } else if (req.method === "POST" && url === "/api/draft-order/items") {
            draft.add(String((await readJson(req)).sku ?? ""));
            sendJson(res, 200, draft.get());
        } else if (item && item[2] && req.method === "GET") {
            sendJson(res, 200, { offers: draft.offers(item[1]) });
        } else if (item && !item[2] && req.method === "PATCH") {
            await handleDraftPatch(req, item[1]);
            sendJson(res, 200, draft.get());
        } else if (item && !item[2] && req.method === "DELETE") {
            draft.remove(item[1]);
            sendJson(res, 200, draft.get());
        } else if (req.method === "GET" && url === "/api/orders") {
            sendJson(res, 200, ordersState());
        } else if (req.method === "POST" && url === "/api/orders") {
            orders.placeFromDraft();
            sendJson(res, 200, ordersState());
        } else if (req.method === "POST" && orderItem) {
            const open = orders.requireOpen(Number(orderItem[1]));
            if (orderItem[2] === "receive") {
                await receiveItem(open);
            } else {
                orders.close(open.id, "dibatalkan");
            }
            sendJson(res, 200, ordersState());
        } else if (req.method === "POST" && wholeOrder) {
            for (const open of orders.openItemsOf(Number(wholeOrder[1]))) {
                await receiveItem(open);
            }
            sendJson(res, 200, ordersState());
        } else {
            sendJson(res, 404, { error: "Not found" });
        }
    } catch (error) {
        const status = error instanceof DraftError ? error.status : 500;
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
});

await connectAgent();

server.listen(PORT, "127.0.0.1", () => {
    console.log(`InventoryWatch GUI: http://localhost:${PORT}`);
});
