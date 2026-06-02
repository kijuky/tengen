import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The integration suites each drive a real package-manager CLI (gradle/maven
    // JVMs, composer, bundler, ...) against live registries. Running the files in
    // parallel makes those heavyweight processes contend for CPU and network, so
    // a gradle resolve that takes ~9s alone balloons past the 15s spawn timeout
    // (SIGTERM → exit 143) and a ~6s composer install in setup overruns the 10s
    // hook budget. Serialize the files so each CLI runs at its natural speed;
    // this removes the contention at its root instead of padding per-test budgets.
    fileParallelism: false,
  },
});
