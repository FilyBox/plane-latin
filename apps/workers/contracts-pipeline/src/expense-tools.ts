/**
 * Expenses from receipts the person gave the assistant (photo, PDF, CFDI
 * XML, or a PDF with its XML). Django runs them through the expense
 * importer: a CFDI is read exactly and is ready at once, the rest are
 * analysed; the card follows them, pairs a PDF with its XML and registers
 * the expenses on confirm. Admins only, like the module.
 */

import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

import type { AssistantChatRequest } from "./assistant";
import type { internalApi } from "./lib/internal-api";

type Api = ReturnType<typeof internalApi>;

export const EXPENSES_PROMPT = `
GASTOS DESDE COMPROBANTES (solo administradores)
- "Registra estos gastos / esta factura / este ticket": propose_expenses_from_documents con los asset_id de los archivos (adjuntos del chat, menciones o search_workspace con types file). Acepta fotos (JPG, PNG, WebP, TIFF, HEIC), PDF y XML de CFDI 3.3 o 4.0; una factura con su PDF y su XML se vuelve UN gasto con los dos documentos.
- Si el usuario dice el presupuesto, pásalo como scenario_id (búscalo antes). En notes van indicaciones para la tarjeta ("todo es de la gira", "ya están pagados").
- Del XML los montos son exactos; de fotos y PDF salen de un análisis que hay que revisar. Avisa si es nota de crédito o complemento de pago, y si un gasto ya estaba registrado (mismo UUID). Nunca digas que ya quedó registrado: la persona revisa y aplica en la tarjeta.`;

export function buildExpenseTools(api: Api, body: AssistantChatRequest): ToolSet {
  const userId = body.user_id ?? "";
  return {
    propose_expenses_from_documents: tool({
      description:
        "Prepara gastos desde comprobantes (fotos, PDF, XML CFDI; un PDF y su XML de la misma factura son un solo gasto). Inicia o reusa el análisis de cada archivo y devuelve la tarjeta, que sigue el análisis, muestra los datos editables con presupuesto y categoría sugeridos y avisa duplicados; se registra al confirmar y se puede deshacer.",
      inputSchema: z.object({
        asset_ids: z.array(z.string()).min(1).max(30),
        scenario_id: z.string().optional().describe("Presupuesto al que van, si lo dijo"),
        notes: z.string().max(500).optional(),
      }),
      execute: async (input) => {
        const run = await api.request<Record<string, unknown> & { error?: string }>(
          "POST",
          `/internal/workspaces/${body.workspace_id}/assistant/expenses/from-documents/`,
          { user_id: userId, asset_ids: input.asset_ids, scenario_id: input.scenario_id }
        );
        if (run.error) return { error: run.error };
        return { ...run, notes: input.notes, workspace_slug: body.workspace_slug };
      },
    }),
  };
}
