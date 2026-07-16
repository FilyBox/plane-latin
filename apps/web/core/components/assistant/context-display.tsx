import { useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import { Tooltip } from "@plane/propel/tooltip";

const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value);

const contextWindowFor = (model: string | null) => (model?.toLowerCase().includes("gemini") ? 1_000_000 : 128_000);

export function AssistantContextDisplay({ model }: { model: string | null }) {
  const usage = useThreadTokenUsage();
  const total = usage?.totalTokens ?? 0;
  if (!total) return null;

  const contextWindow = contextWindowFor(model);
  const percent = Math.min(100, (total / contextWindow) * 100);
  const color = percent > 85 ? "stroke-red-500" : percent >= 65 ? "stroke-amber-500" : "stroke-emerald-500";
  const details = (
    <span className="grid min-w-40 grid-cols-2 gap-x-4 gap-y-1 text-11">
      <span>Uso</span>
      <span className="text-right">{percent.toFixed(1)}%</span>
      <span>Entrada</span>
      <span className="text-right">{compact(usage?.inputTokens ?? 0)}</span>
      <span>Cache</span>
      <span className="text-right">{compact(usage?.cachedInputTokens ?? 0)}</span>
      <span>Salida</span>
      <span className="text-right">{compact(usage?.outputTokens ?? 0)}</span>
      <span>Razonamiento</span>
      <span className="text-right">{compact(usage?.reasoningTokens ?? 0)}</span>
      <span>Total</span>
      <span className="text-right">
        {compact(total)} / {compact(contextWindow)}
      </span>
    </span>
  );

  return (
    <Tooltip tooltipHeading="Contexto de la conversacion" tooltipContent={details} position="top">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-11 text-tertiary hover:bg-layer-1-hover"
        aria-label={`Uso de contexto ${percent.toFixed(1)}%`}
      >
        <svg viewBox="0 0 20 20" className="size-4 -rotate-90" aria-hidden="true">
          <circle cx="10" cy="10" r="7" fill="none" strokeWidth="2.5" className="stroke-subtle" />
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 7}`}
            strokeDashoffset={`${2 * Math.PI * 7 * (1 - percent / 100)}`}
            className={color}
          />
        </svg>
        <span>{compact(total)}</span>
      </button>
    </Tooltip>
  );
}
