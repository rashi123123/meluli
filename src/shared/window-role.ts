// Which window a renderer page is. The main process puts the role in the page URL's query; the sender
// check, the preload and the renderer all read it back from there.
export const WINDOW_ROLE_QUERY_KEY = "window";
export const APP_WINDOW_ROLES = ["main", "overlay", "call"] as const;
export type AppWindowRole = (typeof APP_WINDOW_ROLES)[number];

/** The role named in a page URL's query, or null when it names none of them. */
export function windowRoleFromQuery(search: string): AppWindowRole | null {
  const value = new URLSearchParams(search).get(WINDOW_ROLE_QUERY_KEY);
  return APP_WINDOW_ROLES.find((role) => role === value) ?? null;
}
