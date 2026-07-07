export const GITHUB_NAME_WITH_OWNER: Record<string, string> = {
  instawork: "Instawork/instawork",
  finch: "Instawork/finch",
  infrastructure: "Instawork/infrastructure",
};

export function repoKeyFromNameWithOwner(
  nameWithOwner: string
): string | null {
  const norm = nameWithOwner.trim().toLowerCase();
  for (const [key, slug] of Object.entries(GITHUB_NAME_WITH_OWNER)) {
    if (slug.toLowerCase() === norm) {
      return key;
    }
  }
  return null;
}

export function prNumberFromUrl(url: string | undefined): number | null {
  if (!url) {
    return null;
  }
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
