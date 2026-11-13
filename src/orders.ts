// Purchase orders: draft -> "dipesan" (ordered) -> "diterima" (arrived) or "dibatalkan" (cancelled).
// The tables are created in draft.ts. Adding the arrived stock is done by web.ts through the MCP
// adjust_stock tool, so every stock change still goes through MCP and is logged in stock_movements.
import type { Database } from "better-sqlite3";
import { DraftError, type createDraft } from "./draft.js";

type Draft = ReturnType<typeof createDraft>;

export type OrderItem = {
    id: number;
    order_id: number;
    sku: string;
    item_name: string;
    quantity: number;
    unit: string;
    receive_pcs: number;
    supplier_name: string | null;
    supplier_url: string | null;
    price: number | null;
    units_per_pack: number | null;
    packs: number | null;
    cost: number | null;
    status: "dipesan" | "diterima" | "dibatalkan";
    closed_at: string | null;
};

export const orderCode = (id: number) => `PO-${String(id).padStart(4, "0")}`;

export function createOrders(db: Database, draft: Draft) {
    const getItem = (id: number) => db.prepare(`SELECT * FROM purchase_order_items WHERE id = ?`).get(id) as OrderItem | undefined;

    return {
        // Turns every item in the draft into one purchase order and empties those items from the draft.
        placeFromDraft() {
            const { items } = draft.get();

            if (items.length === 0) {
                throw new DraftError(400, "Draf kosong, tidak ada yang bisa dipesan.");
            }

            const insertItem = db.prepare(`
                INSERT INTO purchase_order_items
                    (order_id, sku, item_name, quantity, unit, receive_pcs, supplier_name, supplier_url, price, units_per_pack, packs, cost)
                VALUES
                    (@order_id, @sku, @item_name, @quantity, @unit, @receive_pcs, @supplier_name, @supplier_url, @price, @units_per_pack, @packs, @cost)
            `);

            return db.transaction(() => {
                const orderId = Number(db.prepare(`INSERT INTO purchase_orders (ordered_at) VALUES (datetime('now'))`).run().lastInsertRowid);

                for (const item of items) {
                    insertItem.run({
                        order_id: orderId,
                        sku: item.sku,
                        item_name: item.item_name,
                        quantity: item.quantity,
                        unit: item.unit,
                        // With a supplier, stock grows by the whole packs bought; without one, by the ordered pcs.
                        receive_pcs: item.purchase?.pcs ?? item.orderPcs,
                        supplier_name: item.supplier?.name ?? null,
                        supplier_url: item.supplier?.url ?? null,
                        price: item.supplier?.price ?? null,
                        units_per_pack: item.supplier?.unitsPerPack ?? null,
                        packs: item.purchase?.packs ?? null,
                        cost: item.purchase?.cost ?? null,
                    });
                    db.prepare(`DELETE FROM draft_order_items WHERE sku = ?`).run(item.sku);
                }

                return orderId;
            })();
        },

        list() {
            const orders = db.prepare(`SELECT id, ordered_at FROM purchase_orders ORDER BY id DESC LIMIT 30`).all() as { id: number; ordered_at: string }[];
            const itemsOf = db.prepare(`SELECT * FROM purchase_order_items WHERE order_id = ? ORDER BY item_name`);

            return orders.map((order) => {
                const items = itemsOf.all(order.id) as OrderItem[];
                const open = items.filter((item) => item.status === "dipesan").length;

                return {
                    id: order.id,
                    code: orderCode(order.id),
                    orderedAt: order.ordered_at,
                    status: open > 0 ? "dipesan" : "selesai",
                    open,
                    total: items.filter((item) => item.status !== "dibatalkan").reduce((sum, item) => sum + (item.cost ?? 0), 0),
                    items,
                };
            });
        },

        openCount() {
            return (db.prepare(`SELECT COUNT(*) AS n FROM purchase_order_items WHERE status = 'dipesan'`).get() as { n: number }).n;
        },

        // An item that is still on the way (status 'dipesan'), or an error.
        requireOpen(id: number) {
            const item = getItem(id);

            if (!item) throw new DraftError(404, "Item pesanan tidak ditemukan.");
            if (item.status !== "dipesan") throw new DraftError(400, `Item ini sudah berstatus "${item.status}".`);

            return item;
        },

        openItemsOf(orderId: number) {
            return db.prepare(`SELECT * FROM purchase_order_items WHERE order_id = ? AND status = 'dipesan'`).all(orderId) as OrderItem[];
        },

        close(id: number, status: "diterima" | "dibatalkan") {
            db.prepare(`UPDATE purchase_order_items SET status = ?, closed_at = datetime('now') WHERE id = ? AND status = 'dipesan'`).run(status, id);
        },
    };
}
