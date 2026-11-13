// Fills stock_movements with 60 days of SIMULATED sales and deliveries, so analytics questions
// ("top selling products this month", weekly trends, days until stock runs out) have data to work on.
//
// The history is built backwards from today's stock, so every row's stock_before/stock_after chain
// ends exactly at the current_stock in the inventory table. Rows are marked "(simulasi)" in reason.
// Run once, after the app has started at least once (it adds the type column): npm run seed:sales
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAYS = 60;
const db = new Database(resolve(dirname(fileURLToPath(import.meta.url)), "../inventory.db"));

const already = db.prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason LIKE '%(simulasi)'`).get() as { n: number };

if (already.n > 0) {
    console.log(`Simulated history already exists (${already.n} rows). Nothing changed.`);
    process.exit(0);
}

// Small deterministic random generator, so every run produces the same history.
let seed = 20261112;
const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};

type Product = { sku: string; item_name: string; current_stock: number; safety_threshold: number; max_stock: number | null; units_per_carton: number | null };
type Row = { sku: string; change: number; before: number; after: number; type: string; reason: string; at: string };

const products = db.prepare(`SELECT sku, item_name, current_stock, safety_threshold, max_stock, units_per_carton FROM inventory`).all() as Product[];
const firstMovement = db.prepare(`SELECT stock_before, created_at FROM stock_movements WHERE sku = ? ORDER BY created_at, id LIMIT 1`);

const pad = (n: number) => String(n).padStart(2, "0");
const sqlTime = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;

const rows: Row[] = [];

for (const product of products) {
    // The simulated history must end where the real history (if any) begins.
    const real = firstMovement.get(product.sku) as { stock_before: number; created_at: string } | undefined;
    let stock = real ? real.stock_before : product.current_stock;
    const end = real ? new Date(real.created_at.replace(" ", "T") + "Z") : new Date();

    // A safety threshold usually covers about one week of sales.
    const dailyRate = Math.max(1, product.safety_threshold / 7);
    const ceiling = product.max_stock ?? product.safety_threshold * 2.5;
    const pack = product.units_per_carton ?? 10;

    // Walk back one day at a time: going back in time, a sale adds stock and a delivery removes it.
    for (let day = 0; day < DAYS; day++) {
        const date = new Date(end);
        date.setUTCDate(date.getUTCDate() - day - 1);
        const weekend = [0, 6].includes(date.getUTCDay());
        const sold = Math.max(0, Math.round(dailyRate * (0.6 + random() * 0.8) * (weekend ? 1.3 : 1)));

        if (sold > 0) {
            date.setUTCHours(13, 0);
            rows.push({ sku: product.sku, change: -sold, before: stock + sold, after: stock, type: "terjual", reason: "terjual (simulasi)", at: sqlTime(date) });
            stock += sold;
        }

        // If stock would be above the ceiling earlier that day, a delivery must have arrived that morning.
        if (stock > ceiling) {
            const target = Math.round(product.safety_threshold * (0.5 + random() * 0.4));
            const delivered = Math.floor((stock - target) / pack) * pack;

            if (delivered > 0 && stock - delivered >= 0) {
                date.setUTCHours(2, 0);
                rows.push({ sku: product.sku, change: delivered, before: stock - delivered, after: stock, type: "barang_datang", reason: "barang datang (simulasi)", at: sqlTime(date) });
                stock -= delivered;
            }
        }
    }
}

const insert = db.prepare(`
    INSERT INTO stock_movements (sku, change_pcs, stock_before, stock_after, type, reason, created_at)
    VALUES (@sku, @change, @before, @after, @type, @reason, @at)
`);

db.transaction(() => {
    for (const row of rows.sort((a, b) => a.at.localeCompare(b.at))) insert.run(row);
})();

console.log(`Added ${rows.length} simulated stock movements for ${products.length} products (${DAYS} days).`);
