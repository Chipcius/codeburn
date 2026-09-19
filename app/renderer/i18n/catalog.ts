// Translation catalogs, keyed by the English source sentence.
//
// `en` is the source of truth. The other five start empty: until Stage 2 fills
// them, translate() falls through `en` to the key itself (the English sentence),
// so the app renders English everywhere while staying wired to switch.
//
// Stage 2 note: populate `en` with the canonical keys as components adopt t(),
// then fill fr/ja/ko/zhCN/zhTW against it. A missing key must never surface a
// raw identifier — keys are always the English copy.

export const en: Record<string, string> = {}
export const fr: Record<string, string> = {}
export const ja: Record<string, string> = {}
export const ko: Record<string, string> = {}
export const zhCN: Record<string, string> = {}
export const zhTW: Record<string, string> = {}
