import {
  cleanPrepPlan,
  emptyMealData,
  ingredientKey,
  nutritionSchema,
  type MealData
} from "./meal-prep.ts";

type Value = string | number | null;
type Row = Record<string, Value>;
export interface MealDatabase {
  query(sql: string, ...values: Value[]): Row[];
  transaction<T>(callback: () => T): T;
}
export class MealStore {
  private ready = false;
  private db: MealDatabase;
  private now: () => number;
  constructor(db: MealDatabase, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  private initialize() {
    if (this.ready) return;
    this.db.transaction(() => {
      const q = this.db.query.bind(this.db);
      q(
        `CREATE TABLE IF NOT EXISTS ingredients (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, shelf_life_days INTEGER CHECK(shelf_life_days > 0),
          nutrition TEXT CHECK(nutrition IS NULL OR (
            json_valid(nutrition) AND json_type(nutrition) = 'object'
            AND json_type(nutrition, '$.caloriesPerServing') IN ('integer', 'real')
            AND json_extract(nutrition, '$.caloriesPerServing') >= 0
            AND json_type(nutrition, '$.servingSize') IN ('integer', 'real')
            AND json_extract(nutrition, '$.servingSize') > 0
            AND json_type(nutrition, '$.servingUnit') = 'text'
            AND length(trim(json_extract(nutrition, '$.servingUnit'))) > 0
          ) IS 1))`
      );
      q(
        `CREATE TABLE IF NOT EXISTS inventory_items (id TEXT PRIMARY KEY, ingredient_id TEXT NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL CHECK(quantity >= 0), unit TEXT NOT NULL, purchased_on TEXT NOT NULL, expires_on TEXT, expiration_source TEXT NOT NULL CHECK(expiration_source IN ('explicit','estimated','unknown')))`
      );
      q(
        `CREATE INDEX IF NOT EXISTS inventory_ingredient_expiry ON inventory_items(ingredient_id, expires_on)`
      );
      q(
        `CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_portions REAL NOT NULL CHECK(base_portions > 0), instructions TEXT NOT NULL, ingredients TEXT NOT NULL CHECK(json_valid(ingredients)))`
      );
      q(
        `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)))`
      );
    });
    this.ready = true;
  }
  read(): MealData {
    this.initialize();
    const q = this.db.query.bind(this.db);
    const data = emptyMealData();
    data.ingredients = q("SELECT * FROM ingredients ORDER BY rowid").map(
      (r) => ({
        id: String(r.id),
        name: String(r.name),
        shelfLifeDays: r.shelf_life_days as number | null,
        nutrition:
          r.nutrition === null
            ? null
            : nutritionSchema.parse(JSON.parse(String(r.nutrition)))
      })
    );
    data.items = q("SELECT * FROM inventory_items ORDER BY rowid").map((r) => ({
      id: String(r.id),
      ingredientId: String(r.ingredient_id),
      quantity: Number(r.quantity),
      unit: String(r.unit),
      purchasedOn: String(r.purchased_on),
      expiresOn: r.expires_on as string | null,
      expirationSource:
        r.expiration_source as MealData["items"][number]["expirationSource"]
    }));
    data.recipes = q("SELECT * FROM recipes ORDER BY rowid").map((r) => ({
      id: String(r.id),
      name: String(r.name),
      basePortions: Number(r.base_portions),
      instructions: String(r.instructions),
      ingredients: JSON.parse(String(r.ingredients))
    }));
    const settings = q(
      "SELECT value FROM app_settings WHERE key='current_prep_plan'"
    );
    if (settings.length)
      data.currentPrepPlan = JSON.parse(String(settings[0].value));
    const cleaned = cleanPrepPlan(data.currentPrepPlan, this.now());
    if (cleaned.entries.length !== data.currentPrepPlan.entries.length) {
      q(
        "UPDATE app_settings SET value=? WHERE key='current_prep_plan'",
        JSON.stringify(cleaned)
      );
      data.currentPrepPlan = cleaned;
    }
    return data;
  }
  write(data: MealData) {
    this.initialize();
    this.db.transaction(() =>
      this.persist({
        ...data,
        currentPrepPlan: cleanPrepPlan(data.currentPrepPlan, this.now())
      })
    );
  }
  private persist(data: MealData) {
    const q = this.db.query.bind(this.db);
    const ids = new Set(data.ingredients.map((i) => i.id));
    for (const item of data.items)
      if (!ids.has(item.ingredientId))
        throw new Error("Unknown inventory ingredient UUID");
    for (const r of data.recipes)
      for (const ingredientId of Object.keys(r.ingredients))
        if (!ids.has(ingredientId))
          throw new Error("Unknown recipe ingredient UUID");
    for (const entry of data.currentPrepPlan.entries)
      if (!data.recipes.some((r) => r.id === entry.recipeId))
        throw new Error("Unknown prep plan recipe UUID");
    for (const i of data.ingredients)
      q(
        `INSERT INTO ingredients (id, name, name_key, shelf_life_days, nutrition) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, name_key=excluded.name_key, shelf_life_days=excluded.shelf_life_days, nutrition=excluded.nutrition`,
        i.id,
        i.name,
        ingredientKey(i.name),
        i.shelfLifeDays,
        i.nutrition === null
          ? null
          : JSON.stringify(nutritionSchema.parse(i.nutrition))
      );
    for (const i of data.items)
      q(
        `INSERT INTO inventory_items (id, ingredient_id, quantity, unit, purchased_on, expires_on, expiration_source) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ingredient_id=excluded.ingredient_id, quantity=excluded.quantity, unit=excluded.unit, purchased_on=excluded.purchased_on, expires_on=excluded.expires_on, expiration_source=excluded.expiration_source`,
        i.id,
        i.ingredientId,
        i.quantity,
        i.unit,
        i.purchasedOn,
        i.expiresOn,
        i.expirationSource
      );
    for (const r of data.recipes)
      q(
        `INSERT INTO recipes VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_portions=excluded.base_portions, instructions=excluded.instructions, ingredients=excluded.ingredients`,
        r.id,
        r.name,
        r.basePortions,
        r.instructions,
        JSON.stringify(r.ingredients)
      );
    q(
      `INSERT INTO app_settings VALUES ('current_prep_plan', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      JSON.stringify(data.currentPrepPlan)
    );
    for (const [table, keep] of [
      ["inventory_items", new Set(data.items.map((i) => i.id))],
      ["recipes", new Set(data.recipes.map((r) => r.id))],
      ["ingredients", ids]
    ] as const) {
      for (const row of q(`SELECT id FROM ${table}`))
        if (!keep.has(String(row.id)))
          q(`DELETE FROM ${table} WHERE id=?`, row.id);
    }
  }
}
