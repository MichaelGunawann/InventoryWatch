// Reads package sizes such as "85g", "1,5 L" or "91 kilogram" from a product name, for the 50 kg / 50 L limit.

type Base = "g" | "ml" | "pcs";

export type Size = { text: string; base: Base; amount: number };

// Unit word -> base unit and multiplier.
const UNITS: Record<string, [Base, number]> = {
    mg: ["g", 0.001],
    g: ["g", 1], gr: ["g", 1], gram: ["g", 1], grams: ["g", 1],
    kg: ["g", 1000], kilo: ["g", 1000], kilogram: ["g", 1000], kilograms: ["g", 1000],
    ml: ["ml", 1], cc: ["ml", 1],
    l: ["ml", 1000], lt: ["ml", 1000], ltr: ["ml", 1000], liter: ["ml", 1000], litre: ["ml", 1000],
    pcs: ["pcs", 1], pc: ["pcs", 1], sachet: ["pcs", 1], lembar: ["pcs", 1], sheet: ["pcs", 1],
    sheets: ["pcs", 1], butir: ["pcs", 1], biji: ["pcs", 1], tablet: ["pcs", 1],
};

// Largest size that makes sense for one supermarket item: 50 kg, 50 L, 1000 pieces.
const MAX_AMOUNT: Record<Base, number> = { g: 50_000, ml: 50_000, pcs: 1000 };

export function parseSizes(text: string): Size[] {
    const sizes: Size[] = [];

    for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-z]+)\b/gi)) {
        const unit = UNITS[match[2].toLowerCase()];

        if (unit) {
            const value = Number(match[1].replace(",", "."));
            sizes.push({ text: match[0], base: unit[0], amount: value * unit[1] });
        }
    }

    return sizes;
}

// Business rule, not language understanding: one item cannot weigh more than 50 kg / 50 L.
// Whether a name needs a size, or a size suits the product type, is left to Gemini.
// Returns a rejection reason, or null when every size in the name is realistic.
export function checkProductSize(itemName: string): string | null {
    for (const size of parseSizes(itemName)) {
        if (!(size.amount > 0) || size.amount > MAX_AMOUNT[size.base]) {
            return `size "${size.text}" is not realistic for one supermarket item (maximum 50 kg, 50 L, or 1000 pieces). Ask the user to double-check the size.`;
        }
    }

    return null;
}
