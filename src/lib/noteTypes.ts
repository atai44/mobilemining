// Field mappings for well-known mining note types, and cautious guessing for the rest.
//
// A wrong guess is worse than an empty field: note types such as JP Mining Note and Lapis use
// fields like IsSentenceCard as switches, so filling them changes what kind of card you get.

const CLOZE = '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}';

/** jp-mining-note, with the markers its own Yomitan templates define (implemented in anki.ts). */
const JPMN: Record<string, string> = {
  Key: '{expression}',
  Word: '{expression}',
  WordReading: '{furigana-plain}',
  PrimaryDefinition: '{jpmn-primary-definition}',
  Sentence: CLOZE,
  Picture: '{image}',
  WordAudio: '{audio}',
  PAGraphs: '{jpmn-pitch-accent-graphs}',
  PAPositions: '{jpmn-pitch-accent-positions}',
  PASilence: '[sound:_silence.wav]',
  WordReadingHiragana: '{jpmn-word-reading-hiragana}',
  FrequenciesStylized: '{jpmn-frequencies}',
  FrequencySort: '{jpmn-min-freq}',
  SecondaryDefinition: '{jpmn-secondary-definition}',
  ExtraDefinitions: '{jpmn-extra-definitions}',
  UtilityDictionaries: '{jpmn-utility-dictionaries}',
};

/** Lapis (and Kiku, which shares its fields), as in their Yomitan setup guides. */
const LAPIS: Record<string, string> = {
  Expression: '{expression}',
  ExpressionFurigana: '{furigana-plain}',
  ExpressionReading: '{reading}',
  ExpressionAudio: '{audio}',
  MainDefinition: '{glossary-first}',
  Sentence: CLOZE,
  Picture: '{image}',
  Glossary: '{glossary}',
  PitchPosition: '{pitch-accent-positions}',
  PitchCategories: '{pitch-accent-categories}',
  Frequency: '{frequencies}',
  FreqSort: '{frequency-harmonic-rank}',
  MiscInfo: '{document-title}',
};

export interface KnownNoteType { name: string; fields: Record<string, string> }

/** The known note type these field names belong to, if any. */
export function knownNoteType(fieldNames: string[]): KnownNoteType | null {
  const has = (...names: string[]) => names.every((n) => fieldNames.includes(n));
  if (has('Key', 'Word', 'PrimaryDefinition', 'PAGraphs')) return { name: 'JP Mining Note', fields: JPMN };
  if (has('Expression', 'MainDefinition', 'ExpressionFurigana', 'IsSentenceCard')) return { name: 'Lapis', fields: LAPIS };
  return null;
}

/** Guesses a marker for a field of an unknown note type. Only exact, unambiguous names. */
export function guessMarker(field: string): string {
  const f = field.toLowerCase().replace(/[\s_-]/g, '');
  const table: [RegExp, string][] = [
    [/^(expression|word|vocab|vocabulary|term|front|targetword|key)$/, '{expression}'],
    [/^(expressionfurigana|wordfurigana|vocabfurigana|furigana)$/, '{furigana-plain}'],
    [/^(reading|kana|vocabkana|wordreading|expressionreading)$/, '{reading}'],
    [/^(expressionaudio|wordaudio|vocabaudio|audio|sound)$/, '{audio}'],
    [/^(maindefinition|meaning|definition|definitions|glossary|english|back|vocabdef)$/, '{glossary}'],
    [/^(sentence|context|example|sentencekanji)$/, CLOZE],
    [/^(picture|image|photo|screenshot)$/, '{image}'],
    [/^(pitchposition|pitchaccent|pitch)$/, '{pitch-accent-positions}'],
    [/^(pitchcategories|pitchcategory)$/, '{pitch-accent-categories}'],
    [/^(frequency|frequencies)$/, '{frequencies}'],
    [/^(freqsort|frequencysort)$/, '{frequency-harmonic-rank}'],
    [/^(source|book|miscinfo|documenttitle)$/, '{document-title}'],
    [/^(pos|partofspeech)$/, '{part-of-speech}'],
  ];
  for (const [re, m] of table) if (re.test(f)) return m;
  return '';
}

/**
 * The mapping to start from for a note type: the known type's own mapping (other fields empty),
 * or cautious guesses.
 */
export function recommendedFields(fieldNames: string[]): Record<string, string> {
  const known = knownNoteType(fieldNames);
  return Object.fromEntries(fieldNames.map((n) => [n, known ? known.fields[n] ?? '' : guessMarker(n)]));
}

/**
 * A mapping made by this app's earlier, greedier guessing: it filled switch fields such as
 * IsSentenceCard with the sentence, which changes the card type.
 */
export function looksMisguessed(fields: Record<string, string>): boolean {
  return Object.entries(fields).some(([name, tpl]) =>
    tpl.includes('{') && (/^(Is[A-Z]|PASeparate|SeparateCloze|AltDisplay)/.test(name) || /^(PrimaryDefinitionPicture|DefinitionPicture)$/.test(name)));
}
