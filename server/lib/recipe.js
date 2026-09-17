/**
 * RECETE (BOM) hesaplari.
 *
 * Bir recete `yield_quantity` adet urun uretir ve icindeki hammaddeleri tuketir.
 * Ornek: "1 demlik cay" recetesi 40 bardak uretir, 60 g cay + 4 lt su tuketir.
 *
 * Iki yerde kullanilir:
 *
 * 1. MALIYET — Uretilen urunun birim maliyeti tahmine degil, hammadde
 *    toplamina dayanir. Recete yoksa urunun kendi purchase_price'i kullanilir.
 *
 * 2. SAYIM — Beyan edilen uretim adedinin gerektirdigi hammadde miktari
 *    hesaplanir ve hammaddenin sayim farkindan DUSULUR. Boylece uretimde
 *    tukenen hammadde "satilmis" gibi gorunmez. Geriye kalan fark ya o
 *    hammaddenin dogrudan satisidir ya da aciklanamayan tuketimdir.
 */
import { all, get } from '../db.js';
import { round2, round4 } from './money.js';

/** Bir urunun recetesini satirlariyla birlikte dondurur; yoksa null. */
export function recipeFor(productId) {
  const recipe = get('SELECT * FROM recipes WHERE product_id = ? AND is_active = 1', [productId]);
  if (!recipe) return null;
  const items = all(
    `SELECT ri.*, p.name AS ingredient_name, p.unit AS ingredient_unit,
            p.product_type AS ingredient_type, p.purchase_price AS catalog_purchase_price
       FROM recipe_items ri JOIN products p ON p.id = ri.ingredient_id
      WHERE ri.recipe_id = ? ORDER BY p.name COLLATE NOCASE`,
    [recipe.id]
  );
  return { ...recipe, items };
}

/** Kampus ozel fiyat varsa onu, yoksa katalog fiyatini dondurur. */
function ingredientCost(campusId, ingredientId) {
  const row = get(
    `SELECT COALESCE(cp.purchase_price, p.purchase_price) AS price
       FROM products p
       LEFT JOIN campus_products cp ON cp.product_id = p.id AND cp.campus_id = ?
      WHERE p.id = ?`,
    [campusId, ingredientId]
  );
  return row?.price ?? 0;
}

/**
 * Uretilen urunun 1 adedinin hammadde maliyeti.
 * @returns {{unitCost: number, items: Array, hasRecipe: boolean}}
 */
export function recipeUnitCost(campusId, productId) {
  const recipe = recipeFor(productId);
  if (!recipe || !recipe.items.length) {
    const fallback = get('SELECT purchase_price FROM products WHERE id = ?', [productId]);
    return { unitCost: fallback?.purchase_price ?? 0, items: [], hasRecipe: false, yield: 1 };
  }

  const items = recipe.items.map((item) => {
    const price = ingredientCost(campusId, item.ingredient_id);
    const perUnit = round4(item.quantity / recipe.yield_quantity);
    return {
      ...item,
      unit_price: price,
      per_unit_quantity: perUnit,
      per_unit_cost: round4(perUnit * price),
      batch_cost: round2(item.quantity * price),
    };
  });

  return {
    unitCost: round4(items.reduce((s, i) => s + i.per_unit_cost, 0)),
    batchCost: round2(items.reduce((s, i) => s + i.batch_cost, 0)),
    items,
    hasRecipe: true,
    yield: recipe.yield_quantity,
    recipeId: recipe.id,
  };
}

/**
 * Beyan edilen uretim adetlerine gore hammadde tuketimini hesaplar.
 * @param {number} campusId
 * @param {Array<{product_id: number, quantity: number}>} productionRows
 * @returns {Map<number, number>} hammadde id -> tuketilen miktar
 */
export function recipeConsumption(campusId, productionRows) {
  const consumption = new Map();
  for (const row of productionRows) {
    if (!row.quantity) continue;
    const recipe = recipeFor(row.product_id);
    if (!recipe || !recipe.items.length) continue;
    for (const item of recipe.items) {
      const perUnit = item.quantity / recipe.yield_quantity;
      const used = perUnit * row.quantity;
      consumption.set(item.ingredient_id, round4((consumption.get(item.ingredient_id) || 0) + used));
    }
  }
  return consumption;
}

/** Bir hammaddenin hangi urunlerin recetesinde gectigini dondurur. */
export function recipesUsingIngredient(ingredientId) {
  return all(
    `SELECT r.id AS recipe_id, r.product_id, r.yield_quantity, ri.quantity,
            p.name AS product_name
       FROM recipe_items ri
       JOIN recipes r  ON r.id = ri.recipe_id AND r.is_active = 1
       JOIN products p ON p.id = r.product_id
      WHERE ri.ingredient_id = ?
      ORDER BY p.name COLLATE NOCASE`,
    [ingredientId]
  );
}

/**
 * Receteye dongu girmesini engeller: bir urun dolayli da olsa kendini
 * icerik olarak kullanamaz.
 */
export function assertNoCycle(productId, ingredientIds) {
  const seen = new Set([Number(productId)]);
  const queue = ingredientIds.map(Number);

  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) {
      const name = get('SELECT name FROM products WHERE id = ?', [current])?.name ?? `#${current}`;
      return `Recete dongusu: "${name}" dogrudan veya dolayli olarak kendini icerik olarak kullaniyor.`;
    }
    seen.add(current);
    const sub = recipeFor(current);
    if (sub) queue.push(...sub.items.map((i) => Number(i.ingredient_id)));
  }
  return null;
}
