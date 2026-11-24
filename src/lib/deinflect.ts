// Japanese deinflection: turns an inflected surface form (食べなかった) into candidate
// dictionary forms (食べる) along with the chain of inflections that were removed.
//
// Each rule rewrites a suffix. `cin` is the grammatical class the inflected form must
// belong to (relative to the rule applied before it), `cout` is the class of the result.
// A rule with an empty `cin` only applies at the very end of the scanned text.

export type Cond = 'v1' | 'v5' | 'vk' | 'vs' | 'vs-n' | 'vz' | 'adj-i' | 'te' | 'masu';

export interface Rule {
  from: string;
  to: string;
  cin: Cond[];
  cout: Cond[];
  reason: string;
}

export interface Deinflection {
  term: string;
  conds: Cond[]; // empty = surface form, no constraint
  reasons: string[]; // outermost first
}

const rules: Rule[] = [];
const add = (from: string, to: string, cin: Cond[], cout: Cond[], reason: string) => rules.push({ from, to, cin, cout, reason });

// --- Godan verbs -------------------------------------------------------------
// [dictionary ending, a-row, i-row, e-row, o-row, te-form, ta-form]
const GODAN: [string, string, string, string, string, string, string][] = [
  ['う', 'わ', 'い', 'え', 'お', 'って', 'った'],
  ['く', 'か', 'き', 'け', 'こ', 'いて', 'いた'],
  ['ぐ', 'が', 'ぎ', 'げ', 'ご', 'いで', 'いだ'],
  ['す', 'さ', 'し', 'せ', 'そ', 'して', 'した'],
  ['つ', 'た', 'ち', 'て', 'と', 'って', 'った'],
  ['ぬ', 'な', 'に', 'ね', 'の', 'んで', 'んだ'],
  ['ぶ', 'ば', 'び', 'べ', 'ぼ', 'んで', 'んだ'],
  ['む', 'ま', 'み', 'め', 'も', 'んで', 'んだ'],
  ['る', 'ら', 'り', 'れ', 'ろ', 'って', 'った'],
];

for (const [u, a, i, e, o, te, ta] of GODAN) {
  const v5: Cond[] = ['v5'];
  add(a + 'ない', u, ['adj-i'], v5, 'negative');
  add(a + 'ず', u, [], v5, 'negative (-zu)');
  add(a + 'ずに', u, [], v5, 'without doing');
  add(a + 'ぬ', u, [], v5, 'negative (-nu)');
  add(a + 'ん', u, [], v5, 'negative (-n)');
  add(a + 'れる', u, ['v1'], v5, 'passive');
  add(a + 'せる', u, ['v1'], v5, 'causative');
  add(a + 'す', u, ['v5'], v5, 'causative (short)');
  add(a + 'せられる', u, ['v1'], v5, 'causative passive');
  add(a + 'される', u, ['v1'], v5, 'causative passive');
  add(a + 'なきゃ', u, [], v5, 'must');
  add(a + 'なくちゃ', u, [], v5, 'must');
  add(i + 'ます', u, ['masu'], v5, 'polite');
  add(i + 'たい', u, ['adj-i'], v5, 'want');
  add(i + 'たがる', u, ['v5'], v5, 'want (3rd person)');
  add(i + 'そう', u, [], v5, 'seemingly');
  add(i + 'すぎる', u, ['v1'], v5, 'too much');
  add(i + 'なさい', u, [], v5, 'polite command');
  add(i + 'ながら', u, [], v5, 'while');
  add(i + 'に', u, [], v5, 'purpose');
  add(i, u, [], v5, 'stem');
  add(e + 'る', u, ['v1'], v5, 'potential');
  add(e + 'ば', u, [], v5, 'conditional');
  add(e, u, [], v5, 'imperative');
  add(o + 'う', u, [], v5, 'volitional');
  add(te, u, ['te'], v5, 'te-form');
  add(ta, u, [], v5, 'past');
  add(ta + 'ら', u, [], v5, 'conditional (-tara)');
  add(ta + 'り', u, [], v5, '-tari');
  add(u + 'な', u, [], v5, 'prohibitive');
}
// 行く is irregular in te/ta form.
for (const base of ['いく', '行く', 'ゆく', '逝く', '往く']) {
  const stem = base.slice(0, -1);
  add(stem + 'って', base, ['te'], ['v5'], 'te-form');
  add(stem + 'った', base, [], ['v5'], 'past');
  add(stem + 'ったら', base, [], ['v5'], 'conditional (-tara)');
  add(stem + 'ったり', base, [], ['v5'], '-tari');
}
// Honorific -aru verbs: いらっしゃい, ください, なさい
add('い', 'る', [], ['v5'], 'imperative');

// --- Ichidan verbs -----------------------------------------------------------
{
  const v1: Cond[] = ['v1'];
  const r = 'る';
  add('ない', r, ['adj-i'], v1, 'negative');
  add('ず', r, [], v1, 'negative (-zu)');
  add('ずに', r, [], v1, 'without doing');
  add('ぬ', r, [], v1, 'negative (-nu)');
  add('ん', r, [], v1, 'negative (-n)');
  add('なきゃ', r, [], v1, 'must');
  add('なくちゃ', r, [], v1, 'must');
  add('ます', r, ['masu'], v1, 'polite');
  add('た', r, [], v1, 'past');
  add('て', r, ['te'], v1, 'te-form');
  add('たら', r, [], v1, 'conditional (-tara)');
  add('たり', r, [], v1, '-tari');
  add('よう', r, [], v1, 'volitional');
  add('ろ', r, [], v1, 'imperative');
  add('よ', r, [], v1, 'imperative');
  add('れば', r, [], v1, 'conditional');
  add('られる', r, ['v1'], v1, 'passive / potential');
  add('れる', r, ['v1'], v1, 'potential (colloquial)');
  add('させる', r, ['v1'], v1, 'causative');
  add('させられる', r, ['v1'], v1, 'causative passive');
  add('さす', r, ['v5'], v1, 'causative (short)');
  add('たい', r, ['adj-i'], v1, 'want');
  add('たがる', r, ['v5'], v1, 'want (3rd person)');
  add('そう', r, [], v1, 'seemingly');
  add('すぎる', r, ['v1'], v1, 'too much');
  add('なさい', r, [], v1, 'polite command');
  add('ながら', r, [], v1, 'while');
  add('るな', r, [], v1, 'prohibitive');
  add('', r, [], v1, 'stem');
}

// --- Kuru (来る) ---------------------------------------------------------------
{
  const forms: [string, Cond[], string][] = [
    ['こない', ['adj-i'], 'negative'], ['こず', [], 'negative (-zu)'], ['こん', [], 'negative (-n)'],
    ['きます', ['masu'], 'polite'], ['きた', [], 'past'], ['きて', ['te'], 'te-form'],
    ['きたら', [], 'conditional (-tara)'], ['きたり', [], '-tari'], ['こよう', [], 'volitional'],
    ['こい', [], 'imperative'], ['くれば', [], 'conditional'], ['こられる', ['v1'], 'passive / potential'],
    ['これる', ['v1'], 'potential (colloquial)'], ['こさせる', ['v1'], 'causative'], ['きたい', ['adj-i'], 'want'],
    ['きそう', [], 'seemingly'], ['き', [], 'stem'], ['くるな', [], 'prohibitive'],
  ];
  for (const [f, cin, reason] of forms) {
    add(f, 'くる', cin, ['vk'], reason);
    add('来' + f.slice(1), '来る', cin, ['vk'], reason);
  }
}

// --- Suru (する) ---------------------------------------------------------------
{
  const forms: [string, Cond[], string][] = [
    ['しない', ['adj-i'], 'negative'], ['せず', [], 'negative (-zu)'], ['せずに', [], 'without doing'], ['せぬ', [], 'negative (-nu)'],
    ['せん', [], 'negative (-n)'], ['します', ['masu'], 'polite'], ['した', [], 'past'], ['して', ['te'], 'te-form'],
    ['したら', [], 'conditional (-tara)'], ['したり', [], '-tari'], ['しよう', [], 'volitional'], ['しろ', [], 'imperative'],
    ['せよ', [], 'imperative'], ['すれば', [], 'conditional'], ['される', ['v1'], 'passive'], ['させる', ['v1'], 'causative'],
    ['させられる', ['v1'], 'causative passive'], ['したい', ['adj-i'], 'want'], ['しそう', [], 'seemingly'],
    ['しなきゃ', [], 'must'], ['しなさい', [], 'polite command'], ['しながら', [], 'while'], ['し', [], 'stem'],
    ['するな', [], 'prohibitive'], ['できる', ['v1'], 'potential'],
  ];
  for (const [f, cin, reason] of forms) add(f, 'する', cin, ['vs'], reason);
  // 勉強する -> 勉強 (noun that takes する)
  add('する', '', ['vs'], ['vs-n'], 'suru verb');
}

// --- i-adjectives ------------------------------------------------------------
{
  const adj: Cond[] = ['adj-i'];
  const i = 'い';
  add('く', i, [], adj, 'adverbial');
  add('くない', i, ['adj-i'], adj, 'negative');
  add('かった', i, [], adj, 'past');
  add('くて', i, ['te'], adj, 'te-form');
  add('ければ', i, [], adj, 'conditional');
  add('きゃ', i, [], adj, 'conditional (colloquial)');
  add('くちゃ', i, [], adj, 'must');
  add('かったら', i, [], adj, 'conditional (-tara)');
  add('かったり', i, [], adj, '-tari');
  add('さ', i, [], adj, 'noun (-sa)');
  add('そう', i, [], adj, 'seemingly');
  add('すぎる', i, ['v1'], adj, 'too much');
  add('げ', i, [], adj, 'seeming (-ge)');
  add('かろう', i, [], adj, 'presumptive');
  add('き', i, [], adj, 'attributive (classical)');
  add('くなる', i, ['v5'], adj, 'become');
}

// --- Polite (ます) inflections --------------------------------------------------
for (const [f, reason] of [
  ['ません', 'negative'], ['ました', 'past'], ['ませんでした', 'past negative'], ['ましょう', 'volitional'],
  ['まして', 'te-form'], ['ませ', 'imperative'], ['ましたら', 'conditional (-tara)'],
] as const) add(f, 'ます', [], ['masu'], reason);

// --- Auxiliaries attached to the te-form -------------------------------------
const TE_AUX: [string, Cond[], string][] = [
  ['いる', ['v1'], 'progressive'], ['る', ['v1'], 'progressive (contracted)'], ['おる', ['v5'], 'progressive (humble)'],
  ['おく', ['v5'], 'in advance'], ['しまう', ['v5'], 'completion'], ['ある', ['v5'], 'resultative'],
  ['くる', ['vk'], 'come to'], ['来る', ['vk'], 'come to'], ['いく', ['v5'], 'go on'], ['く', ['v5'], 'go on (contracted)'],
  ['みる', ['v1'], 'try'], ['くれる', ['v1'], 'for me'], ['もらう', ['v5'], 'have done'], ['あげる', ['v1'], 'for someone'],
  ['ください', [], 'please'], ['くださる', ['v5'], 'for me (honorific)'], ['ほしい', ['adj-i'], 'want someone to'],
  ['も', [], 'even if'], ['は', [], 'topic'],
];
for (const [aux, cin, reason] of TE_AUX) {
  add('て' + aux, 'て', cin, ['te'], reason);
  add('で' + aux, 'で', cin, ['te'], reason);
}
add('ちゃう', 'て', ['v5'], ['te'], 'completion (contracted)');
add('じゃう', 'で', ['v5'], ['te'], 'completion (contracted)');
add('とく', 'て', ['v5'], ['te'], 'in advance (contracted)');
add('どく', 'で', ['v5'], ['te'], 'in advance (contracted)');
add('ちゃ', 'ては', [], [], 'contracted');
add('じゃ', 'では', [], [], 'contracted');

// Index rules by the last character of `from` for speed.
const byLastChar = new Map<string, Rule[]>();
const emptyFrom: Rule[] = [];
for (const r of rules) {
  if (!r.from) { emptyFrom.push(r); continue; }
  const last = Array.from(r.from).pop()!;
  let list = byLastChar.get(last);
  if (!list) byLastChar.set(last, (list = []));
  list.push(r);
}

function condsMatch(have: Cond[], need: Cond[]): boolean {
  if (have.length === 0) return true;
  for (const c of need) if (have.includes(c)) return true;
  return false;
}

export function deinflect(source: string, maxDepth = 8): Deinflection[] {
  const results: Deinflection[] = [{ term: source, conds: [], reasons: [] }];
  const seen = new Set<string>([source + '|']);
  for (let i = 0; i < results.length; i++) {
    const cur = results[i];
    if (cur.reasons.length >= maxDepth || !cur.term) continue;
    const last = Array.from(cur.term).pop()!;
    const candidates = byLastChar.get(last) ?? [];
    for (const list of [candidates, emptyFrom]) {
      for (const rule of list) {
        if (!cur.term.endsWith(rule.from)) continue;
        if (cur.term.length === rule.from.length && rule.to === '') continue;
        if (!condsMatch(cur.conds, rule.cin)) continue;
        // Avoid applying "stem" (empty suffix) rules twice in a row / to non-constrained loops.
        if (rule.from === '' && cur.reasons.length > 0) continue;
        const term = cur.term.slice(0, cur.term.length - rule.from.length) + rule.to;
        if (!term) continue;
        const key = term + '|' + rule.cout.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ term, conds: rule.cout, reasons: [rule.reason, ...cur.reasons] });
      }
    }
  }
  return results;
}

/** Maps JMdict part-of-speech codes to deinflection conditions. */
export function posToConds(pos: string): Cond | null {
  if (pos === 'v1' || pos === 'v1-s') return 'v1';
  if (pos.startsWith('v5')) return 'v5';
  if (pos === 'vk') return 'vk';
  if (pos === 'vs-i' || pos === 'vs-s') return 'vs';
  if (pos === 'vs') return 'vs-n';
  if (pos === 'vz') return 'vz';
  if (pos === 'adj-i' || pos === 'adj-ix') return 'adj-i';
  return null;
}

export const ruleCount = rules.length;
