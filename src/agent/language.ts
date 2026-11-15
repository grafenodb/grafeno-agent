/**
 * The language a message is written in, by its common words: enough to
 * tell the model which language to answer in, since what it reads besides
 * the message (memory, files, tool output) is often in another one.
 */

interface LanguageWords {
  readonly name: string;
  readonly words: ReadonlySet<string>;
  /** Letters or marks only this language uses among these. */
  readonly marks?: RegExp;
}

const words = (list: string) => new Set(list.split(" "));

const LANGUAGES: readonly LanguageWords[] = [
  {
    name: "English",
    words: words(
      "the and is are was were be to of in on for with that this it you your what how why can could would should do does did not have has please make create add fix write file folder use i we my me there here which when where",
    ),
  },
  {
    name: "Spanish",
    words: words(
      "el la los las es son está están de del que en un una para con por por qué cómo como qué cuál cuando dónde no sí si puedes podrías quiero crea crear agrega añade arregla escribe archivo carpeta usa yo mi me hay esto eso ahora también pero muy más ya se lo le al hacer haz dime",
    ),
    marks: /[ñ¿¡]/i,
  },
  {
    name: "Portuguese",
    words: words(
      "o a os as é são está estão de do da que em um uma para com por não sim você pode quero crie criar adicione arquivo pasta use eu meu minha isso agora também mas muito mais já faça",
    ),
    marks: /[ãõç]/i,
  },
  {
    name: "French",
    words: words(
      "le la les est sont de du des que en un une pour avec par pas oui vous tu peux veux crée créer ajoute fichier dossier utilise je mon ma ce cette maintenant aussi mais très plus déjà fais",
    ),
    marks: /[èêàùœ]/i,
  },
  {
    name: "German",
    words: words(
      "der die das ist sind und zu von in ein eine für mit nicht ja du sie kannst bitte erstelle füge datei ordner benutze ich mein dies jetzt auch aber sehr mehr schon mach",
    ),
    marks: /[äöüß]/i,
  },
  {
    name: "Italian",
    words: words(
      "il lo la gli le è sono di del che in un una per con non sì puoi voglio crea creare aggiungi file cartella usa io mio questo ora anche ma molto più già fai",
    ),
  },
];

/** The language of a message, or nothing when it is too short or unclear to say. */
export function detectLanguage(text: string): string | undefined {
  const tokens = text
    .toLowerCase()
    // Code, paths and URLs say nothing about the language spoken.
    .replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|[\w./\\-]+\.[a-z]{1,4}\b/g, " ")
    .split(/[^\p{L}]+/u)
    .filter((token) => token.length > 0);
  if (tokens.length < 2) return undefined;
  let best: { name: string; score: number } | undefined;
  let second = 0;
  for (const language of LANGUAGES) {
    let score = tokens.filter((token) => language.words.has(token)).length;
    if (language.marks?.test(text)) score += 2;
    if (!best || score > best.score) {
      second = best?.score ?? 0;
      best = { name: language.name, score };
    } else if (score > second) {
      second = score;
    }
  }
  if (!best || best.score < 2 || best.score === second) return undefined;
  return best.name;
}

/** The line that tells the model which language to answer in. */
export function languageNote(language: string): string {
  return `[The user writes in ${language}: answer in ${language}, whatever the language of the memory, files or tool output above.]`;
}

/**
 * The message as prepared (memory first), with the language note just
 * before the user's own words, where the model reads it last.
 */
export function withLanguage(
  prepared: string,
  message: string,
  language: string | undefined,
): string {
  if (!language) return prepared;
  const before = prepared.endsWith(message)
    ? prepared.slice(0, prepared.length - message.length)
    : `${prepared}\n\n`;
  return `${before}${languageNote(language)}\n\n${message}`;
}
