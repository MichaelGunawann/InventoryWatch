// Order quantity rules, shared by the MCP server (src/index.ts) and the GUI server (src/web.ts).

export type StockLevels = {
    current_stock: number;
    max_stock: number | null;
    units_per_carton: number | null;
};

// Suggested order: refill up to max_stock, rounded UP to whole cartons when the carton size is known.
export function orderPlan(product: StockLevels) {
    if (product.max_stock === null) {
        return null;
    }

    const needed = Math.max(product.max_stock - product.current_stock, 0);
    const cartons = product.units_per_carton ? Math.ceil(needed / product.units_per_carton) : null;
    const orderPcs = cartons !== null ? cartons * product.units_per_carton! : needed;
    const stockAfter = product.current_stock + orderPcs;

    return { needed, cartons, orderPcs, stockAfter, overMax: stockAfter - product.max_stock };
}

export function describeOrder(product: StockLevels) {
    const plan = orderPlan(product);

    if (!plan) {
        return "Suggested order: unknown (max_stock is not set)";
    }

    const quantity = plan.cartons !== null
        ? `${plan.cartons} carton(s) x ${product.units_per_carton} = ${plan.orderPcs} pcs`
        : `${plan.orderPcs} pcs (carton size not set)`;
    const overMax = plan.overMax > 0
        ? ` (${plan.overMax} pcs above max_stock because of rounding up to whole cartons)`
        : "";

    return `Suggested order: ${quantity}, stock after order ${plan.stockAfter} / max ${product.max_stock}${overMax}`;
}
