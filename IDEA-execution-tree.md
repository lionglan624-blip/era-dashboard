# Idea: Execution Tree View

## Concept

Dashboard に「Execution Flow」ビューを追加。依存関係をツリー表示し、上から順にボタンを押すだけで開発が進むガイド。

## Current State (Grid View)

Phase/Layer 別のフラットなタイルグリッド。依存は各タイルの `Deps:` チップで表示。

## Proposed: Execution Flow View

```
F634 ✓
 └─ F638 [PROPOSED] → [Run FL]     ← 今押せる
 └─ F643 ✓
     └─ F674 [PROPOSED] → [Run FL] ← 今押せる
 └─ F671 [DRAFT] → [Run FC]        ← 今押せる
 └─ F636-F642 ✓
     └─ F644 [DRAFT] → [Run FC]    ← 今押せる
         └─ F645 [DRAFT]           ← F644待ち (greyed out)
             └─ F646 [DRAFT]       ← F645待ち
                 └─ F647 [DRAFT]   ← F646待ち
```

### Design Points

- **上から順にポチポチ**: ブロックされていないものだけボタンが有効。上から押すだけで進む
- **完了ノードは折り畳み**: ✓ 表示、子が全完了なら非表示も可
- **同一ノードの重複OK**: DAG を木に展開。同じ Feature が複数親の子として出てもよい
- **ビュー切替**: Grid View / Execution Flow のタブ切替。グリッドは全体俯瞰、ツリーは「次何やる？」

### Data Source

- 各 feature-{ID}.md の Dependencies テーブルから Predecessor のみ抽出
- バックエンドは既に `dependencies` 配列を返している
- ルートノード = 依存なし or 全依存が解決済み

### Considerations

- Active Features が 10-20 個なら見やすい。大量になったら折り畳みが必要
- 範囲表記 (`F636-F643`) の展開ロジックが必要
- フロントエンドのみの変更。バックエンドは既存 API で十分
