# git worktree の使い方

## 何が嬉しいか

- 1つのリポジトリから複数のブランチを別ディレクトリで同時に開ける
- stash や commit で作業を中断せずにブランチを切り替えられる

## 使い方

```bash
git worktree add ../hotfix hotfix
```

## 片付け方

```bash
git worktree remove --force ../hotfix
```

## 注意点

[git worktree 公式ドキュメント](https://git-scm.com/docs/git-worktree)
