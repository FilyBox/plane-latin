export const MUSIC_FIELD =
  "w-full rounded-md border border-subtle bg-layer-1 px-3 py-2 text-13 text-primary outline-none transition-colors focus:border-accent-primary";
export const MUSIC_LABEL = "mb-1.5 block text-11 font-semibold uppercase tracking-wide text-tertiary";

export const musicDate = (value?: string | null) => {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(
    new Date(`${value}T12:00:00`)
  );
};

/** Technical/internal leakage the user must never see in a toast: stack
 * traces, exception class names, file paths, hosts/ports, SQL, etc. */
const LEAKY_MESSAGE = /(traceback|exception|stack|errno|econn|refused|unreachable|timed? ?out|\.py\b|\.ts\b|\.tsx\b|https?:\/\/|:\d{2,5}\b|select .* from|internal server|worker|500|502|_[a-z]+_[a-z]+_id|\{|\[)/i;

const isUserSafe = (message: string) =>
  message.length > 0 && message.length <= 160 && !message.includes("\n") && !LEAKY_MESSAGE.test(message);

/**
 * User-facing message for a failed request. Only intentional, human-readable
 * API messages pass through; anything technical collapses to the fallback so
 * internals never reach the UI. The raw error is logged in dev builds only.
 */
export const getApiError = (error: unknown, fallback = "Algo salió mal. Inténtalo de nuevo.") => {
  if (import.meta.env.DEV) console.error("[music] request failed:", error);
  if (!error || typeof error !== "object") return fallback;
  const payload = error as Record<string, unknown>;
  const candidates: unknown[] = [payload.error, payload.detail];
  const first = Object.values(payload)[0];
  if (Array.isArray(first)) candidates.push(first[0]);
  else if (first && typeof first === "object") {
    const nested = Object.values(first as Record<string, unknown>)[0];
    if (Array.isArray(nested)) candidates.push(nested[0]);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isUserSafe(candidate.trim())) return candidate.trim();
  }
  return fallback;
};
