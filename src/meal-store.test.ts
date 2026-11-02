import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MealStore, type MealDatabase } from "./meal-store.ts";
import { emptyMealData, makeItem } from "./meal-prep.ts";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db: MealDatabase = {
    query(sql, ...values) {
      return sqlite.prepare(sql).all(...values) as ReturnType<
        MealDatabase["query"]
      >;
    },
    transaction(callback) {
      sqlite.exec("BEGIN");
      try {
        const result = callback();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
  return { sqlite, db };
}
function fixture() {
  const data = emptyMealData();
  const milk = {
    id: crypto.randomUUID(),
    name: "Milk",
    shelfLifeDays: 14,
    nutrition: null
  };
  data.ingredients.push(milk);
  data.items.push(
    makeItem(
      {
        ingredientId: milk.id,
        quantity: 1,
        unit: "carton",
        purchasedOn: "2026-11-01",
        expiresOn: null
      },
      milk
    )
  );
  data.recipes.push({
    id: crypto.randomUUID(),
    name: "Porridge",
    basePortions: 2,
    instructions: "Cook",
    ingredients: { [milk.id]: { quantity: 1, unit: "cup", prepNotes: "Warm" } }
  });
  data.currentPrepPlan.entries.push({
    id: crypto.randomUUID(),
    recipeId: data.recipes[0].id,
    portions: 4,
    status: "planned",
    completedAt: null
  });
  return data;
}
test("simplified schema round-trips UUID references, JSON recipes and one prep setting", () => {
  const { sqlite, db } = database();
  const store = new MealStore(db);
  const data = fixture();
  store.write(data);
  assert.deepEqual(new MealStore(db).read(), data);
  assert.equal(db.query("SELECT * FROM ingredients").length, 1);
  assert.equal(
    db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ingredient_aliases','ingredient_storage_rules','recipe_ingredients','meal_plans')"
    ).length,
    0
  );
  const json = JSON.parse(
    String(db.query("SELECT ingredients FROM recipes")[0].ingredients)
  );
  assert.equal(json[data.ingredients[0].id].prepNotes, "Warm");
  data.ingredients[0].name = "Whole milk";
  store.write(data);
  assert.deepEqual(store.read(), data);
  data.currentPrepPlan.entries = [];
  data.items = [];
  data.recipes = [];
  data.ingredients = [];
  store.write(data);
  assert.deepEqual(store.read(), data);
  sqlite.close();
});
test("bad references and constraint failures roll back changes atomically", () => {
  const { sqlite, db } = database();
  const store = new MealStore(db);
  const data = fixture();
  store.write(data);
  const invalid = structuredClone(data);
  invalid.ingredients[0].shelfLifeDays = 30;
  invalid.items[0].quantity = -1;
  assert.throws(() => store.write(invalid));
  assert.deepEqual(store.read(), data);
  const broken = structuredClone(data);
  broken.recipes[0].ingredients[crypto.randomUUID()] = {
    quantity: 1,
    unit: "g",
    prepNotes: ""
  };
  assert.throws(() => store.write(broken), /Unknown recipe ingredient/);
  assert.deepEqual(store.read(), data);
  sqlite.close();
});

test("complete nutrition and null round-trip; SQLite rejects incomplete or invalid nutrition", () => {
  const { sqlite, db } = database();
  const store = new MealStore(db);
  const data = fixture();
  data.ingredients[0].nutrition = {
    caloriesPerServing: 120,
    servingSize: 240,
    servingUnit: "ml"
  };
  store.write(data);
  assert.deepEqual(new MealStore(db).read(), data);
  const id = data.ingredients[0].id;
  const invalid = [
    {},
    { caloriesPerServing: 120 },
    { servingSize: 240, servingUnit: "ml" },
    { caloriesPerServing: 120, servingSize: 240 },
    { caloriesPerServing: -1, servingSize: 240, servingUnit: "ml" },
    { caloriesPerServing: 120, servingSize: 0, servingUnit: "ml" },
    { caloriesPerServing: 120, servingSize: 240, servingUnit: " " },
    { caloriesPerServing: "120", servingSize: 240, servingUnit: "ml" },
    { caloriesPerServing: null, servingSize: 240, servingUnit: "ml" },
    [],
    "invalid"
  ];
  for (const nutrition of invalid) {
    assert.throws(() =>
      db.query(
        "UPDATE ingredients SET nutrition=? WHERE id=?",
        JSON.stringify(nutrition),
        id
      )
    );
    assert.deepEqual(store.read(), data);
  }
  data.ingredients[0].nutrition = {
    caloriesPerServing: 0,
    servingSize: 1,
    servingUnit: "g"
  };
  store.write(data);
  assert.deepEqual(store.read(), data);
  data.ingredients[0].nutrition = null;
  store.write(data);
  assert.deepEqual(store.read(), data);
  sqlite.close();
});

test("reads remove only cooked entries older than 28 days and persist cleanup", () => {
  const { sqlite, db } = database();
  let now = Date.parse("2026-12-01T12:00:00Z");
  const store = new MealStore(db, () => now);
  const data = fixture();
  const planned = data.currentPrepPlan.entries[0];
  const atBoundary = {
    ...planned,
    id: crypto.randomUUID(),
    status: "cooked" as const,
    completedAt: "2026-11-03T12:00:00Z"
  };
  const recent = {
    ...atBoundary,
    id: crypto.randomUUID(),
    completedAt: "2026-11-20T12:00:00Z"
  };
  data.currentPrepPlan.entries.push(atBoundary, recent);
  store.write(data);
  assert.deepEqual(store.read(), data, "exactly 28 days old is retained");
  now += 1;
  const result = store.read();
  assert.deepEqual(
    result.currentPrepPlan.entries.map((e) => e.id),
    [planned.id, recent.id]
  );
  assert.deepEqual(result.items, data.items);
  const saved = JSON.parse(
    String(
      db.query(
        "SELECT value FROM app_settings WHERE key='current_prep_plan'"
      )[0].value
    )
  );
  assert.deepEqual(
    saved,
    result.currentPrepPlan,
    "cleanup is persisted, not just hidden"
  );
  assert.deepEqual(new MealStore(db, () => now).read(), result);
  sqlite.close();
});

test("writes prune old cooked entries while retaining all planned entries", () => {
  const { sqlite, db } = database();
  const data = fixture();
  data.currentPrepPlan.entries.push({
    ...data.currentPrepPlan.entries[0],
    id: crypto.randomUUID(),
    status: "cooked",
    completedAt: "2026-01-01T00:00:00Z"
  });
  const store = new MealStore(db, () => Date.parse("2026-12-01T00:00:00Z"));
  store.write(data);
  assert.equal(store.read().currentPrepPlan.entries.length, 1);
  assert.equal(store.read().currentPrepPlan.entries[0].status, "planned");
  assert.equal(
    data.currentPrepPlan.entries.length,
    2,
    "write does not mutate caller state"
  );
  sqlite.close();
});
