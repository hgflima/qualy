export function capitalize(input: string): string {
  if (input.length === 0) {
    return input;
  }
  return input[0]!.toUpperCase() + input.slice(1);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return input.slice(0, Math.max(0, max - 1)) + "…";
}

export function repeat(input: string, times: number): string {
  if (times <= 0) {
    return "";
  }
  let out = "";
  for (let i = 0; i < times; i++) {
    out += input;
  }
  return out;
}
