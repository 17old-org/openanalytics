/**
 * The poster's type is the page's own sans, and a canvas will not wait for
 * it: text drawn before the face is in memory renders in the fallback and
 * stays that way. So the family is read off the document once and its
 * weights are loaded through the Font Loading API before the first draw.
 */

const FALLBACK = "system-ui, sans-serif";

/** The `<html>` element's resolved family list, which is `font-sans`. */
export function posterFontFamily(): string {
  if (typeof document === "undefined") return FALLBACK;
  const family = getComputedStyle(document.documentElement).fontFamily.trim();
  return family || FALLBACK;
}

const loads = new Map<string, Promise<void>>();

/** Resolves once the two weights the poster uses are usable on a canvas.
 * Never rejects: a face that cannot be loaded draws in the fallback, which
 * beats a modal that never opens. */
export function ensurePosterFonts(family: string): Promise<void> {
  const pending = loads.get(family);
  if (pending) return pending;
  const specs = [`400 18px ${family}`, `500 20px ${family}`];
  const load =
    typeof document === "undefined" || !("fonts" in document)
      ? Promise.resolve()
      : Promise.all(
          specs.map((spec) => document.fonts.load(spec).catch(() => []))
        ).then(() => undefined);
  loads.set(family, load);
  return load;
}
