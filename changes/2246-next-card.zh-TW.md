---
section: Added
---
- **agent 做完一張卡時，會被告知下一張要開始哪張。** agent 停下手上的卡（做完、送去確認、標成卡住或取消）時，`task` 工具的回應會指出它下一張可以開始的卡（`next: M-14 "…" (high) is ready — start it: move M-14 to claimed; 2 more ready (task mine)`），依 `task mine` 的順序：先看優先度，自己的卡優先於它協調的主任務底下沒人負責的子任務。它忙碌時被派的卡，不用再等它剛好去看才會被處理。它手上進行中的卡還在上限時不會提示。
