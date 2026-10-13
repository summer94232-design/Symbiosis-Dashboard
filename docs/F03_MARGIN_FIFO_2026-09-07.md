# F03：融資 FIFO 本金一致性（2026-09-07）

還款估算、calcPositions 持倉本金、aggregateMarginPositions／aggregateMarginDebt 共用 MarginLedger。

- 依股票與 brokerAccount 隔離批次，使用既有日期／createdAt／sequence／ID 排序。
- 買入優先採 marginAmount，缺少時沿用原融資成數估算。
- 賣出按 FIFO 扣股數；本金採記錄的 marginPrincipal，缺少時採 FIFO 估算，利息不扣本金。
- 歷史 CSV 的本金 0 占位仍採估算；已記錄為全數利息的償還則尊重本金 0。
- 人工本金先抵最舊借款，後續估算使用調整後餘額。已售完股數仍有未還本金時保留負債，不自動銷帳；本金超過帳戶總借款時明確拋錯。
- 融資批次 marginCost 反映 FIFO 剩餘批次原始市值；一般持倉及交易已實現損益仍採既有平均成本。
- 舊資料利息合併分攤增加 brokerAccount 隔離。

驗證：新增 9 項回歸測試；npm test 共 155 項通過，包含原有元大對帳 fixture。涵蓋多買價、部分／全部出售、實際買入本金、人工還款、帳戶隔離、零股本金四捨五入、同日順序、每日持倉與 beforeTrade。修改檔案 ESLint 通過。

本次只修本機計算程式，未部署、未修改正式交易或歷史資產快照。既存快照不會因此自動修正。本測試不代表已用使用者全部實際券商月結單核對。
