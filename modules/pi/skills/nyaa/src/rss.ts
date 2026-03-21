import type { NyaaItem, SortOption } from "./types.js";

interface ParsedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  seeders?: string;
  leechers?: string;
  downloads?: string;
  infoHash?: string;
  category?: string;
  size?: string;
}

function parseNyaaNamespace(str: string): string {
  const parts = str.split(":");
  return parts[parts.length - 1] ?? str;
}

function parseSizeToBytes(sizeStr: string): number {
  const units: Record<string, number> = {
    B: 1,
    KiB: 1024,
    MiB: 1024 * 1024,
    GiB: 1024 * 1024 * 1024,
    TiB: 1024 * 1024 * 1024 * 1024,
  };

  const match = sizeStr.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2];
  return value * (units[unit] ?? 1);
}

function sortItems(items: NyaaItem[], sort: SortOption): NyaaItem[] {
  const sorted = [...items];

  switch (sort) {
    case "seeders_desc":
      sorted.sort((a, b) => b.seeders - a.seeders);
      break;
    case "seeders_asc":
      sorted.sort((a, b) => a.seeders - b.seeders);
      break;
    case "date_desc":
      sorted.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      break;
    case "date_asc":
      sorted.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      break;
    case "size_desc":
      sorted.sort((a, b) => parseSizeToBytes(b.size) - parseSizeToBytes(a.size));
      break;
    case "size_asc":
      sorted.sort((a, b) => parseSizeToBytes(a.size) - parseSizeToBytes(b.size));
      break;
  }

  return sorted;
}

function parseRSS(xml: string): NyaaItem[] {
  const items: NyaaItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;

  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    if (!itemXml) continue;

    const parsed: ParsedItem = {};
    const tagRegex = /<(\w+(?::\w+)?)>([^<]*)<\/\1>/g;

    let tagMatch;
    while ((tagMatch = tagRegex.exec(itemXml)) !== null) {
      const key = parseNyaaNamespace(tagMatch[1]);
      const value = tagMatch[2] ?? "";
      (parsed as Record<string, string>)[key] = value;
    }

    const title = parsed.title ?? "Unknown";
    const infoHash = parsed.infoHash ?? "";

    const magnet = infoHash
      ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=http://nyaa.tracker.wf:7777/announce`
      : "";

    items.push({
      title,
      magnet,
      size: parsed.size ?? "Unknown",
      seeders: parseInt(parsed.seeders ?? "0", 10) || 0,
      leechers: parseInt(parsed.leechers ?? "0", 10) || 0,
      category: parsed.category ?? "Unknown",
      date: parsed.pubDate ?? "Unknown",
      infoHash,
    });
  }

  return items;
}

export async function fetchNyaaRSS(
  query: string,
  category?: string,
  filter?: string,
  user?: string,
  sort?: SortOption
): Promise<NyaaItem[]> {
  const params = new URLSearchParams();
  params.set("page", "rss");
  params.set("q", query);
  if (category && category !== "0_0") params.set("c", category);
  if (filter && filter !== "no-filter") params.set("f", filter);
  if (user) params.set("u", user);

  const url = `https://nyaa.si/?${params.toString()}`;

  const response = await fetch(url, {
    headers: { Accept: "application/rss+xml" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const xml = await response.text();
  const items = parseRSS(xml);

  const sortToApply = sort ?? "seeders_desc";
  return sortItems(items, sortToApply);
}

export function formatItemForDisplay(item: NyaaItem, index?: number): string {
  const seeders = item.seeders > 0 ? `+${item.seeders}` : "0";
  const leechers = item.leechers > 0 ? `-${item.leechers}` : "0";
  const idx = index !== undefined ? `${index}. `.padStart(4) : "";
  return `${idx}${item.title} (${item.size}) [${seeders}/${leechers}]`;
}