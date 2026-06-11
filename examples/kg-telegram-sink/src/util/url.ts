/** URL detection + lightweight source classification. */

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

export function extractUrls(text?: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_RE) ?? [];
  // Strip common trailing punctuation that the greedy regex may grab.
  return matches.map((u) => u.replace(/[.,;:!?]+$/, ""));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function isYouTubeVideo(url: string): boolean {
  const h = hostnameOf(url);
  if (h === "youtu.be") return true;
  if (h === "youtube.com" || h === "m.youtube.com") {
    try {
      const u = new URL(url);
      return u.searchParams.has("v") || u.pathname.startsWith("/shorts/");
    } catch {
      return false;
    }
  }
  return false;
}

export function isYouTubeChannel(url: string): boolean {
  const h = hostnameOf(url);
  if (h !== "youtube.com" && h !== "m.youtube.com") return false;
  return /^\/(channel\/|c\/|user\/|@)/.test(new URL(url).pathname);
}

export function isTikTokVideo(url: string): boolean {
  const h = hostnameOf(url);
  if (!h.endsWith("tiktok.com")) return false;
  // A specific video has /video/<id> or is a vm.tiktok.com/<id> short link.
  return /\/video\/\d+/.test(url) || h.startsWith("vm.") || h.startsWith("vt.");
}

export function isTikTokChannel(url: string): boolean {
  const h = hostnameOf(url);
  if (!h.endsWith("tiktok.com")) return false;
  return /^\/@[^/]+\/?$/.test(new URL(url).pathname);
}

/** Best-effort YouTube video id from any youtube/youtu.be URL. */
export function youTubeVideoId(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") === "youtu.be") {
      return u.pathname.slice(1) || undefined;
    }
    if (u.pathname.startsWith("/shorts/")) {
      return u.pathname.split("/")[2];
    }
    return u.searchParams.get("v") ?? undefined;
  } catch {
    return undefined;
  }
}
