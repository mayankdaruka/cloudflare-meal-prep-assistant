import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { mealTools } from "./meal-prep";
import { MealStore } from "./meal-store";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  private mealStore: MealStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.mealStore = new MealStore({
      query: (sql, ...values) =>
        ctx.storage.sql
          .exec<Record<string, string | number | null>>(sql, ...values)
          .toArray(),
      transaction: (callback) => ctx.storage.transactionSync(callback)
    });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/openai/gpt-oss-120b", {
        reasoning_effort: "low",
        sessionAffinity: this.sessionAffinity
      }),
      maxOutputTokens: 4096,
      system: `You are a meal-prep assistant. Help manage inventory, exact recipes, a current prep plan and grocery lists using the meal-prep tools. Saved tool data is the source of truth: read it before answering questions about existing records or changing records. Never claim a change was saved unless a tool succeeds.
Preserve original ingredient measurements. Do not convert units or invent recipe quantities, dates, shelf lives or inventory. Reuse exact ingredient names and unit spellings from saved records. Ask about ambiguous ingredient forms (dry vs cooked), measurements, portions and dates. Save nutrition only when caloriesPerServing (kcal), servingSize and servingUnit are all known. If nutrition is incomplete, save the ingredient without nutrition and ask for the missing details. Never guess nutrition or clear existing complete nutrition unless the user explicitly asks. Store user-provided shelf life directly on the ingredient and reuse it automatically. Match ingredient names to the closest equivalent already saved; ask when ambiguous. Use UUIDs returned by tools, never invent IDs. There are no aliases or storage locations; never ask where an item is stored. Expiration estimates are estimates, not guarantees of food safety. Separate purchases into items. Changing a rule affects future items only.
Use getUserTimezone when local dates matter; the current UTC timestamp is ${new Date().toISOString()}. Purchase dates default to today only when the user says they bought something today; ask when unknown. Explicit item expiration overrides default shelf life. Planning never deducts stock; confirm cooking with actual item use. Explain unit mismatches and unknown expiration dates on grocery lists. Do not silently substitute ingredients. You cannot view images; ask for a text description.

Use setCurrentPrepPlan to remember recipes and desired portions without a calendar. Recipe edits immediately affect the current plan; explain meaningful changes.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        ...mealTools(
          () => this.mealStore.read(),
          (data) => this.mealStore.write(data)
        ),

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        })
      },
      stopWhen: stepCountIs(20),
      onStepFinish: ({ finishReason, usage }) => {
        console.info("Meal-prep generation step finished", {
          finishReason,
          outputTokens: usage.outputTokens
        });
      },
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({ sendReasoning: false });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
