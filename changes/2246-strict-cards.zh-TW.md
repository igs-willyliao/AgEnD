---
section: Added
---
- **嚴格卡片（`board_cards_strict`）與給 agent 的卡片規則。** 設定 `board_cards_strict: true`（單一 agent，或在 `defaults`；預設關閉）後，任務看板會要求 agent 把卡片填完整：開卡（包括 `task` 工具的任務）一定要有目標和驗收項目；缺這些或 size 是 L 的卡不能開工（先拆）；還有驗收項目沒勾的卡不能完成（寫理由也不再算數：做不完的卡要標成卡住並寫出問題）；別人設的驗收項目必須保留。每次拒絕都會說明該怎麼做；人不受這個限制。每次寫入時讀取；agent 的啟動說明從下次啟動起會提到它。另附一份現成的 `systemPrompt`：[卡片規則](examples/task-board-card-rules.zh-TW.md)，告訴 agent 怎麼填卡——目標、可檢查的驗收項目、`state`、log、result。
