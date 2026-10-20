export const DEFAULT_TEST_DATABASE_URL = "postgres://localhost:5432/summit_air_test";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  // Guard against wiping a real database: the name must contain "test".
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run tests against database "${dbName}": name must contain "test".`);
  }
  return url;
}
