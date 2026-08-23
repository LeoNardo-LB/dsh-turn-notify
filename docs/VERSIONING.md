# 版本与发版规则（三阶段状态机）

本仓库所有版本号遵循固定的三阶段递进规则，由 `scripts/version.sh` 强制执行——
非法跳转（如 dev 直接发正式版）会被脚本拒绝。

## 版本号形态

| 阶段 | 格式 | 性质 | 示例 |
|---|---|---|---|
| 开发版 | `X.Y.Z-dev.n` | 预览 | `1.0.2-dev.1`、`1.0.2-dev.5` |
| 测试版 | `X.Y.Z-beta` | 预览（无序号） | `1.0.2-beta` |
| 正式版 | `X.Y.Z` | 发布（无后缀） | `1.0.2` |

**核心规则**：一个版本号的完整生命周期必须依次走过
`dev.n → beta → 正式版`，且正式版与它的 dev/beta 同号。
开发版与测试版均为预览版本，不代表稳定性承诺。

## 状态机（合法转移）

```
                      dev（新周期，默认 patch）
        ┌──────────────────────────────────────────┐
        │                                          ▼
   正式版 X.Y.Z                          X.(Y+?).(Z+?)-dev.1 ──┐
        ▲                                           ▲        │ dev（迭代）
        │                                           │        ▼
   正式版 X.Y.Z' ◄── stable ── X.Y.Z'-beta ◄── beta ── X.Y.Z'-dev.n
                                   │                        ▲
                                   │ beta 回炉（测出问题）    │
                                   └────────────────────────┘
```

- **正式版 → dev**：开启新周期。版本号 = 上个正式版按变更幅度递进
  （默认 patch +0.0.1；特性级可 `--minor`；破坏性 `--major`），
  序号从 `dev.1` 开始。**这个周期号就是将来的正式版号。**
- **dev.n → dev.n+1**：同周期内任意多轮开发迭代。
- **dev.n → beta**：同号进入测试。
- **beta → dev.n+1**：测试发现问题时回炉修复（序号从 git 标签历史
  推断续接），修完必须再次经过 beta。
- **dev/beta --minor/--major → 新周期**：开发中途发现变更幅度定错了，
  可带显式 scope 放弃当前周期重开；新周期号一律以**最近正式版标签**
  为基点计算（正是"上个正式版 + 0.0.1"公式的直接落实）。
- **beta → 正式版**：同号去掉后缀，即正式发布。
- 其余任何跳转（正式版直接发 beta、beta 直接再 beta、跳过 beta
  发正式版……）均为非法，脚本直接报错。

## 示例（对应用户约定）

上个正式版 `1.0.1`，做一个新特性：

```bash
scripts/version.sh dev            # 1.0.1 → 1.0.2-dev.1（周期号就此定为 1.0.2）
# ……开发、修改、再迭代
scripts/version.sh dev            # 1.0.2-dev.1 → 1.0.2-dev.2
scripts/version.sh beta           # 1.0.2-dev.2 → 1.0.2-beta
# ……测试发现问题，回炉
scripts/version.sh dev            # 1.0.2-beta → 1.0.2-dev.3（序号从标签历史续接）
scripts/version.sh beta           # 1.0.2-dev.3 → 1.0.2-beta
scripts/version.sh stable         # 1.0.2-beta → 1.0.2（正式发布）
```

## 脚本用法

```bash
scripts/version.sh current                  # 查看当前版本与阶段
scripts/version.sh dev [--minor|--major]    # 进入/迭代开发版
scripts/version.sh beta                     # 进入测试版
scripts/version.sh stable                   # 发布正式版
scripts/version.sh check                    # 校验版本格式与标签一致性
```

选项（放在子命令之后）：

- `--dry-run`：只打印将执行的动作，不落盘；
- `--no-git`：只改 `package.json`，不 commit / 不打 tag；
- `--push`：commit + tag 后推送（main 与标签）——正式发布推荐带上。

每次升版脚本自动完成：改 `package.json` → `chore(release): <版本>`
提交 → 打 `v<版本>` 标签。预览版标签（`v1.0.2-beta` 等）同样是
git tag / npm 语义下的预发布标识。

标签是状态的组成部分：beta 回炉的序号续接、re-scope 的新周期号都从
git 标签历史推断。`--no-git` 模式只改 `package.json` 不打标签，
适用于本地试验；正式流程不要用它。

CI 保障：每次 push 运行 `scripts/version.sh check`，非法版本格式
（不符合三阶段形态）直接挂 CI。

## 历史说明

本规则自 v0.2.1 之后开始执行；此前的 `0.1.0`–`0.2.1` 均按无后缀
（正式版形态）发布，依此为基线，下一个开发周期将从
`0.2.2-dev.1`（或特性级的 `0.3.0-dev.1`）开始。
