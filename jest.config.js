/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  // Tests are excluded from the tsc build (see tsconfig "exclude"); ts-jest
  // transforms them on the fly.
  transform: {
    "^.+\\.ts$": ["ts-jest", {}],
  },
};
