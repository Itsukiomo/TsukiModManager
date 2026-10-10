const DANGEROUS_ELEMENT_SELECTOR = "script, style, iframe, object, embed, svg, canvas, meta, link, noscript, form, input, button";
const DANGEROUS_TAG_PATTERN = /<\s*(script|style|iframe|object|embed|svg|canvas|noscript|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DANGEROUS_VOID_TAG_PATTERN = /<\s*(script|style|iframe|object|embed|svg|canvas|meta|link|noscript|form|input|button)\b[^>]*\/?\s*>/gi;
const LEAKED_ATTRIBUTE_TEXT_PATTERN = /\b(?:s|crossorigin|nonce|integrity|referrerpolicy)=["'][^"']*["']/gi;
const BARE_CROSSORIGIN_PATTERN = /\bcrossorigin\b/gi;

function isSafeUrl(value: string, image = false) {
  try {
    if (image && value.startsWith("data:image/")) return true;
    const baseUrl = typeof window === "undefined" ? "https://tsuki.local/" : window.location.href;
    const parsed = new URL(value, baseUrl);
    return ["http:", "https:", "mailto:", "asset:", "tauri:", "blob:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function stripDangerousRichHtmlFragments(html: string) {
  return html
    .replace(DANGEROUS_TAG_PATTERN, "")
    .replace(DANGEROUS_VOID_TAG_PATTERN, "");
}

export function cleanLeakedAttributeText(value: string) {
  return value
    .replace(LEAKED_ATTRIBUTE_TEXT_PATTERN, "")
    .replace(BARE_CROSSORIGIN_PATTERN, "")
    .replace(/\s{2,}/g, " ");
}

function sanitizeWithoutDom(html: string) {
  return cleanLeakedAttributeText(stripDangerousRichHtmlFragments(html))
    .replace(/\s+on[a-z]+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\s+(nonce|integrity|referrerpolicy|crossorigin|s)\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\s+(href|src)\s*=\s*["']\s*(javascript|vbscript|data:text\/html):[^"']*["']/gi, "");
}

export function sanitizeRichHtml(html: string) {
  const preparedHtml = stripDangerousRichHtmlFragments(html);
  if (typeof document === "undefined") return sanitizeWithoutDom(preparedHtml);

  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(preparedHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset", "nonce", "integrity", "crossorigin"],
    ALLOW_DATA_ATTR: false,
  });
  template.content
    .querySelectorAll(DANGEROUS_ELEMENT_SELECTOR)
    .forEach((node) => node.remove());
  const allowed = new Set([
    "a", "b", "blockquote", "br", "code", "details", "div", "em", "h2", "h3", "h4", "hr",
    "i", "img", "li", "ol", "p", "pre", "small", "span", "strong", "summary",
    "table", "tbody", "td", "th", "thead", "tr", "ul",
  ]);
  const allowedAttrs = new Set(["alt", "colspan", "href", "loading", "rowspan", "src", "title"]);

  const cleanText = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      node.textContent = cleanLeakedAttributeText(node.textContent);
    }
    for (const child of Array.from(node.childNodes)) cleanText(child);
  };

  const clean = (node: Element) => {
    for (const child of Array.from(node.children)) clean(child);
    const tag = node.tagName.toLowerCase();
    if (!allowed.has(tag)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      const unsafeAttr = name.startsWith("on") || !allowedAttrs.has(name);
      const unsafeHref = name === "href" && !isSafeUrl(value);
      const unsafeSrc = name === "src" && !isSafeUrl(value, true);
      if (unsafeAttr || unsafeHref || unsafeSrc) {
        node.removeAttribute(attr.name);
      }
    }
    if (tag === "a") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer");
    }
    if (tag === "img") {
      node.setAttribute("loading", "lazy");
    }
  };

  for (const child of Array.from(template.content.children)) clean(child);
  cleanText(template.content);
  return template.innerHTML;
}
import DOMPurify from "dompurify";
