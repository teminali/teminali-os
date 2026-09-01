#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { BenchmarkValidationError, scoreBenchmark, sha256 } from "./lib/scorer.mjs";

const [, , manifestArg, resultsArg, outputArg] = process.argv;

const verifyReferences = async (references, rootDirectory, label) => {
  const issues = [];
  const root = resolve(rootDirectory);
  for (const reference of references) {
    const absolutePath = resolve(root, reference.path);
    const relativePath = relative(root, absolutePath);
    if (relativePath.startsWith("..") || relativePath === "") {
      issues.push(`${label} ${reference.path} resolves outside its artifact root`);
      continue;
    }
    try {
      const bytes = await readFile(absolutePath);
      const actual = sha256(bytes);
      if (actual !== reference.sha256) issues.push(`${label} ${reference.path} hash mismatch`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "READ_ERROR";
      issues.push(`${label} ${reference.path} could not be read (${code})`);
    }
  }
  return issues;
};

if (!manifestArg || !resultsArg) {
  process.stderr.write("Usage: node benchmark/score.mjs <manifest.json> <results.json> [score-output.json]\n");
  process.exitCode = 2;
} else {
  try {
    const manifestPath = resolve(manifestArg);
    const resultsPath = resolve(resultsArg);
    const [manifestBytes, resultBytes] = await Promise.all([
      readFile(manifestPath),
      readFile(resultsPath),
    ]);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const results = JSON.parse(resultBytes.toString("utf8"));
    const manifestReferences = [
      ...(manifest.contestants ?? []).map((contestant) => contestant.configurationArtifact),
      ...(manifest.tasks ?? []).flatMap((task) => [task.promptArtifact, task.fixtureArtifact, task.evaluatorArtifact]),
    ].filter(Boolean);
    const resultReferences = (results.runs ?? []).flatMap((run) => run.artifacts ?? []);
    const artifactVerificationIssues = [
      ...await verifyReferences(manifestReferences, dirname(manifestPath), "manifest artifact"),
      ...await verifyReferences(resultReferences, dirname(resultsPath), "result artifact"),
    ];
    const score = scoreBenchmark(manifest, results, {
      manifestSha256: sha256(manifestBytes),
      resultSha256: sha256(resultBytes),
      artifactsVerified: artifactVerificationIssues.length === 0,
      artifactVerificationIssues,
    });
    const serialized = `${JSON.stringify(score, null, 2)}\n`;
    if (outputArg) {
      await writeFile(resolve(outputArg), serialized, { flag: "wx" });
      process.stdout.write(`Wrote immutable score artifact ${score.artifactId} to ${resolve(outputArg)}\n`);
    } else {
      process.stdout.write(serialized);
    }
  } catch (error) {
    if (error instanceof BenchmarkValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else if (error instanceof SyntaxError) {
      process.stderr.write(`Invalid JSON: ${error.message}\n`);
      process.exitCode = 1;
    } else if (error && typeof error === "object" && error.code === "EEXIST") {
      process.stderr.write("Refusing to overwrite an existing score artifact. Choose a new output path.\n");
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
