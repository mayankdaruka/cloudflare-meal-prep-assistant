import { tool } from "ai";
import { z } from "zod";

const name = z.string().trim().min(1);
const id = z.uuid();
const amount = z.number().positive().finite();
const date = z.iso.date();
const days = z.number().int().positive().nullable();
export const nutritionSchema = z.strictObject({
  caloriesPerServing: z.number().nonnegative().finite(),
  servingSize: amount,
  servingUnit: name
});
const measurement = z.object({
  quantity: amount,
  unit: name,
  prepNotes: z.string()
});
const recipeSchema = z.object({
  name,
  basePortions: amount,
  instructions: z.string(),
  ingredients: z
    .record(id, measurement)
    .refine(
      (entries) => Object.keys(entries).length > 0,
      "A recipe needs ingredients"
    )
});
// Each ingredient represents a type of food item, it includes metadata like the item's shelf life, nutritional facts
export type Ingredient = {
  id: string;
  name: string;
  shelfLifeDays: number | null;
  nutrition: z.infer<typeof nutritionSchema> | null;
};
// An inventory item is linked directly to an ingredient, the reason they are separate is because we could have 2
// different items of the same type, purchased on different dates and with different expiration dates
export type InventoryItem = {
  id: string;
  ingredientId: string;
  quantity: number;
  unit: string;
  purchasedOn: string;
  expiresOn: string | null;
  expirationSource: "explicit" | "estimated" | "unknown";
};
export type Recipe = z.infer<typeof recipeSchema> & { id: string };
export type PrepEntry = {
  id: string;
  recipeId: string;
  portions: number;
  status: "planned" | "cooked";
  completedAt: string | null;
};
export type MealData = {
  ingredients: Ingredient[];
  items: InventoryItem[];
  recipes: Recipe[];
  currentPrepPlan: { entries: PrepEntry[] };
};
export const emptyMealData = (): MealData => ({
  ingredients: [],
  items: [],
  recipes: [],
  currentPrepPlan: { entries: [] }
});
// Retention is measured from actual completion, never planning or purchase dates.
export function cleanPrepPlan(
  plan: MealData["currentPrepPlan"],
  now = Date.now()
) {
  const cutoff = now - 28 * 24 * 60 * 60 * 1000;
  return {
    entries: plan.entries.filter(
      (entry) =>
        !(
          entry.status === "cooked" &&
          entry.completedAt !== null &&
          Date.parse(entry.completedAt) < cutoff
        )
    )
  };
}
export const ingredientKey = (value: string) => value.trim().toLowerCase();
const round = (value: number) => Number(value.toFixed(6));
export function addDays(day: string, count: number) {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function makeItem(
  input: Omit<InventoryItem, "id" | "expirationSource">,
  ingredient: Ingredient
): InventoryItem {
  if (input.ingredientId !== ingredient.id)
    throw new Error("Ingredient does not match inventory item");
  const expiresOn =
    input.expiresOn ??
    (ingredient.shelfLifeDays
      ? addDays(input.purchasedOn, ingredient.shelfLifeDays)
      : null);
  return {
    ...input,
    id: crypto.randomUUID(),
    expiresOn,
    expirationSource:
      input.expiresOn && expiresOn === input.expiresOn
        ? "explicit"
        : expiresOn
          ? "estimated"
          : "unknown"
  };
}
export function scaledLines(recipe: Recipe, portions: number) {
  return Object.entries(recipe.ingredients).map(([ingredientId, line]) => ({
    ingredientId,
    ...line,
    quantity: round((line.quantity * portions) / recipe.basePortions)
  }));
}
export function groceryList(data: MealData, neededOn: string) {
  const stock = data.items.map((item) => ({ ...item }));
  const items: {
    ingredientId: string;
    ingredient: string;
    unit: string;
    required: number;
    allocated: number;
    shortage: number;
    unmatchedInventory: InventoryItem[];
  }[] = [];
  for (const entry of data.currentPrepPlan.entries.filter(
    (e) => e.status === "planned"
  )) {
    const recipe = data.recipes.find((r) => r.id === entry.recipeId);
    if (!recipe) throw new Error(`Missing recipe ${entry.recipeId}`);
    for (const line of scaledLines(recipe, entry.portions)) {
      let remaining = line.quantity;
      for (const item of stock
        .filter(
          (i) =>
            i.ingredientId === line.ingredientId &&
            ingredientKey(i.unit) === ingredientKey(line.unit) &&
            (!i.expiresOn || i.expiresOn >= neededOn)
        )
        .sort((a, b) =>
          (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999")
        )) {
        const used = Math.min(item.quantity, remaining);
        item.quantity = round(item.quantity - used);
        remaining = round(remaining - used);
      }
      let item = items.find(
        (i) =>
          i.ingredientId === line.ingredientId &&
          ingredientKey(i.unit) === ingredientKey(line.unit)
      );
      if (!item) {
        item = {
          ingredientId: line.ingredientId,
          ingredient: data.ingredients.find((i) => i.id === line.ingredientId)!
            .name,
          unit: line.unit,
          required: 0,
          allocated: 0,
          shortage: 0,
          unmatchedInventory: data.items.filter(
            (i) =>
              i.ingredientId === line.ingredientId &&
              ingredientKey(i.unit) !== ingredientKey(line.unit) &&
              i.quantity > 0 &&
              (!i.expiresOn || i.expiresOn >= neededOn)
          )
        };
        items.push(item);
      }
      item.required = round(item.required + line.quantity);
      item.allocated = round(item.allocated + line.quantity - remaining);
      item.shortage = round(item.shortage + remaining);
    }
  }
  return {
    neededOn,
    items,
    note: "Current prep plan only. Original units; different units are not converted. Excludes stock expiring before neededOn. Unknown expiration dates are treated as usable; verify freshness."
  };
}

export function mealTools(
  read: () => MealData,
  write: (data: MealData) => void
) {
  return {
    getMealPrepData: tool({
      description:
        "Read saved ingredients (UUIDs and shelf lives), inventory items, recipes and the current prep plan. Always read before modifying state or resolving ingredient names. No aliases or storage locations.",
      inputSchema: z.object({}),
      execute: async () => read()
    }),
    saveIngredient: tool({
      description:
        "Create an ingredient or update by its returned UUID. First read existing ingredients and reuse the closest equivalent; ask if ambiguous, never force a different food to match. Names are unique ignoring case and surrounding spaces. Save user-provided shelf life here, never invent it. Null means unknown. Updates affect future purchases only. Omit id to create; no aliases or storage locations. Nutrition is optional but must include caloriesPerServing (kcal), servingSize and servingUnit together. Never guess missing nutrition. If incomplete, omit nutrition, save the ingredient and ask for missing details. Omit nutrition to preserve existing values; use null only when the user explicitly clears it.",
      inputSchema: z.object({
        id: id.optional(),
        name,
        shelfLifeDays: days,
        nutrition: nutritionSchema.nullable().optional()
      }),
      execute: async (input) => {
        const data = read();
        const existing = input.id
          ? data.ingredients.find((i) => i.id === input.id)
          : data.ingredients.find(
              (i) => ingredientKey(i.name) === ingredientKey(input.name)
            );
        if (input.id && !existing) return { error: "Ingredient not found" };
        if (
          data.ingredients.some(
            (i) =>
              i.id !== existing?.id &&
              ingredientKey(i.name) === ingredientKey(input.name)
          )
        )
          return { error: "An ingredient with this name already exists" };
        const ingredient = {
          ...input,
          nutrition:
            input.nutrition === undefined
              ? (existing?.nutrition ?? null)
              : nutritionSchema.nullable().parse(input.nutrition),
          id: existing?.id ?? crypto.randomUUID()
        };
        data.ingredients = data.ingredients.filter(
          (i) => i.id !== ingredient.id
        );
        data.ingredients.push(ingredient);
        write(data);
        return ingredient;
      }
    }),
    addInventoryItem: tool({
      description:
        "Record a purchase as a separate inventory item referencing a saved ingredient UUID. Preserve original quantity/unit. Null expiration uses that ingredient's shelf life. Do not request storage location.",
      inputSchema: z.object({
        ingredientId: id,
        quantity: amount,
        unit: name,
        purchasedOn: date,
        expiresOn: date.nullable()
      }),
      execute: async (input) => {
        const data = read();
        const ingredient = data.ingredients.find(
          (i) => i.id === input.ingredientId
        );
        if (!ingredient)
          return { error: "Ingredient not found; save it first" };
        const item = makeItem(input, ingredient);
        data.items.push(item);
        write(data);
        return item;
      }
    }),
    updateInventoryItem: tool({
      description:
        "Correct remaining quantity (0 discards) or set expiration. Original unit is unchanged.",
      inputSchema: z.object({
        id,
        quantity: z.number().nonnegative().finite().optional(),
        expiresOn: date.nullable().optional()
      }),
      execute: async ({ id, quantity, expiresOn }) => {
        const data = read();
        const item = data.items.find((i) => i.id === id);
        if (!item) return { error: "Item not found" };
        if (quantity !== undefined) item.quantity = quantity;
        if (expiresOn !== undefined) {
          item.expiresOn = expiresOn;
          item.expirationSource = expiresOn ? "explicit" : "unknown";
        }
        write(data);
        return item;
      }
    }),
    saveRecipe: tool({
      description:
        "Save a recipe with basePortions and a JSON mapping from existing ingredient UUIDs to quantity, original unit, prepNotes. No guessed quantities. Omit id to create. Editing a recipe changes its quantities in the current prep plan immediately.",
      inputSchema: recipeSchema.extend({ id: id.optional() }),
      execute: async (input) => {
        const data = read();
        if (input.id && !data.recipes.some((r) => r.id === input.id))
          return { error: "Recipe not found" };
        for (const ingredientId of Object.keys(input.ingredients))
          if (!data.ingredients.some((i) => i.id === ingredientId))
            return { error: "Unknown ingredient UUID", ingredientId };
        const recipe = { ...input, id: input.id ?? crypto.randomUUID() };
        data.recipes = data.recipes.filter((r) => r.id !== recipe.id);
        data.recipes.push(recipe);
        write(data);
        return recipe;
      }
    }),
    setCurrentPrepPlan: tool({
      description:
        "Replace the single current prep plan with recipes and desired portions. No calendar or meal-plans table. Read and preserve wanted entries first. Omit entry id to add a new cooking session. Preserve IDs for existing sessions, including cooked entries, to avoid duplicate deductions. Planning never consumes inventory.",
      inputSchema: z.object({
        entries: z.array(
          z.object({ id: id.optional(), recipeId: id, portions: amount })
        )
      }),
      execute: async ({ entries }) => {
        const data = read();
        const seen = new Set<string>();
        const next: PrepEntry[] = [];
        for (const e of entries) {
          if (!data.recipes.some((r) => r.id === e.recipeId))
            return { error: "Recipe not found", recipeId: e.recipeId };
          const old = e.id
            ? data.currentPrepPlan.entries.find((p) => p.id === e.id)
            : undefined;
          if (e.id && !old) return { error: "Prep entry not found" };
          if (e.id && seen.has(e.id)) return { error: "Duplicate prep entry" };
          if (e.id) seen.add(e.id);
          if (
            old?.status === "cooked" &&
            (old.recipeId !== e.recipeId || old.portions !== e.portions)
          )
            return { error: "Cannot change a cooked entry; create a new one" };
          next.push({
            ...e,
            id: old?.id ?? crypto.randomUUID(),
            status: old?.status ?? "planned",
            completedAt: old?.completedAt ?? null
          });
        }
        data.currentPrepPlan.entries = next;
        write(data);
        return data.currentPrepPlan;
      }
    }),
    getGroceryList: tool({
      description:
        "Calculate shortages for the current prep plan, using ingredient UUIDs and exact units. neededOn is the date ingredients will be used, or today for an undated plan. Explain unmatched units; do not convert them.",
      inputSchema: z.object({ neededOn: date }),
      execute: async ({ neededOn }) => groceryList(read(), neededOn)
    }),
    confirmMealCooked: tool({
      description:
        "Only after the user actually cooked: confirm a current prep entry using its UUID and exact quantities from inventory item UUIDs. Read actual use; all deductions succeed together or none do. Repeated confirmations do not deduct again.",
      inputSchema: z.object({
        id,
        used: z.array(z.object({ itemId: id, quantity: amount }))
      }),
      execute: async ({ id, used }) => {
        const data = read();
        const entry = data.currentPrepPlan.entries.find((e) => e.id === id);
        if (!entry) return { error: "Prep entry not found" };
        if (entry.status === "cooked")
          return {
            message: "Already recorded as cooked; no additional deductions."
          };
        const totals = new Map<string, number>();
        for (const u of used)
          totals.set(u.itemId, (totals.get(u.itemId) ?? 0) + u.quantity);
        for (const [itemId, quantity] of totals) {
          const item = data.items.find((i) => i.id === itemId);
          if (!item || item.quantity < quantity)
            return { error: "Missing item or insufficient inventory", itemId };
        }
        for (const [itemId, quantity] of totals) {
          const item = data.items.find((i) => i.id === itemId)!;
          item.quantity = round(item.quantity - quantity);
        }
        entry.status = "cooked";
        entry.completedAt = new Date().toISOString();
        write(data);
        return entry;
      }
    })
  };
}
