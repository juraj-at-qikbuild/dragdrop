// Random Slovak-flavoured nicknames ("Rýchly Jožo", "Dunajská Zuzka") for the online name prompt.
const MALE = ['Jožo', 'Fero', 'Paľo', 'Mišo', 'Duro', 'Laco', 'Ďuri', 'Janko', 'Tono', 'Maťo', 'Peťo', 'Ivan', 'Braňo', 'Ondro'];
const FEMALE = ['Zuzka', 'Katka', 'Janka', 'Evka', 'Majka', 'Danka', 'Hanka', 'Lenka', 'Soňa', 'Vierka', 'Anka', 'Terka'];
/** adjective stems; masculine adds -ý/-i, feminine -á/-ia */
const ADJ: [string, string][] = [
  ['Rýchl', 'y'], ['Dunajsk', 'y'], ['Hradn', 'y'], ['Staromestsk', 'y'], ['Petržalsk', 'y'], ['Divok', 'y'],
  ['Tich', 'y'], ['Nočn', 'y'], ['Kofolov', 'y'], ['Šikovn', 'y'], ['Červen', 'y'], ['Modr', 'y'], ['Zlat', 'y'],
];

const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

export function randomNick(): string {
  const female = Math.random() < 0.45;
  const [stem, kind] = pick(ADJ);
  const adj = stem + (kind === 'y' ? (female ? 'á' : 'ý') : female ? 'ia' : 'i');
  const name = pick(female ? FEMALE : MALE);
  const n = `${adj} ${name}`;
  return n.length <= 16 ? n : name + ' ' + Math.floor(10 + Math.random() * 90);
}
