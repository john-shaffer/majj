// Minimal test runner for the extension host; the suite is small enough that
// it doesn't need mocha.

type TestFn = () => Promise<void> | void;

const tests: { name: string; fn: TestFn }[] = [];

export function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

export async function run(): Promise<void> {
  require("./grammar.test");
  require("./status.test");
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n${e instanceof Error ? e.stack : e}`);
    }
  }
  console.log(`${tests.length - failed} passed, ${failed} failed`);
  if (failed) {
    throw new Error(`${failed} test(s) failed`);
  }
}
