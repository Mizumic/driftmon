## 这个 PR 做了什么

<!-- 一句话说明；关联的 issue 用 "Closes #123" -->

## 改动类型

- [ ] Bug 修复
- [ ] 新功能 / 新通道 / 新判定规则
- [ ] 文档
- [ ] 测试 / CI
- [ ] 重构（不改变行为）

## 验证方式

<!-- 贴关键命令与结果；真实采集请注明端点类型与是否 partial 批次 -->

```bash
npm test
node bin/driftmon.mjs status
```

## 检查清单

- [ ] `npm test` 全过（64 项，离线桩 fetch）
- [ ] 没有提交凭据 / `.env` / 本机绝对路径 / 采集数据
- [ ] 原始层未被修改（append-only）或缺少来源
- [ ] 不存 prompt / 响应正文；key 未进入代码/配置/日志
- [ ] 用户可见行为变化已写入 `CHANGELOG.md`
- [ ] 若改探针组：`probeSetVersion` 已 bump，基线/模板重建说明已更新
