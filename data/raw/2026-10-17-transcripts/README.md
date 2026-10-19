# 2026-10-17 会话日志转录

**这不是机器产物。** 这里是从会话日志里**抄下来**的关键原始输出——当时那三个竞速探针只 `print`、
没有落盘，所以磁盘上原本没有这些结果。每一份都在文件头标注了：来源 job、脚本、采集时间、以及
转录时做了什么压缩。**要用之前请按 `docs/EVIDENCE.md` 的复现命令重跑一遍。**

| 文件 | 来源 | 脚本 | 时间（本地） |
| --- | --- | --- | --- |
| `tokenizer-race.txt` | 后台 job `bash-245` | `.scratch/fp-gateway/tokenizer-race.py` | 16:09:39 – 16:25:14 |
| `logprob-race.txt` | 后台 job `bash-247` | `.scratch/fp-gateway/logprob-race.py` | 16:10:30 – 16:50:16 |
| `glitch-battery.txt` | 后台 job `bash-248` | `.scratch/fp-gateway/glitch-battery.py` | 16:13:10 – 16:22:55 |
| `endpoint-survey.txt` | 内联脚本 | （无独立脚本文件） | 约 16:45 |

**为什么仍要保留转录**：它记录了当时的**第一手观测**，可以作为重跑时的对照。
但它的地位低于机器产物：**转录可能抄错、可能压缩过头**，所以任何基于它的结论都应在
Phase 0 重跑确认后再进基线。
