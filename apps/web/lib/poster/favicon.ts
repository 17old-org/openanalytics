import {
  faviconCandidates,
  faviconUrl,
} from "@/components/dashboard/site-favicon";

/**
 * The site's favicon as a drawable image, or null for the initial tile.
 *
 * Walks the allowlist in order, so the poster wears the same mark the
 * dashboard's own tiles show. The image comes through our own
 * `/api/favicon` route, which matters twice: a bodyless 404 is a real miss
 * (gstatic would hand back a globe), and a same-origin image never taints
 * the canvas, which is what keeps `toBlob` allowed afterwards.
 */
export async function loadSiteFavicon(
  domains: readonly string[],
  signal: AbortSignal
): Promise<HTMLImageElement | null> {
  for (const domain of faviconCandidates(domains)) {
    if (signal.aborted) return null;
    const image = await loadImage(faviconUrl(domain), signal);
    if (image) return image;
  }
  return null;
}

function loadImage(
  src: string,
  signal: AbortSignal
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    signal.addEventListener("abort", () => resolve(null), { once: true });
    image.src = src;
  });
}
