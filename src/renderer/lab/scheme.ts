// The app's light rules sit behind prefers-color-scheme, which Electron drives through
// nativeTheme. A browser page cannot set that query, so the lab copies those rules
// under a data-lab-scheme attribute that it can set. Only the lab's own page is patched.

const LIGHT = "(prefers-color-scheme: light)";

function scoped(selectorText: string, attribute: string): string {
  return selectorText.split(",").map(part => {
    const selector = part.trim();
    if (selector.startsWith(":root")) return selector.replace(":root", `:root${attribute}`);
    if (selector.startsWith("html")) return selector.replace("html", `html${attribute}`);
    return `:root${attribute} ${selector}`;
  }).join(", ");
}

function rewrite(rule: CSSRule, attribute: string): string {
  // cssText keeps nested rules and the declarations after them; style.cssText would drop those.
  if (rule instanceof CSSStyleRule) return `${scoped(rule.selectorText, attribute)} ${rule.cssText.slice(rule.cssText.indexOf("{"))}`;
  return rule.cssText;
}

function patchSheet(sheet: CSSStyleSheet): void {
  let rules: CSSRuleList;
  try { rules = sheet.cssRules; } catch { return; }
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (!(rule instanceof CSSMediaRule) || rule.conditionText !== LIGHT) continue;
    const inner = Array.from(rule.cssRules);
    // System: light unless the lab forces dark. Forced light: always, in the same cascade position.
    const system = `@media ${LIGHT} { ${inner.map(item => rewrite(item, ':not([data-lab-scheme="dark"])')).join(" ")} }`;
    const forced = inner.map(item => rewrite(item, '[data-lab-scheme="light"]'));
    sheet.deleteRule(index);
    for (const text of [...forced].reverse()) sheet.insertRule(text, index);
    sheet.insertRule(system, index);
  }
}

// A reparsed stylesheet is a new object, so hot reloads are patched again.
const patched = new WeakSet<CSSStyleSheet>();

function patchAll(): void {
  for (const element of document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>("style, link[rel=stylesheet]")) {
    const sheet = element.sheet;
    if (!sheet || patched.has(sheet)) continue;
    patchSheet(sheet);
    patched.add(sheet);
  }
}

/** Patches now and again whenever Vite swaps a stylesheet during hot reload. */
export function enableSchemeOverride(): void {
  patchAll();
  new MutationObserver(() => patchAll()).observe(document.head, { childList: true, subtree: true, characterData: true });
}

export type LabScheme = "system" | "dark" | "light";

export function setLabScheme(scheme: LabScheme): void {
  const root = document.documentElement;
  if (scheme === "system") delete root.dataset.labScheme;
  else root.dataset.labScheme = scheme;
}
