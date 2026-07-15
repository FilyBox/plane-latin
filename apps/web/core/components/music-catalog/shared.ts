export const MUSIC_FIELD =
  "w-full rounded-md border border-subtle bg-layer-1 px-3 py-2 text-13 text-primary outline-none transition-colors focus:border-accent-primary";
export const MUSIC_LABEL = "mb-1.5 block text-11 font-semibold uppercase tracking-wide text-tertiary";

export const musicDate = (value?: string | null) => {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(
    new Date(`${value}T12:00:00`)
  );
};

export const getApiError = (error: unknown, fallback = "Something went wrong") => {
  if (!error || typeof error !== "object") return fallback;
  const payload = error as Record<string, unknown>;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.detail === "string") return payload.detail;
  const first = Object.values(payload)[0];
  if (Array.isArray(first) && typeof first[0] === "string") return first[0];
  if (first && typeof first === "object") {
    const nested = Object.values(first as Record<string, unknown>)[0];
    if (Array.isArray(nested) && typeof nested[0] === "string") return nested[0];
  }
  return fallback;
};
