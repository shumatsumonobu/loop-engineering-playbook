// 人が用意した土台、Express アプリ本体（テストから import するため listen しない）
import express from "express";

export const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));
