import { add, average, divide, multiply, subtract, sum } from "../src/math";

describe("math", () => {
  it("adds", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("subtracts", () => {
    expect(subtract(5, 2)).toBe(3);
  });

  it("multiplies", () => {
    expect(multiply(4, 3)).toBe(12);
  });

  it("divides", () => {
    expect(divide(10, 2)).toBe(5);
  });

  it("throws on division by zero", () => {
    expect(() => divide(1, 0)).toThrow("Division by zero");
  });

  it("sums an array", () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });

  it("averages an array", () => {
    expect(average([2, 4, 6])).toBe(4);
  });

  it("averages empty array as zero", () => {
    expect(average([])).toBe(0);
  });
});
