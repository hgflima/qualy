/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/__tests__"],
  collectCoverageFrom: ["src/**/*.ts"],
  coverageThreshold: {
    global: {
      lines: 60,
    },
  },
};
