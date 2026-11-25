// Yomitan dictionary format (https://github.com/yomidevs/yomitan, ext/data/schemas/dictionary-*.json)

export type StructuredContent = string | StructuredContent[] | StructuredElement;
export interface StructuredElement {
  tag: string;
  content?: StructuredContent;
  data?: Record<string, string>;
  style?: Record<string, string | number | string[]>;
  lang?: string;
  title?: string;
  open?: boolean;
  colSpan?: number;
  rowSpan?: number;
  href?: string;
  // img
  path?: string;
  width?: number;
  height?: number;
  alt?: string;
  sizeUnits?: 'px' | 'em';
  verticalAlign?: string;
  imageRendering?: string;
  pixelated?: boolean;
  appearance?: string;
  collapsed?: boolean;
  border?: string;
  borderRadius?: string;
  description?: string;
}

export type GlossaryItem =
  | string
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; width?: number; height?: number; title?: string; alt?: string; description?: string; pixelated?: boolean; imageRendering?: string }
  | { type: 'structured-content'; content: StructuredContent }
  | [string, string[]]; // deinflection: [uninflected term, rules]

export interface DictionaryIndex {
  title: string;
  revision: string;
  format?: number;
  version?: number;
  sequenced?: boolean;
  author?: string;
  url?: string;
  description?: string;
  attribution?: string;
  frequencyMode?: 'occurrence-based' | 'rank-based';
  sourceLanguage?: string;
  targetLanguage?: string;
  isUpdatable?: boolean;
  tagMeta?: Record<string, { category?: string; order?: number; notes?: string; score?: number }>;
}

export interface DictionaryRecord extends DictionaryIndex {
  importDate: number;
  styles?: string;
  counts: { terms: number; termMeta: number; kanji: number; kanjiMeta: number; tags: number; media: number };
  /** Kinds of data contained: terms, freq, pitch, ipa, kanji */
  kinds: string[];
}

export interface YTerm {
  id?: number;
  dict: string;
  expression: string;
  reading: string;
  definitionTags: string[];
  rules: string[];
  score: number;
  glossary: GlossaryItem[];
  sequence?: number;
  termTags: string[];
}

export type FrequencyData = number | string | { value: number; displayValue?: string };

export interface YTermMeta {
  id?: number;
  dict: string;
  expression: string;
  mode: 'freq' | 'pitch' | 'ipa';
  data: unknown;
}

export interface YKanji {
  id?: number;
  dict: string;
  character: string;
  onyomi: string[];
  kunyomi: string[];
  tags: string[];
  meanings: string[];
  stats: Record<string, string>;
}

export interface YKanjiMeta {
  id?: number;
  dict: string;
  character: string;
  mode: 'freq';
  data: FrequencyData;
}

export interface YTag {
  dict: string;
  name: string;
  category: string;
  order: number;
  notes: string;
  score: number;
}

export interface PitchInfo {
  position: number | string;
  nasal?: number | number[];
  devoice?: number | number[];
  tags?: string[];
}
