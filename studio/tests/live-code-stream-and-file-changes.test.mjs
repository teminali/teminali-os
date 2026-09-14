import assert from "node:assert/strict";
import test from "node:test";
import {
  extractWrittenPathsFromTurn,
  extractStreamingDraft,
} from "../src/services/liveEditProtocol.ts";

test("extractWrittenPathsFromTurn detects shell heredoc target paths", () => {
  const turnText = [
    "I will now create the portfolio website files.",
    "```frontier-run",
    "cat << 'EOF' > index.html",
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<body><h1>Hello</h1></body>",
    "</html>",
    "EOF",
    "cat << 'EOF' > style.css",
    "body { background: #000; color: #fff; }",
    "EOF",
    "```",
  ].join("\n");

  const paths = extractWrittenPathsFromTurn(turnText);
  assert.deepEqual(paths.sort(), ["index.html", "style.css"].sort());
});

test("extractWrittenPathsFromTurn handles diverse heredoc and redirection syntax", () => {
  const turnText = [
    "cat > app.js << 'EOF'",
    "console.log('app');",
    "EOF",
    "tee src/utils.ts << 'EOF'",
    "export const add = (a, b) => a + b;",
    "EOF",
    "echo '# My Project' > README.md",
    "touch assets/logo.svg",
  ].join("\n");

  const paths = extractWrittenPathsFromTurn(turnText);
  assert.ok(paths.includes("app.js"));
  assert.ok(paths.includes("src/utils.ts"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("assets/logo.svg"));
});

test("extractWrittenPathsFromTurn handles markdown code blocks with path attributes", () => {
  const turnText = [
    "Here is the updated markup:",
    "```html path=\"index.html\"",
    "<!DOCTYPE html>",
    "```",
  ].join("\n");

  const paths = extractWrittenPathsFromTurn(turnText);
  assert.deepEqual(paths, ["index.html"]);
});

test("extractStreamingDraft extracts active in-progress heredoc body during streaming", () => {
  const partialTurnText = [
    "Creating the site now...",
    "```frontier-run",
    "cat << 'EOF' > index.html",
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head><title>Portfolio</title></head>",
  ].join("\n");

  const draft = extractStreamingDraft(partialTurnText);
  assert.ok(draft !== null);
  assert.equal(draft.path, "index.html");
  assert.equal(
    draft.content,
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head><title>Portfolio</title></head>",
  );
});

test("extractStreamingDraft advances to the second file when first heredoc completes", () => {
  const partialTurnText = [
    "```frontier-run",
    "cat << 'EOF' > index.html",
    "<!DOCTYPE html>",
    "EOF",
    "cat << 'EOF' > style.css",
    "body {",
    "  margin: 0;",
    "  font-family: sans-serif;",
  ].join("\n");

  const draft = extractStreamingDraft(partialTurnText);
  assert.ok(draft !== null);
  assert.equal(draft.path, "style.css");
  assert.equal(draft.content, "body {\n  margin: 0;\n  font-family: sans-serif;");
});

test("extractStreamingDraft supports streaming markdown code fences", () => {
  const partialTurnText = [
    "Here is your markup:",
    "```html path=\"index.html\"",
    "<!DOCTYPE html>",
    "<html>",
  ].join("\n");

  const draft = extractStreamingDraft(partialTurnText);
  assert.ok(draft !== null);
  assert.equal(draft.path, "index.html");
  assert.equal(draft.content, "<!DOCTYPE html>\n<html>");
});
