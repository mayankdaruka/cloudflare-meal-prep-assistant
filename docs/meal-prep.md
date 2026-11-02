# Meal prep

Start with `npm run start`. The chat manages three core tables and one current prep plan:

| Table                | Contents                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ingredients`        | UUID, name, shelf life in days from purchase, nutritional facts                                                   |
| `inventory_items`    | Item UUID, ingredient UUID, quantity, original unit, purchase date and expiration                                 |
| `recipes`            | UUID, name, base portions, instructions and a JSON mapping from ingredient UUIDs to quantity, unit and prep notes |
| `app_settings`       | One `current_prep_plan` record containing recipe UUIDs, desired portions and cooking status                       |

Ingredient UUIDs identify foods; item UUIDs identify individual purchases. Repeated purchases remain separate items with their own dates. Names can change without breaking references. The assistant reuses the closest equivalent existing ingredient, asks when ambiguous, and creates an ingredient when no suitable match exists. There is no alias table or storage location.

Shelf life is stored directly on each ingredient. An explicit item expiration overrides the purchase-based estimate. Changed defaults affect future purchases, not old item dates. Unknown shelf lives remain unknown. Estimated expiration dates do not guarantee food safety.

Nutrition is either `null` or one complete object: `caloriesPerServing` (kcal, nonnegative), `servingSize` (positive), and `servingUnit` (nonempty). The assistant saves ingredients even when nutrition is unknown, asks for missing information, and never invents values. Omitted nutrition preserves existing data; explicit `null` clears it. Tool validation and SQLite constraints reject partial objects. Nutrition metadata is stored; automatic recipe calorie totals are not yet implemented.

Recipes preserve exact original measurements. Their ingredient references are validated by application code because SQLite cannot enforce foreign keys inside JSON. Editing a recipe immediately updates its requirements in the current prep plan. Each ingredient has one measurement entry per recipe.

The current prep plan has no calendar or separate meal-plans table. Each entry has a UUID to identify a cooking session and prevent repeated confirmations from deducting inventory twice. Cooking sets `completedAt`. Reads and writes remove cooked entries older than 28 days from completion; planned entries are retained. Cleanup is saved to SQLite, with no scheduled job. Deleted entries cannot be confirmed again. Inventory quantities are unaffected. Replacing the plan removes unwanted entries. To cook the same recipe again, add a new entry.

Grocery lists are calculated from planned recipes and desired portions. Inventory is allocated once across all entries, earliest expiration first. Stock expiring before the specified use date is excluded. Unknown expiration is treated as usable and flagged for review. Units are case-insensitive but otherwise literal: `g` and `grams` remain different. Different units are flagged, never silently converted.

Planning does not consume stock. After cooking, actual item quantities are deducted atomically; purchases create new inventory items. Undo, editable dashboards, package conversions and leftover tracking are not implemented yet.

## Try it

1. “Remember my milk lasts 14 days from purchase.”
2. “I bought 1 carton of milk today.”
3. “Save rice bowls: 2 portions, 200 g dry rice and 300 g chicken. Cook rice and chicken and divide into bowls.”
4. “I bought 500 g dry rice and 400 g chicken today. The chicken expires tomorrow.”
5. “Set my current prep plan to 4 portions of rice bowls.”
6. “What groceries do I need to prepare this plan tomorrow?”
7. “Show all my saved ingredients, inventory, recipes and current prep plan.”

## Storage and checks

`src/meal-prep.ts` defines data types, calculations and chat tools. `src/meal-store.ts` persists them in the ChatAgent Durable Object SQLite database. Writes use synchronous transactions. Obsolete schemas and compatibility code have been removed; there is no migration path from older prototypes.

Data is scoped to the existing agent instance. The starter has no authenticated household accounts. Local Wrangler data and deployed data are separate; Workers KV is not used. GPT-OSS-120B runs with low reasoning and accepts text input with tool calling. Live model/tool behavior requires verification with your Cloudflare account.

Run `node --experimental-strip-types --test src/meal-prep.test.ts src/meal-store.test.ts` with Node supporting `node:sqlite`. Run `npm run lint` and `npx tsc --noEmit` for static checks.
