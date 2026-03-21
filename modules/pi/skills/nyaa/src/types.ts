export interface NyaaItem {
  title: string;
  magnet: string;
  size: string;
  seeders: number;
  leechers: number;
  category: string;
  date: string;
  infoHash: string;
}

export type SortOption =
  | "seeders_desc"
  | "seeders_asc"
  | "date_desc"
  | "date_asc"
  | "size_desc"
  | "size_asc";

export const CATEGORY_NAMES: Record<string, string> = {
  "0_0": "All",
  "1_0": "Anime",
  "1_1": "Anime - AMV",
  "1_2": "Anime - English-translated",
  "1_3": "Anime - Non-English-translated",
  "1_4": "Anime - Raw",
  "2_0": "Audio",
  "2_1": "Audio - Lossless",
  "2_2": "Audio - Lossy",
  "3_0": "Literature",
  "3_1": "Literature - English-translated",
  "3_2": "Literature - Non-English-translated",
  "3_3": "Literature - Raw",
  "4_0": "Live Action",
  "4_1": "Live Action - English-translated",
  "4_2": "Live Action - Idol/Promotional Video",
  "4_3": "Live Action - Non-English-translated",
  "4_4": "Live Action - Raw",
  "5_0": "Pictures",
  "5_1": "Pictures - Graphics",
  "5_2": "Pictures - Photos",
  "6_0": "Software",
  "6_1": "Software - Applications",
  "6_2": "Software - Games",
};