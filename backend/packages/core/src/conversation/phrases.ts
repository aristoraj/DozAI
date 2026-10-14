// The small fixed phrases the conversation runner adds around a question: a thank-you after an answer, a friendlier line when
// a reply was not understood, and a line when the participant asks what a question means. They are plain wording written here,
// never produced by a model, so the rule "a model never writes to a participant" still holds.
//
// Which phrase is used depends only on how many messages were sent so far, so the same conversation always reads the same and
// two neighbouring messages never use the same words. Hindi is written in English letters, without gendered verbs.
export type Lang = "en" | "hi";
export const langOf = (language: string | undefined): Lang => (language === "hi" ? "hi" : "en");

const pick = <T,>(list: T[], n: number): T => list[n % list.length]!;

const THANKS: Record<Lang, string[]> = {
  en: ["Thank you.", "Got it, thanks.", "Noted, thank you.", "Okay, thanks."],
  hi: ["Dhanyavaad.", "Theek hai, shukriya.", "Shukriya."],
};
const THANKS_SEVERAL: Record<Lang, string[]> = {
  en: ["Thank you, that covers a few of our questions.", "Thanks, I have noted all of that."],
  hi: ["Dhanyavaad, aapne kai sawaalon ka jawaab de diya.", "Shukriya, yeh sab note kar liya."],
};

/** A thank-you before the next question. More than one answer saved from a single reply gets a different line. */
export const thanks = (lang: Lang, answers: number, n: number): string => pick((answers > 1 ? THANKS_SEVERAL : THANKS)[lang], n);

/**
 * What to add when a reply was not understood and the question is asked again. The first time is gentle and shows both ways to
 * reply; the second is plainer and tells them what we need. (The instrument's own "could not understand" line comes first.)
 */
export function reaskHint(lang: Lang, type: "choice" | "yesno" | "text", attempt: number): string {
  const first = attempt <= 1;
  if (type === "text") {
    return lang === "hi"
      ? (first ? "Aap bas chhote mein likh dijiye." : "Koi baat nahi. Bas naam ya jawaab chhote mein likh dijiye.")
      : (first ? "Just type it in a few words." : "No problem. Please type just the name or the answer, in a few words.");
  }
  return lang === "hi"
    ? (first ? "Aap number bhej sakte hain, ya apne shabdon mein bata sakte hain." : "Koi baat nahi. Neeche diye number mein se ek bhej dijiye.")
    : (first ? "You can reply with the number, or say it in your own words." : "No problem. Please reply with one of the numbers below.");
}

/** What to say when the participant asks what a question means or asks to hear it again. */
export function clarifyLine(lang: Lang, type: "choice" | "yesno" | "text", n: number): string {
  if (type === "text") {
    return lang === "hi"
      ? pick(["Zaroor. Aap bas apne shabdon mein likh dijiye.", "Theek hai, dobara poochta hoon. Chhote mein likh dijiye."], n)
      : pick(["Of course. Just type your answer in your own words.", "Sure, here it is again. A few words is enough."], n);
  }
  return lang === "hi"
    ? pick(["Zaroor. Jo sabse sahi lage woh chuniye. Number bhej sakte hain ya apne shabdon mein bata sakte hain.", "Theek hai, dobara poochta hoon. Jo sabse sahi baithe woh bataiye."], n)
    : pick(["Of course. Pick the one that fits you best. You can reply with its number or say it in your own words.", "Sure, here it is again. Choose whichever is closest to your situation, by number or in your own words."], n);
}
