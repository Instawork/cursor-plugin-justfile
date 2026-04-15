import * as path from "path";
import type { CatalogItem } from "./types";

/** Path to paste into Agent chat (posix); workspace files prefer relative. */
export function chatPathReference(item: CatalogItem): string {
  if (item.workspaceRelative) {
    return item.workspaceRelative.split(path.sep).join("/");
  }
  return item.fsPath.split(path.sep).join("/");
}

/** Same path with leading @ for quick paste. */
export function chatAtReference(item: CatalogItem): string {
  const ref = chatPathReference(item);
  return ref.startsWith("@") ? ref : `@${ref}`;
}
