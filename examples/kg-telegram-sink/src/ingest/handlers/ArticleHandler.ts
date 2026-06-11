import * as fs from "fs";
import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";
import { writeMarkdown, inboxBinaryPath } from "../inboxWriter";
import { importEsm } from "../../util/esmImport";
import { isYouTubeVideo, isYouTubeChannel, isTikTokVideo, isTikTokChannel } from "../../util/url";

interface ExtractedArticle {
  title?: string;
  content?: string;
  author?: string;
  published?: string;
}
type ArticleExtractorModule = {
  extractFromHtml: (html: string, url?: string) => Promise<ExtractedArticle | null>;
};

// Pretend to be a browser; many sites (and arxiv) reject the default fetch UA.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** True for plain web pages we should read as articles (not yt/tiktok URLs). */
function isArticleUrl(url: string): boolean {
  return !isYouTubeVideo(url) && !isYouTubeChannel(url) && !isTikTokVideo(url) && !isTikTokChannel(url);
}

/** Filename for a downloaded PDF, derived from the URL's last path segment. */
function pdfNameFromUrl(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() || "document";
    return /\.pdf$/i.test(seg) ? seg : `${seg}.pdf`;
  } catch {
    return "document.pdf";
  }
}

/** Crude but dependency-free HTML → text. Good enough for extracted article bodies. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Any plain web URL. Fetches once and branches on content-type:
 *  - PDF (incl. arxiv `/pdf/<id>`, which has no `.pdf` extension) → downloaded into
 *    the inbox so kg-gen's PdfReader extracts the real document.
 *  - HTML → Readability-style article extraction.
 *  - anything else / failure → a bare-link stub so nothing is silently lost.
 */
export class ArticleHandler implements SourceHandler {
  readonly name = "article";

  canHandle(msg: NormalizedMessage): boolean {
    return msg.urls.some(isArticleUrl);
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const items: IngestedItem[] = [];
    const { extractFromHtml } = await importEsm<ArticleExtractorModule>("@extractus/article-extractor");

    for (const url of msg.urls.filter(isArticleUrl)) {
      try {
        const res = await fetch(url, { redirect: "follow", headers: { "user-agent": UA } });
        if (!res.ok) {
          items.push(this.fallback(url, ctx, `HTTP ${res.status}`));
          continue;
        }

        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        const isPdf = contentType.includes("application/pdf") || /\.pdf($|\?)/i.test(url);

        if (isPdf) {
          const buf = Buffer.from(await res.arrayBuffer());
          const dest = inboxBinaryPath(ctx.inboxDir, pdfNameFromUrl(url));
          fs.writeFileSync(dest, buf);
          const title = pdfNameFromUrl(url);
          items.push({
            path: dest,
            kind: "pdf",
            title,
            note: "PDF downloaded — kg-gen's PdfReader extracts the full document on this run",
          });
          continue;
        }

        const html = await res.text();
        const article = await extractFromHtml(html, url);
        if (article && article.content) {
          const title = article.title || url;
          const body = [
            article.author ? `By ${article.author}.` : "",
            article.published ? `Published ${article.published}.` : "",
            "",
            htmlToText(article.content),
          ]
            .filter(Boolean)
            .join("\n");
          const path = writeMarkdown(ctx.inboxDir, { kind: "article", title, source: url }, body, title);
          items.push({ path, kind: "article", title });
        } else {
          items.push(this.fallback(url, ctx, "no readable content extracted"));
        }
      } catch (err) {
        ctx.log(`article ingest failed for ${url}: ${err}`);
        items.push(this.fallback(url, ctx, "fetch/extraction failed"));
      }
    }
    return items;
  }

  private fallback(url: string, ctx: IngestContext, reason: string): IngestedItem {
    const path = writeMarkdown(
      ctx.inboxDir,
      { kind: "link", title: url, source: url },
      `Saved link (${reason}): ${url}`,
      url
    );
    return { path, kind: "link", title: url, note: `couldn't read page (${reason}) — saved the link only` };
  }
}
