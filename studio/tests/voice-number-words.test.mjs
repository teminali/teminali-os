import test from "node:test";
import assert from "node:assert/strict";
import { formatSpelledNumbers, parseNumberWords } from "../src/services/voice/numberWords.ts";

test("parseNumberWords parses basic and compound numbers", () => {
  assert.equal(parseNumberWords("zero"), 0);
  assert.equal(parseNumberWords("five"), 5);
  assert.equal(parseNumberWords("twenty-five"), 25);
  assert.equal(parseNumberWords("one hundred"), 100);
  assert.equal(parseNumberWords("seventy-six thousand, six hundred and thirty-two"), 76632);
  assert.equal(parseNumberWords("seventy-eight"), 78);
  assert.equal(parseNumberWords("two million"), 2000000);
});

test("formatSpelledNumbers formats dollars and cents into digits", () => {
  const input = "It's approximately seventy-six thousand, six hundred and thirty-two dollars and seventy-eight cents.";
  const expected = "It's approximately $76,632.78.";
  assert.equal(formatSpelledNumbers(input), expected);
});

test("formatSpelledNumbers formats whole dollars into digits", () => {
  const input = "The price is five hundred dollars.";
  const expected = "The price is $500.";
  assert.equal(formatSpelledNumbers(input), expected);
});

test("formatSpelledNumbers formats percentages into digits", () => {
  const input = "It grew by twenty-five percent this year.";
  const expected = "It grew by 25% this year.";
  assert.equal(formatSpelledNumbers(input), expected);
});

test("formatSpelledNumbers formats euros and pounds into digits", () => {
  assert.equal(formatSpelledNumbers("The ticket is fifty euros."), "The ticket is €50.");
  assert.equal(
    formatSpelledNumbers("It costs twenty pounds and fifty pence."),
    "It costs £20.50.",
  );
  assert.equal(formatSpelledNumbers("That is fifty cents."), "That is 50¢.");
});

test("formatSpelledNumbers formats large spelled numbers into comma-separated digits", () => {
  assert.equal(
    formatSpelledNumbers("There are twenty thousand people attending."),
    "There are 20,000 people attending.",
  );
  assert.equal(
    formatSpelledNumbers("The project has two million five hundred thousand users."),
    "The project has 2,500,000 users.",
  );
});

test("formatSpelledNumbers preserves non-number phrases", () => {
  const input = "One second, let me check that one for you.";
  assert.equal(formatSpelledNumbers(input), input);
  assert.equal(formatSpelledNumbers("Wait two minutes please."), "Wait two minutes please.");
});

test("formatSpelledNumbers normalizes spelled-out file names into real file names", () => {
  assert.equal(formatSpelledNumbers("I created index dot html for you."), "I created index.html for you.");
  assert.equal(formatSpelledNumbers("Check style dot css and app dot tsx."), "Check style.css and app.tsx.");
  assert.equal(formatSpelledNumbers("The file is package dot json."), "The file is package.json.");
});


