import { average, sum } from "./math.ts";
import { capitalize, slugify } from "./string-utils.ts";

export interface Report {
  readonly title: string;
  readonly slug: string;
  readonly total: number;
  readonly mean: number;
}

export function buildReport(name: string, samples: readonly number[]): Report {
  return {
    title: capitalize(name),
    slug: slugify(name),
    total: sum(samples),
    mean: average(samples),
  };
}
