/**
 * Normalizes spelled-out English numbers and currency into numerical digits
 * (e.g. "seventy-six thousand, six hundred and thirty-two dollars and seventy-eight cents" -> "$76,632.78").
 */

const SMALL: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const MULTIPLIERS: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
  trillion: 1_000_000_000_000,
};

export function parseNumberWords(phrase: string): number | null {
  const tokens = phrase
    .toLowerCase()
    .replace(/[-]/g, " ")
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w && w !== "and");

  if (!tokens.length) return null;

  let total = 0;
  let current = 0;

  for (const word of tokens) {
    if (SMALL[word] !== undefined) {
      current += SMALL[word];
    } else if (word === "hundred") {
      current = (current || 1) * 100;
    } else if (MULTIPLIERS[word]) {
      current = (current || 1) * MULTIPLIERS[word];
      total += current;
      current = 0;
    } else {
      return null;
    }
  }

  return total + current;
}

const NUM_WORD =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)";

const NUM_PHRASE = `(?:${NUM_WORD}(?:[\\s,-]+(?:${NUM_WORD}|and))*)`;

const DOLLARS_REGEX = new RegExp(
  `\\b(${NUM_PHRASE})\\s+dollars?(?:\\s+and\\s+(${NUM_PHRASE})\\s+cents?)?\\b`,
  "gi",
);

const EUROS_REGEX = new RegExp(
  `\\b(${NUM_PHRASE})\\s+euros?(?:\\s+and\\s+(${NUM_PHRASE})\\s+cents?)?\\b`,
  "gi",
);

const POUNDS_REGEX = new RegExp(
  `\\b(${NUM_PHRASE})\\s+pounds?(?:\\s+and\\s+(${NUM_PHRASE})\\s+pence)?\\b`,
  "gi",
);

const CENTS_ONLY_REGEX = new RegExp(`\\b(${NUM_PHRASE})\\s+cents?\\b`, "gi");

const PERCENT_REGEX = new RegExp(`\\b(${NUM_PHRASE})\\s+percent\\b`, "gi");

// Matches multi-word numbers that explicitly contain scale words (thousand, million, billion, trillion)
const BIG_NUMBER_REGEX = new RegExp(
  `\\b(${NUM_WORD}(?:[\\s,-]+(?:${NUM_WORD}|and))*[\\s,-]+(?:thousand|million|billion|trillion)(?:[\\s,-]+(?:${NUM_WORD}|and))*)\\b`,
  "gi",
);

/**
 * Replace spelled-out currency, percentages, and large numbers with standard digits.
 */
export function formatSpelledNumbers(text: string): string {
  if (!text) return text;

  // 1. Spelled dollars: "[words] dollars (and [words] cents)?" -> $X.YY
  let res = text.replace(DOLLARS_REGEX, (match, dollarsPart, centsPart) => {
    const dollars = parseNumberWords(dollarsPart);
    if (dollars === null) return match;
    if (centsPart) {
      const cents = parseNumberWords(centsPart);
      if (cents !== null) {
        return `$${dollars.toLocaleString()}.${String(cents).padStart(2, "0")}`;
      }
    }
    return `$${dollars.toLocaleString()}`;
  });

  // 2. Spelled euros: "[words] euros" -> €X
  res = res.replace(EUROS_REGEX, (match, eurosPart, centsPart) => {
    const euros = parseNumberWords(eurosPart);
    if (euros === null) return match;
    if (centsPart) {
      const cents = parseNumberWords(centsPart);
      if (cents !== null) {
        return `€${euros.toLocaleString()}.${String(cents).padStart(2, "0")}`;
      }
    }
    return `€${euros.toLocaleString()}`;
  });

  // 3. Spelled pounds: "[words] pounds" -> £X
  res = res.replace(POUNDS_REGEX, (match, poundsPart, pencePart) => {
    const pounds = parseNumberWords(poundsPart);
    if (pounds === null) return match;
    if (pencePart) {
      const pence = parseNumberWords(pencePart);
      if (pence !== null) {
        return `£${pounds.toLocaleString()}.${String(pence).padStart(2, "0")}`;
      }
    }
    return `£${pounds.toLocaleString()}`;
  });

  // 4. Spelled cents alone: "[words] cents" -> X¢
  res = res.replace(CENTS_ONLY_REGEX, (match, centsPart) => {
    const cents = parseNumberWords(centsPart);
    if (cents === null) return match;
    return `${cents}¢`;
  });

  // 5. Spelled percentages: "[words] percent" -> X%
  res = res.replace(PERCENT_REGEX, (match, numPart) => {
    const num = parseNumberWords(numPart);
    if (num === null) return match;
    return `${num.toLocaleString()}%`;
  });

  // 6. Large numbers with scale words (thousand, million, billion, trillion)
  res = res.replace(BIG_NUMBER_REGEX, (match, numPart) => {
    const num = parseNumberWords(numPart);
    if (num === null) return match;
    return num.toLocaleString();
  });

  // 7. Strip and convert parenthetical stage directions (e.g. "(Hums a gentle melody)", "*sings*")
  res = stripStageDirections(res);

  return res;
}

export function normalizeRealFileNames(text: string): string {
  if (!text) return "";
  return text.replace(
    /(\b[a-zA-Z0-9_-]+)\s+dot\s+(html|css|js|ts|tsx|jsx|json|py|md|txt|sh|yml|yaml|sql|png|jpg|svg|mjs|cjs|wasm|toml|env|lock|xml|csv)\b/gi,
    "$1.$2",
  );
}

const STAGE_DIRECTION_REGEX =
  /[\(\[][^()\[\]]*(?:hum(?:s|ming)?|sing(?:s|ing)?|melody|tune|chuckle|laugh|sigh|gasp|music)[^()\[\]]*[\)\]]|\*[^*]*(?:hum(?:s|ming)?|sing(?:s|ing)?|melody|tune|chuckle|laugh|sigh|music)[^*]*\*/gi;

export function stripStageDirections(text: string): string {
  if (!text) return "";
  const cleaned = text.replace(STAGE_DIRECTION_REGEX, (match) => {
    if (/hum/i.test(match)) return "Mm-mm-mm...";
    if (/sing|melody|tune|music/i.test(match)) return "Nel blu dipinto di blu, volare oh oh...";
    return "";
  });
  return normalizeRealFileNames(cleaned.replace(/\s{2,}/g, " ").trim());
}

