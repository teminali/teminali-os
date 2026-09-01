import { mean } from "./arithmetic.js";

export function summarize(values) {
  return `Average=${mean(values)}`;
}
