# BACKLOG.md

ループが1タスクずつ消化する作業キュー。下のリスト先頭から実装し、終わったら「完了」へ移す。
タスクは手書きでもいいが、`/groom` スキルで対話しながら生成・追記もできる。

## 完了
（まだなし）

## 次にやること
- GET /tasks に ?done=true|false のクエリ対応を追加 — 完了状態でフィルタ（指定なしは全件）。{ data, error } 形式を維持。tests も書く。
- GET /tasks/search?q=... — title の部分一致でタスクを検索し { data: [一致したタスク] } を返す（/:id より前にルート定義）。tests も書く。
- PATCH /tasks/:id/done — タスクの done を反転（トグル）する。存在しない id は404。{ data, error } 形式。tests も書く。

## 調査メモ
（実装中に得た知見をここに残す）
