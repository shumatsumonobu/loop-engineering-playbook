// registerRouter の仕様を検証するテスト（実装はまだ無いので落ちるのが正しい）
import { test, expect } from "vitest";
import express from "express";
import request from "supertest";
import { registerRouter } from "../src/register.js";

// テストごとに独立した app / メモリ状態を作る
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(registerRouter);
  return app;
}

test("正しいメールは 201 と { email } を返す", async () => {
  const app = makeApp();
  const res = await request(app).post("/register").send({ email: "user@example.com" });
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ email: "user@example.com" });
});

// 形式不正の全パターン
const invalidCases = [
  ["空文字", ""],
  ["@が無い", "abc"],
  ["@が2つ以上ある", "a@b@c"],
  ["空白を含む", "a b@example.com"],
  ["@の前が空", "@example.com"],
  ["@の後が空", "user@"],
];

for (const [label, email] of invalidCases) {
  test(`形式不正（${label}）は 400 と非空の error を返す`, async () => {
    const app = makeApp();
    const res = await request(app).post("/register").send({ email });
    expect(res.status).toBe(400);
    // 本文の error は非空の文字列であること（"" に壊されたら落ちる）
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
    expect(res.body.error).toMatch(/invalid/i);
  });
}

test("登録済みのメールは 409 と非空の error を返す", async () => {
  const app = makeApp();
  const first = await request(app).post("/register").send({ email: "dup@example.com" });
  expect(first.status).toBe(201);

  const res = await request(app).post("/register").send({ email: "dup@example.com" });
  expect(res.status).toBe(409);
  // 本文の error は非空の文字列であること（"" に壊されたら落ちる）
  expect(typeof res.body.error).toBe("string");
  expect(res.body.error.length).toBeGreaterThan(0);
  expect(res.body.error).toMatch(/regist/i);
});
