import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  emptyMealData,
  groceryList,
  makeItem,
  mealTools,
  type MealData
} from "./meal-prep.ts";

function fixture(): MealData {
  const data = emptyMealData();
  const ingredient = {
    id: crypto.randomUUID(),
    name: "milk",
    shelfLifeDays: 14,
    nutrition: null
  };
  data.ingredients.push(ingredient);
  data.items.push(
    makeItem(
      {
        ingredientId: ingredient.id,
        quantity: 500,
        unit: "ml",
        purchasedOn: "2026-11-01",
        expiresOn: null
      },
      ingredient
    )
  );
  data.recipes.push({
    id: crypto.randomUUID(),
    name: "Porridge",
    basePortions: 2,
    instructions: "Cook",
    ingredients: {
      [ingredient.id]: { quantity: 200, unit: "ml", prepNotes: "Add slowly" }
    }
  });
  data.currentPrepPlan.entries.push({
    id: crypto.randomUUID(),
    recipeId: data.recipes[0].id,
    portions: 6,
    status: "planned",
    completedAt: null
  });
  return data;
}
function harness() {
  let data = fixture();
  const tools = mealTools(
    () => structuredClone(data),
    (next) => {
      data = next;
    }
  );
  const run = async (which: keyof typeof tools, input: unknown) => {
    const execute = tools[which].execute as unknown as (
      input: unknown,
      options: unknown
    ) => Promise<unknown>;
    return execute(input, {});
  };
  return { run, read: () => data };
}

test("shelf life comes from ingredient, explicit dates override", () => {
  const data = fixture();
  const ingredient = data.ingredients[0];
  const input = data.items[0];
  assert.equal(input.expiresOn, "2026-11-15");
  assert.equal(
    makeItem({ ...input, expiresOn: "2026-11-10" }, ingredient)
      .expirationSource,
    "explicit"
  );
  assert.equal(
    makeItem(
      { ...input, expiresOn: null },
      { ...ingredient, shelfLifeDays: null }
    ).expiresOn,
    null
  );
  assert.equal(addDays("2028-02-28", 2), "2028-03-01");
});

test("grocery list uses ingredient UUIDs, scales portions, excludes expired stock and flags units", () => {
  const data = fixture();
  const stock = data.items[0];
  data.items.push(
    {
      ...stock,
      id: crypto.randomUUID(),
      quantity: 1000,
      expiresOn: "2026-10-31"
    },
    { ...stock, id: crypto.randomUUID(), quantity: 2, unit: "cartons" }
  );
  const item = groceryList(data, "2026-11-02").items[0];
  assert.equal(item.required, 600);
  assert.equal(item.allocated, 500);
  assert.equal(item.shortage, 100);
  assert.equal(item.ingredientId, data.ingredients[0].id);
  assert.equal(item.unmatchedInventory[0].unit, "cartons");
  assert.equal(data.items[0].quantity, 500);
  data.ingredients[0].name = "Whole milk";
  assert.equal(
    groceryList(data, "2026-11-02").items[0].ingredient,
    "Whole milk"
  );
});

test("inventory is allocated only once across the current prep plan", () => {
  const data = fixture();
  data.currentPrepPlan.entries[0].portions = 4;
  data.currentPrepPlan.entries.push({
    ...data.currentPrepPlan.entries[0],
    id: crypto.randomUUID()
  });
  const item = groceryList(data, "2026-11-02").items[0];
  assert.equal(item.required, 800);
  assert.equal(item.allocated, 500);
  assert.equal(item.shortage, 300);
});

test("cooking deductions aggregate duplicate items, are atomic and idempotent", async () => {
  const { run, read } = harness();
  const id = read().currentPrepPlan.entries[0].id;
  const itemId = read().items[0].id;
  await run("confirmMealCooked", {
    id,
    used: [
      { itemId, quantity: 300 },
      { itemId, quantity: 300 }
    ]
  });
  assert.equal(read().items[0].quantity, 500);
  assert.equal(read().currentPrepPlan.entries[0].status, "planned");
  const before = Date.now();
  await run("confirmMealCooked", { id, used: [{ itemId, quantity: 200 }] });
  const completedAt = read().currentPrepPlan.entries[0].completedAt;
  assert.ok(completedAt && Date.parse(completedAt) >= before);
  await run("confirmMealCooked", { id, used: [{ itemId, quantity: 200 }] });
  assert.equal(read().currentPrepPlan.entries[0].completedAt, completedAt);
  assert.equal(read().items[0].quantity, 300);
  assert.equal(read().currentPrepPlan.entries[0].status, "cooked");
  assert.equal(groceryList(read(), "2026-11-02").items.length, 0);
});

test("renaming ingredients preserves references; changing shelf life leaves old item dates intact", async () => {
  const { run, read } = harness();
  const ingredient = read().ingredients[0];
  await run("saveIngredient", {
    ...ingredient,
    name: "Whole milk",
    shelfLifeDays: 7
  });
  assert.equal(read().items[0].expiresOn, "2026-11-15");
  assert.equal(read().items[0].ingredientId, ingredient.id);
  await run("addInventoryItem", {
    ingredientId: ingredient.id,
    quantity: 1,
    unit: "carton",
    purchasedOn: "2026-11-02",
    expiresOn: null
  });
  assert.equal(read().items[1].expiresOn, "2026-11-09");
  assert.notEqual(read().items[0].id, read().items[1].id);
  await run("saveIngredient", {
    name: " WHOLE MILK ",
    shelfLifeDays: 7
  });
  assert.equal(read().ingredients.length, 1);
});

test("unknown ingredient references fail; recipe edits change plan calculations", async () => {
  const { run, read } = harness();
  const recipe = structuredClone(read().recipes[0]);
  await run("saveRecipe", {
    ...recipe,
    ingredients: {
      [crypto.randomUUID()]: { quantity: 1, unit: "g", prepNotes: "" }
    }
  });
  assert.deepEqual(read().recipes[0], recipe);
  recipe.ingredients[read().ingredients[0].id].quantity = 100;
  await run("saveRecipe", recipe);
  assert.equal(groceryList(read(), "2026-11-02").items[0].required, 300);
});

test("replacing prep plan preserves cooked status and rejects duplicate IDs", async () => {
  const { run, read } = harness();
  const entry = read().currentPrepPlan.entries[0];
  await run("confirmMealCooked", { id: entry.id, used: [] });
  await run("setCurrentPrepPlan", {
    entries: [
      { id: entry.id, recipeId: entry.recipeId, portions: entry.portions }
    ]
  });
  assert.equal(read().currentPrepPlan.entries[0].status, "cooked");
  const result = await run("setCurrentPrepPlan", { entries: [entry, entry] });
  assert.deepEqual(result, { error: "Duplicate prep entry" });
  assert.equal(read().currentPrepPlan.entries.length, 1);
  await run("setCurrentPrepPlan", { entries: [] });
  assert.equal(read().currentPrepPlan.entries.length, 0);
  const quantity = read().items[0].quantity;
  assert.deepEqual(
    await run("confirmMealCooked", {
      id: entry.id,
      used: [{ itemId: read().items[0].id, quantity: 100 }]
    }),
    { error: "Prep entry not found" }
  );
  assert.equal(read().items[0].quantity, quantity);
});

test("nutrition is all-or-none; omitted updates preserve existing nutrition and explicit null clears it", async () => {
  let data = emptyMealData();
  const tools = mealTools(
    () => structuredClone(data),
    (next) => {
      data = next;
    }
  );
  const run = async (input: unknown) => {
    const execute = tools.saveIngredient.execute as unknown as (
      input: unknown,
      options: unknown
    ) => Promise<unknown>;
    return execute(input, {});
  };
  await run({ name: "Milk", shelfLifeDays: 14 });
  assert.equal(data.ingredients[0].nutrition, null);
  const id = data.ingredients[0].id;
  const nutrition = {
    caloriesPerServing: 120,
    servingSize: 240,
    servingUnit: "ml"
  };
  await run({ id, name: "Milk", shelfLifeDays: 14, nutrition });
  assert.deepEqual(data.ingredients[0].nutrition, nutrition);
  for (const partial of [
    { caloriesPerServing: 120 },
    { servingSize: 240, servingUnit: "ml" },
    { caloriesPerServing: 120, servingSize: 240 }
  ]) {
    await assert.rejects(
      run({ id, name: "Milk", shelfLifeDays: 14, nutrition: partial })
    );
    assert.deepEqual(data.ingredients[0].nutrition, nutrition);
  }
  await run({ id, name: "Whole milk", shelfLifeDays: 10 });
  assert.deepEqual(data.ingredients[0].nutrition, nutrition);
  await run({ id, name: "Whole milk", shelfLifeDays: 10, nutrition: null });
  assert.equal(data.ingredients[0].nutrition, null);
});
