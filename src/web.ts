import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { askWithTimeout, connectAgent, type AgentStep } from "./agent-core.js";
import { createDraft, DraftError, type Offer } from "./draft.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(currentDir, "../public/index.html");
const PORT = Number(process.env.PORT) || 3000;

// The GUI reads inventory and writes only the draft tables; all agent work still goes through the MCP server.
const db = new Database(resolve(currentDir, "../inventory.db"));
db.pragma("busy_timeout = 3000");
const draft = createDraft(db);

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

async function handleChat(req: IncomingMessage, res: ServerResponse) {
    const message = String((await readJson(req)).message ?? "").trim();

    if (!message) {
        return sendJson(res, 400, { error: "Pesan kosong." });
    }

    const steps: AgentStep[] = [];
    const run = queue.then(() => askWithTimeout(message, steps));
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

const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const item = url.match(/^\/api\/draft-order\/items\/([A-Za-z0-9_-]+)(\/offers)?$/);

    try {
        if (req.method === "GET" && url === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(await readFile(pagePath));
        } else if (req.method === "GET" && url === "/api/inventory") {
            handleInventory(res);
        } else if (req.method === "POST" && url === "/api/chat") {
            await handleChat(req, res);
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
