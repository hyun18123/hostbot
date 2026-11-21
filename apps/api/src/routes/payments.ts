import type { FastifyInstance } from "fastify";
import { discordIdSchema } from "@hostbot/shared";
import { db, unwrap } from "../lib/supabase.js";
import { parseInput } from "../lib/http.js";
import { getPaymentStatus } from "../services/payments.js";
import { getBankInfo } from "../services/settings.js";

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/payments", async (request) => {
    const query = request.query as { discordUserId?: string };
    const discordUserId = parseInput(discordIdSchema, query.discordUserId);
    return getPaymentStatus(discordUserId);
  });

  app.get("/internal/plans", async () => {
    const plans = unwrap(
      await db()
        .from("hosting_plans")
        .select("code, name, price_krw, duration_days, is_active")
        .eq("is_active", true)
        .order("price_krw", { ascending: true }),
    );
    return { plans, bank: await getBankInfo() };
  });
}
