// 人が用意した緑のベース（ハーネスの前提: 最初に全テスト緑）
import { test, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

test("GET /health は 200 と status: ok を返す", async () => {
  const res = await request(app).get("/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
});
