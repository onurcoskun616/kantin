/**
 * RECETE yonetimi.
 *
 * Yalnizca URETILEN tipindeki urunler icin recete tanimlanir. Icerikler
 * SATIN_ALINAN veya HAMMADDE tipinde olmalidir; bir uretilen urun baska bir
 * uretilen urunun icerigi olamaz (dongu ve maliyet zinciri karmasasi).
 */
import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, badRequest, conflict } from '../lib/http.js';
import { requireWrite, assertCampusAccess } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, arr } from '../lib/validate.js';
import { productProfit, round2, round4 } from '../lib/money.js';
import { recipeUnitCost, recipesUsingIngredient, assertNoCycle } from '../lib/recipe.js';

export const recipeRoutes = new Router();

/* ------------------------- Recete listesi -------------------------- */
recipeRoutes.get('/', async (ctx) => {
  const campusId = ctx.query.campusId
    ? assertCampusAccess(ctx.user, ctx.query.campusId)
    : (ctx.user.campusId || get('SELECT id FROM campuses ORDER BY id LIMIT 1')?.id);

  const produced = all(
    `SELECT p.*, c.name AS category_name,
            r.id AS recipe_id, r.yield_quantity, r.note AS recipe_note,
            (SELECT COUNT(*) FROM recipe_items ri WHERE ri.recipe_id = r.id) AS item_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN recipes r    ON r.product_id = p.id AND r.is_active = 1
      WHERE p.is_active = 1 AND p.product_type = 'URETILEN'
      ORDER BY p.name COLLATE NOCASE`
  );

  const items = produced.map((p) => {
    const cost = recipeUnitCost(campusId, p.id);
    const profit = productProfit(cost.unitCost, p.sale_price, p.vat_rate);
    return {
      ...p,
      has_recipe: cost.hasRecipe,
      unit_cost: round2(cost.unitCost),
      estimated_cost: p.purchase_price,
      profit,
      // Recete maliyeti ile elle girilen tahmin arasindaki sapma
      cost_gap: cost.hasRecipe ? round2(cost.unitCost - p.purchase_price) : null,
    };
  });

  return {
    campusId,
    items,
    withoutRecipe: items.filter((i) => !i.has_recipe).length,
  };
});

/* --------------------- Tek urunun recetesi ------------------------- */
recipeRoutes.get('/:productId', async (ctx) => {
  const productId = Number(ctx.params.productId);
  const product = get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw notFound('Urun bulunamadi.');
  const campusId = ctx.query.campusId
    ? assertCampusAccess(ctx.user, ctx.query.campusId)
    : (ctx.user.campusId || get('SELECT id FROM campuses ORDER BY id LIMIT 1')?.id);

  const cost = recipeUnitCost(campusId, productId);
  const profit = productProfit(cost.unitCost, product.sale_price, product.vat_rate);

  // Recete icerigi olabilecek urunler
  const candidates = all(
    `SELECT id, name, unit, barcode, product_type, purchase_price
       FROM products
      WHERE is_active = 1 AND product_type IN ('SATIN_ALINAN','HAMMADDE')
      ORDER BY product_type DESC, name COLLATE NOCASE`
  );

  return {
    product,
    hasRecipe: cost.hasRecipe,
    yieldQuantity: cost.yield ?? 1,
    note: cost.hasRecipe ? get('SELECT note FROM recipes WHERE id = ?', [cost.recipeId])?.note : null,
    items: cost.items,
    unitCost: round2(cost.unitCost),
    batchCost: cost.batchCost ?? 0,
    profit,
    candidates,
  };
});

/* ------------------------ Recete kaydetme -------------------------- */
recipeRoutes.put('/:productId', async (ctx) => {
  requireWrite(ctx.user);
  const productId = Number(ctx.params.productId);
  const product = get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw notFound('Urun bulunamadi.');
  if (product.product_type !== 'URETILEN') {
    throw badRequest('Recete yalnizca "uretilen" tipindeki urunler icin tanimlanir.');
  }

  const yieldQuantity = num(ctx.body.yieldQuantity, 'Uretilen adet', { required: true, min: 0.001 });
  const note = str(ctx.body.note, 'Aciklama', { max: 500 });
  const lines = arr(ctx.body.items, 'Icerikler', { required: true, min: 1 });

  const prepared = lines.map((raw, i) => {
    const ingredientId = int(raw.ingredientId, `Satir ${i + 1} icerik`, { required: true });
    const ingredient = get('SELECT * FROM products WHERE id = ?', [ingredientId]);
    if (!ingredient) throw badRequest(`Satir ${i + 1}: icerik bulunamadi.`);
    if (ingredient.id === productId) throw badRequest('Bir urun kendi recetesinin icerigi olamaz.');
    if (ingredient.product_type === 'URETILEN') {
      throw badRequest(`Satir ${i + 1}: "${ingredient.name}" uretilen bir urun; recete icerigi olamaz.`);
    }
    const quantity = num(raw.quantity, `Satir ${i + 1} miktar`, { required: true, min: 0.0001 });
    return { ingredientId, quantity, note: str(raw.note, 'Not', { max: 200 }) };
  });

  const ids = prepared.map((l) => l.ingredientId);
  if (new Set(ids).size !== ids.length) throw badRequest('Ayni icerik birden fazla satirda olamaz.');
  const cycle = assertNoCycle(productId, ids);
  if (cycle) throw badRequest(cycle);

  tx(() => {
    let recipe = get('SELECT * FROM recipes WHERE product_id = ?', [productId]);
    if (recipe) {
      run("UPDATE recipes SET yield_quantity = ?, note = ?, is_active = 1, updated_at = datetime('now') WHERE id = ?",
        [yieldQuantity, note, recipe.id]);
      run('DELETE FROM recipe_items WHERE recipe_id = ?', [recipe.id]);
    } else {
      const id = insert('INSERT INTO recipes (product_id, yield_quantity, note, created_by) VALUES (?, ?, ?, ?)',
        [productId, yieldQuantity, note, ctx.user.id]);
      recipe = { id };
    }
    for (const l of prepared) {
      insert('INSERT INTO recipe_items (recipe_id, ingredient_id, quantity, note) VALUES (?, ?, ?, ?)',
        [recipe.id, l.ingredientId, l.quantity, l.note]);
    }
  });

  logAudit({
    user: ctx.user, action: 'UPDATE', entity: 'recipes', entityId: productId,
    detail: { product: product.name, yieldQuantity, itemCount: prepared.length }, ip: ctx.ip,
  });

  const campusId = ctx.user.campusId || get('SELECT id FROM campuses ORDER BY id LIMIT 1')?.id;
  const cost = recipeUnitCost(campusId, productId);
  return {
    ok: true,
    unitCost: round2(cost.unitCost),
    batchCost: cost.batchCost,
    profit: productProfit(cost.unitCost, product.sale_price, product.vat_rate),
  };
});

/* -------------------------- Recete silme --------------------------- */
recipeRoutes.delete('/:productId', async (ctx) => {
  requireWrite(ctx.user);
  const productId = Number(ctx.params.productId);
  const recipe = get('SELECT * FROM recipes WHERE product_id = ?', [productId]);
  if (!recipe) throw notFound('Recete bulunamadi.');

  // Kesinlesmis bir sayimda kullanildiysa silinmez: gecmis mutabakat bozulur
  const used = get(
    `SELECT c.id, c.count_date FROM production_sales ps
       JOIN counts c ON c.id = ps.count_id
      WHERE ps.product_id = ? AND c.status = 'KESINLESMIS' AND ps.quantity > 0
      ORDER BY c.count_date DESC LIMIT 1`,
    [productId]
  );
  if (used) {
    throw conflict(
      `Bu recete ${used.count_date} tarihli kesinlesmis sayimda kullanildi. Silmek yerine icerigini guncelleyin; `
      + 'gecmis sayimlar kendi anindaki maliyetle donmus durumdadir.'
    );
  }

  run('DELETE FROM recipes WHERE id = ?', [recipe.id]);
  logAudit({ user: ctx.user, action: 'DELETE', entity: 'recipes', entityId: productId, ip: ctx.ip });
  return { ok: true };
});

/* ------------- Bir hammaddeyi kullanan receteler ------------------- */
recipeRoutes.get('/:productId/used-in', async (ctx) => {
  const productId = Number(ctx.params.productId);
  return { items: recipesUsingIngredient(productId) };
});
