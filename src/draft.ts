// Draft restock order, stored in SQLite so edits (quantity, supplier, add, remove) survive a restart.
import type { Database } from "better-sqlite3";
import { orderPlan } from "./order.js";

export type Offer = {
    size: string;
    supplier: string;
    url: string;
    price: number;
    unitsPerPack: number;
    unitPrice: number;
    assumption: string;
};

type Product = {
    sku: string;
    item_name: string;
    current_stock: number;
    safety_threshold: number;
    max_stock: number | null;
    units_per_carton: number | null;
};

type DraftRow = {
    sku: string;
    quantity: number | null;
    supplier_source: "search" | "manual" | null;
    supplier_name: string | null;
    supplier_url: string | null;
    price: number | null;
    units_per_pack: number | null;
    unit_size: string | null;
    assumption: string | null;
    added_manually: number;
    removed: number;
};

type OfferRow = {
    id: number;
    supplier: string;
    url: string;
    price: number;
    units_per_pack: number;
    unit_price: number;
    unit_size: string;
    assumption: string;
    compared_at: string;
};

export function createDraft(db: Database) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS draft_order_items (
            sku TEXT PRIMARY KEY REFERENCES inventory(sku),
            quantity INTEGER,              -- in cartons (or pcs if the carton size is unknown); NULL = suggested
            supplier_source TEXT,          -- 'search', 'manual', or NULL = cheapest search offer
            supplier_name TEXT,
            supplier_url TEXT,
            price REAL,
            units_per_pack INTEGER,
            unit_size TEXT,
            assumption TEXT,
            added_manually INTEGER NOT NULL DEFAULT 0,
            removed INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS supplier_offers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku TEXT NOT NULL REFERENCES inventory(sku),
            supplier TEXT NOT NULL,
            url TEXT NOT NULL,
            price REAL NOT NULL,
            units_per_pack INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            unit_size TEXT NOT NULL,
            assumption TEXT NOT NULL,
            compared_at TEXT NOT NULL
        );
    `);

    const getProduct = (sku: string) => db.prepare(`
        SELECT sku, item_name, current_stock, safety_threshold, max_stock, units_per_carton
        FROM inventory WHERE sku = ?
    `).get(sku) as Product | undefined;

    const getRow = (sku: string) => db.prepare(`SELECT * FROM draft_order_items WHERE sku = ?`).get(sku) as DraftRow | undefined;

    const offersFor = (sku: string) => db.prepare(`
        SELECT * FROM supplier_offers WHERE sku = ? ORDER BY unit_price
    `).all(sku) as OfferRow[];

    const touch = (sku: string, fields: Record<string, unknown>) => {
        const columns = Object.keys(fields);
        db.prepare(`
            UPDATE draft_order_items
            SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, updated_at = datetime('now')
            WHERE sku = @sku
        `).run({ ...fields, sku });
    };

    // Low-stock products join the draft automatically; auto items leave it when the stock is fine again.
    function sync() {
        db.prepare(`
            INSERT OR IGNORE INTO draft_order_items (sku, updated_at)
            SELECT sku, datetime('now') FROM inventory WHERE current_stock < safety_threshold
        `).run();
        db.prepare(`
            DELETE FROM draft_order_items
            WHERE (added_manually = 0 OR removed = 1)
              AND sku IN (SELECT sku FROM inventory WHERE current_stock >= safety_threshold)
        `).run();
    }

    function describe(row: DraftRow) {
        const product = getProduct(row.sku)!;
        const isLow = product.current_stock < product.safety_threshold;
        const perUnit = product.units_per_carton ?? 1;
        const unit = product.units_per_carton ? "dus" : "pcs";

        const plan = orderPlan(product);
        const suggested = plan ? (plan.cartons ?? plan.orderPcs) : null;
        const quantity = row.quantity ?? (suggested && suggested > 0 ? suggested : 1);
        const orderPcs = quantity * perUnit;
        const stockAfter = product.current_stock + orderPcs;

        const offers = offersFor(row.sku);
        const cheapest = offers[0];
        const supplier = row.supplier_source
            ? {
                source: row.supplier_source,
                name: row.supplier_name!,
                url: row.supplier_url,
                price: row.price!,
                unitsPerPack: row.units_per_pack!,
                size: row.unit_size,
                assumption: row.assumption,
            }
            : cheapest
                ? {
                    source: "search" as const,
                    name: cheapest.supplier,
                    url: cheapest.url,
                    price: cheapest.price,
                    unitsPerPack: cheapest.units_per_pack,
                    size: cheapest.unit_size,
                    assumption: cheapest.assumption,
                }
                : null;

        let purchase = null;

        if (supplier) {
            // Buy whole supplier packs, rounded up, to cover the ordered pcs.
            const packs = Math.ceil(orderPcs / supplier.unitsPerPack);
            const unitPrice = supplier.price / supplier.unitsPerPack;
            purchase = {
                packs,
                pcs: packs * supplier.unitsPerPack,
                unitPrice,
                cost: packs * supplier.price,
                cheaperUnitPrice: cheapest && cheapest.unit_price < unitPrice - 0.5 ? cheapest.unit_price : null,
            };
        }

        return {
            sku: product.sku,
            item_name: product.item_name,
            current_stock: product.current_stock,
            safety_threshold: product.safety_threshold,
            max_stock: product.max_stock,
            units_per_carton: product.units_per_carton,
            isLow,
            addedManually: Boolean(row.added_manually),
            unit,
            perUnit,
            quantity,
            suggested,
            orderPcs,
            stockAfter,
            stillLow: stockAfter < product.safety_threshold,
            overMax: product.max_stock !== null ? stockAfter - product.max_stock : null,
            supplier: supplier ? { ...supplier, autoPicked: !row.supplier_source } : null,
            purchase,
            offerCount: offers.length,
            comparedAt: cheapest?.compared_at ?? null,
        };
    }

    return {
        get() {
            sync();
            const rows = db.prepare(`
                SELECT d.* FROM draft_order_items d JOIN inventory i ON i.sku = d.sku
                WHERE d.removed = 0 ORDER BY i.item_name
            `).all() as DraftRow[];
            const items = rows.map(describe);
            const priced = items.filter((item) => item.purchase);

            return {
                items,
                total: priced.reduce((sum, item) => sum + item.purchase!.cost, 0),
                unpriced: items.length - priced.length,
            };
        },

        products() {
            sync();
            return db.prepare(`
                SELECT i.sku, i.item_name, i.current_stock, i.safety_threshold,
                       COALESCE(d.removed, 1) AS not_in_draft
                FROM inventory i LEFT JOIN draft_order_items d ON d.sku = i.sku
                ORDER BY i.item_name
            `).all();
        },

        offers(sku: string) {
            return offersFor(sku).map((offer) => ({
                id: offer.id,
                size: offer.unit_size,
                supplier: offer.supplier,
                url: offer.url,
                price: offer.price,
                unitsPerPack: offer.units_per_pack,
                unitPrice: offer.unit_price,
                assumption: offer.assumption,
                comparedAt: offer.compared_at,
            }));
        },

        // Called with compare_supplier_offers results: the newest search replaces the old offers of that SKU.
        saveOffers(sku: string, offers: Offer[]) {
            if (!getProduct(sku)) return;
            const insert = db.prepare(`
                INSERT INTO supplier_offers (sku, supplier, url, price, units_per_pack, unit_price, unit_size, assumption, compared_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `);
            db.transaction(() => {
                db.prepare(`DELETE FROM supplier_offers WHERE sku = ?`).run(sku);
                for (const o of offers) {
                    insert.run(sku, o.supplier, o.url, o.price, o.unitsPerPack, o.unitPrice, o.size, o.assumption ?? "");
                }
            })();
        },

        add(sku: string) {
            if (!getProduct(sku)) throw new DraftError(404, "Produk tidak ditemukan.");
            db.prepare(`
                INSERT INTO draft_order_items (sku, added_manually, updated_at) VALUES (?, 1, datetime('now'))
                ON CONFLICT(sku) DO UPDATE SET removed = 0, added_manually = 1, updated_at = datetime('now')
            `).run(sku);
        },

        remove(sku: string) {
            requireRow(sku);
            touch(sku, { removed: 1 });
        },

        restore(sku: string) {
            requireRow(sku);
            touch(sku, { removed: 0 });
        },

        setQuantity(sku: string, quantity: number | null) {
            requireRow(sku);
            if (quantity !== null && !(Number.isInteger(quantity) && quantity >= 1 && quantity <= 9999)) {
                throw new DraftError(400, "Jumlah harus bilangan bulat 1 sampai 9999.");
            }
            touch(sku, { quantity });
        },

        // Supplier from the saved search offers (by id), or NULL to go back to the cheapest automatically.
        chooseOffer(sku: string, offerId: number | null) {
            requireRow(sku);
            if (offerId === null) {
                touch(sku, emptySupplier());
                return;
            }
            const offer = db.prepare(`SELECT * FROM supplier_offers WHERE id = ? AND sku = ?`).get(offerId, sku) as OfferRow | undefined;
            if (!offer) throw new DraftError(404, "Penawaran tidak ditemukan. Coba cari ulang harga.");
            touch(sku, {
                supplier_source: "search",
                supplier_name: offer.supplier,
                supplier_url: offer.url,
                price: offer.price,
                units_per_pack: offer.units_per_pack,
                unit_size: offer.unit_size,
                assumption: offer.assumption,
            });
        },

        setManualSupplier(sku: string, input: { name?: unknown; price?: unknown; unitsPerPack?: unknown; url?: unknown }) {
            requireRow(sku);
            const name = String(input.name ?? "").trim();
            const price = Number(input.price);
            const unitsPerPack = Number(input.unitsPerPack);
            const url = String(input.url ?? "").trim();

            if (!name || name.length > 100) throw new DraftError(400, "Nama supplier wajib diisi (maks. 100 karakter).");
            if (!(price > 0 && price < 1e10)) throw new DraftError(400, "Harga harus lebih dari 0.");
            if (!(Number.isInteger(unitsPerPack) && unitsPerPack >= 1 && unitsPerPack <= 100000)) {
                throw new DraftError(400, "Isi per pack harus bilangan bulat minimal 1.");
            }
            if (url && !/^https?:\/\//i.test(url)) throw new DraftError(400, "Link harus diawali http:// atau https://.");

            touch(sku, {
                supplier_source: "manual",
                supplier_name: name,
                supplier_url: url || null,
                price,
                units_per_pack: unitsPerPack,
                unit_size: null,
                assumption: null,
            });
        },
    };

    function requireRow(sku: string) {
        if (!getRow(sku)) throw new DraftError(404, "Produk tidak ada di draf.");
    }
}

function emptySupplier() {
    return {
        supplier_source: null,
        supplier_name: null,
        supplier_url: null,
        price: null,
        units_per_pack: null,
        unit_size: null,
        assumption: null,
    };
}

export class DraftError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}
