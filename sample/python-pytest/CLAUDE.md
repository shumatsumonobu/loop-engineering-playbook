# このプロジェクトの規約

- 実装は `src/` の Python、テストは `tests/` の pytest
- テストは `npm test`（= `python -m pytest -q`）で動く形式で書く
- テストからの import は `from src.<module> import <name>`（`pytest.ini` の `pythonpath = .` が効く）
- 既存のファイルは変更しない
