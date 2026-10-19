# 本机符号映射表（Symbols）

> 本仓库文档与脚本里**不写本机绝对路径**，一律用 `${符号}` 表示机器相关字段。
> 真实取值放在仓库根目录的 `.local/symbols.env`（gitignored，模板见
> [`symbols.example.env`](symbols.example.env)）；由 agent / 部署者按本表解析后 `source` 使用。
>
> driftmon 本身是「零运行时依赖 + 只读文件契约」，映射表只用于**落地安装与验证**，不是运行依赖。

## 1. 符号表

| 符号 | 含义 | 解析方式（优先级从上到下） | 本机示例 |
| --- | --- | --- | --- |
| `REPO_DIR` | 本仓库根目录 | `git -C <当前目录> rev-parse --show-toplevel` | `~/projects/dsh-drift/driftmon` |
| `DRIFTMON_DIR` | 同 `REPO_DIR`（driftmon 安装/运行目录） | `.local/symbols.env`，默认 `REPO_DIR` | 同左 |
| `DSH_HOME` | DSH 数据目录（插件产物在它下面的 `storages/`） | ① 环境变量 `DSH_HOME` ② `.local/symbols.env` | `~/projects/dsh-0.2.0-rc.2/home` |
| `DSH_PROFILE` | 当前 DSH profile 名 | ① 环境变量 `DSH_PROFILE` ② `.local/symbols.env` | `web` |
| `CONFIG_FILE` | driftmon 配置文件（gitignored；模板 `config.example.json`） | `${DRIFTMON_DIR}/config.json` | `${DRIFTMON_DIR}/config.json` |
| `PLUGIN_STORAGE_DIR` | 被动层插件存储目录（只读） | ① 配置 `plugin.dshHome` + `storages/system-fingerprint` ② `${DSH_HOME}/storages/system-fingerprint` | `${DSH_HOME}/storages/system-fingerprint` |
| `ENDPOINTS_JSON` | 插件端点登记表 v1（只读契约） | `${PLUGIN_STORAGE_DIR}/endpoints.json` | 同左 |
| `PLUGIN_CONFIG_JSON` | 插件只读配置导出 v1（可选契约） | `${PLUGIN_STORAGE_DIR}/config.json` | 同左 |
| `PROBE_SET_FILE` | 冻结探针组定义 | `${DRIFTMON_DIR}/probes/probe-set.json` | 同左 |
| `DATA_DIR` | 原始层目录（append-only，gitignored） | `${DRIFTMON_DIR}/data` | `${DRIFTMON_DIR}/data` |
| `RAW_DIR` | 原始批次（按天 `*.jsonl`） | `${DATA_DIR}/raw` | 同左 |
| `TEMPLATES_DIR` | 已知检查点行为模板 | `${DATA_DIR}/templates` | 同左 |
| `RESULTS_DIR` | 判定层（报告/告警） | `${DRIFTMON_DIR}/results` | 同左 |
| `WATCH_FILE` | 行为告警文件（可被插件展示） | `${RESULTS_DIR}/watch/gray-watch.json` | 同左 |
| `COLLECT_API_KEY_ENV` | 采集凭据的**环境变量名** | 配置 `provider.apiKeyEnv` | `OPENCODE_API_KEY` 或 `DEEPSEEK_API_KEY` |

## 2. `.local/symbols.env`

```bash
mkdir -p .local
cp docs/symbols.example.env .local/symbols.env
set -a; . .local/symbols.env; set +a
```

`.local/` 已被 `.gitignore` 忽略；换机器时重填一份。**不要把真实路径/key 提交进仓库。**

## 3. 解析规则（agent 必读）

1. 先读环境变量（DSH 会话注入 `DSH_HOME` / `DSH_PROFILE`）。
2. 再读 `.local/symbols.env`（覆盖/补齐）。
3. 仍缺的按上表推导；无法推导就**问用户**，不要猜。
4. 报告里只写符号名；需要展示真实值时标注「本机值」，不要写进仓库文件。
5. 自检：`git grep -nE '/home/|/Users/|/srv/'` 不应有业务路径命中（测试/文档中的示例占位除外）。

## 4. 与插件仓库的关系

driftmon 只读插件产物（`${ENDPOINTS_JSON}` 必需、`${PLUGIN_CONFIG_JSON}` 可选）。
不装插件也能单独运行（只是报告里少「端点是否已登记」「当前检查点」这类注释）。
