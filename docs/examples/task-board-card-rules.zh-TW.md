# 任務看板的卡片規則（systemPrompt）

[English](task-board-card-rules.md)

怎麼填任務看板的卡片，讓卡片本身就說得清楚這份工作：要做什麼、怎樣算完成、目前做到哪裡。把這份規則放進 agent 的
`systemPrompt`；再打開 `board_cards_strict`，看板就會直接拒絕不符合主要規則的卡片，而不只是提醒。

1. 把 [card-rules.zh-TW.md](task-board-card-rules/card-rules.zh-TW.md)（或[英文版](task-board-card-rules/card-rules.md)）
   複製到 fleet 讀得到的地方，例如 `~/.agend/card-rules.md`。
2. 在 fleet.yaml 把它加進 agent 的 `systemPrompt`：

   ```yaml
   defaults:
     systemPrompt: "file:~/.agend/card-rules.md"
     board_cards_strict: true        # 選用：由看板強制執行
   instances:
     reviewer:
       systemPrompt: "file:prompts/reviewer.md, file:~/.agend/card-rules.md"   # 自己的 prompt 會取代預設值：兩個都要寫
       board_cards_strict: false     # 每次審查都會替自己開一張卡
   ```

   有自己 `systemPrompt` 的 agent 不會拿到預設值的那一份；兩個部分都要列出來，用逗號隔開
   （[systemPrompt 檔案路徑](../features.zh-TW.md#systemprompt-檔案路徑-systemprompt-file-paths)）。
3. 重新啟動 agent（prompt 在啟動時讀取）。`board_cards_strict` 則立即生效。

`board_cards_strict` 會強制的事（[設定說明](../configuration.zh-TW.md)）：受它約束的 agent 開卡一定要有目標和驗收項目；
缺這些或 size 是 L 的卡不能開工；還有驗收項目沒勾的卡不能完成（寫理由也不行）；別人設的驗收項目必須保留。其餘的
由規則檔說明：怎樣算好的驗收項目、隨時更新 `state`、log，以及 result 要寫什麼。
