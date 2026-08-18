// メールアドレスを登録する Express ルーター（メモリ上に保持する）
import express from "express";

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export const registerRouter = express.Router();

const registered = new Set();

registerRouter.post("/register", (req, res) => {
  const { email } = req.body;

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "invalid email" });
  }

  if (registered.has(email)) {
    return res.status(409).json({ error: "already registered" });
  }

  registered.add(email);
  return res.status(201).json({ email });
});
