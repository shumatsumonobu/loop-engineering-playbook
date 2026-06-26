const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    // globals: true でテスト API（describe/it/expect）をランナーが各ファイルに注入する。
    // CommonJS プロジェクト（type:commonjs）で ESM import すると "vitest" が稀に二重インスタンス化され、
    // describe 呼び出し時に runner.config が undefined になる flaky を防ぐ。
    globals: true,
    coverage: {
      provider: "v8",
      // npm run test:coverage で閾値割れ＝exit 非0。verifier がカバレッジ80%を客観的に強制できる。
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
