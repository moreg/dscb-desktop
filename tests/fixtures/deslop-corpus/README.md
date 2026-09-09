# 去 AI 味语料基线

这个目录是 deslop 的**标尺**。没有它，「加一条规则 / 调一个阈值」是拍脑袋；
有了它，`tests/deslop-corpus.test.ts` 会直接告诉你改动让检测变准了还是变差了。

## 怎么放

```
tests/fixtures/deslop-corpus/
  human/   ← 人写的稿子，每篇一个 .txt 或 .md
  ai/      ← AI 写的稿子，每篇一个 .txt 或 .md
```

跑：

```bash
npm run deslop:corpus
```

默认只报告不判定。要让它在分离度不达标时真的失败（比如挂到 CI 上）：

```bash
DESLOP_CORPUS_STRICT=1 npm run deslop:corpus
```

每组少于 5 篇时测试自动跳过（只打印一行提示），不会挡住别的开发。

## 放什么（这一步搞错，后面全是错的）

**每篇 ≥ 1500 字。** 更短的稿子句子数不够，三个 CV 指标会返回 null，等于没参与。

**`human/` 必须是没被 AI 碰过的。** 出版小说正文、你自己 2022 年以前的稿、网文精校本都行。
只要是「先让模型写再自己改」的，就不算人写的——那是 AI 稿加了一层人类涂层，会把基线往中间拖。

**`ai/` 必须是未经去 AI 味处理的原始生成稿。** 这是最容易搞错的一点：
如果你放的是已经跑过 deslop 的稿子，标定出来的阈值会偏松，等于让系统拿自己的输出当标准答案。

**两组要配平。** 如果 `human/` 全是纯文学、`ai/` 全是网文，测出来分开的是题材，不是 AI 味。
尽量让两组的题材、人称、篇幅、对白比例接近——不然指标会去拟合题材差异。

**对照组值得单独留一份。** 建议再放几篇「AI 写的、但已经人工深度改过」的稿子，
放进 `human/` 之前先单独跑一次：如果系统把它判成 human，说明改到位了；判成 ai，说明还差。

## 结构体检评测（要花钱，默认关）

上面那份报告量的是**确定性判据**（词表 + 三个 CV），不调 LLM。
结构体检判定器准不准，是另一件事，得单独量：

判据很朴素——**人写的稿子应该比 AI 稿被报出更少的结构问题**。
如果两组数量差不多，说明判定器在编，它的清单不能信。

开启需要两样东西：打开开关，再给一个 provider（不复用 app 里的配置，
那个走 Electron 加密存储，测试进程读不到）。

PowerShell：

```powershell
$env:DESLOP_JUDGE_EVAL="1"
$env:DESLOP_EVAL_BASE_URL="https://api.example.com/v1"
$env:DESLOP_EVAL_MODEL="your-model"
$env:DESLOP_EVAL_API_KEY="sk-..."
npm run deslop:corpus
```

bash：

```bash
DESLOP_JUDGE_EVAL=1 DESLOP_EVAL_BASE_URL=... DESLOP_EVAL_MODEL=... DESLOP_EVAL_API_KEY=... npm run deslop:corpus
```

`DESLOP_EVAL_PROTOCOL` 缺省 `openai`，也可以填 `anthropic` / `openai-responses`。

**走本机 CLI 登录态更省事**（`codex` / `claude` / `grok` / `antigravity`）：
这几个协议不走 HTTP，不需要 baseUrl / model / apiKey，只要本机 CLI 已登录：

```powershell
$env:DESLOP_JUDGE_EVAL="1"
$env:DESLOP_EVAL_PROTOCOL="codex"
npm run deslop:corpus
```

CLI 每次调用要起一个子进程，比 HTTP 慢不少（实测 codex 约 45 秒一篇），
40 篇要走半小时。超时上限设的是 90 分钟。

**成本**：每篇样本至少一次 LLM 调用，超过一万字的样本会按块拆得更多。
40 篇语料就是 40+ 次。走 HTTP provider 是要花钱的；走 CLI 登录态（codex 等）不额外计费，
但要占半小时机器时间。

报告分两部分：总体（每千字报出的问题数，两组的 AUC）和分维度。
分维度那张表最有用——它会告诉你五个维度里哪几条真的有判别力：

- **两组都没报过**：这一维在 prompt 里等于没生效，措辞需要改
- **AUC < 0.6**：这一维对人写和 AI 写一视同仁，考虑从 prompt 里拿掉
- **人写组被报出的条目**：逐条读一遍，那就是判定器的误报样本。
  改 prompt 时拿它们当反例，比凭感觉调措辞有效得多

## 报告怎么看

测试会打印每个指标的 **AUC**（0.5 = 完全分不开，1.0 = 完美分开）和推荐阈值：

- AUC < 0.6：这个指标对你的题材没用，别让它参与 `classify`
- AUC 0.6–0.75：有信号，可以作为多信号投票里的一票
- AUC > 0.8：可以单独当判据

推荐阈值是让两组分开得最好的那个切点。拿到之后回填到
`src/main/data/deslop/check-uniformity.ts` 的 `UNIFORMITY_THRESHOLDS`。

报告最后一段是 `classify` 的实际混淆矩阵——**这才是最终要看的数**，
单个指标 AUC 再好，整体判档不准也没用。

## 为什么样本文件不进 git

同目录的 `.gitignore` 排除了所有 `.txt` / `.md`（README 除外）：
语料里多半是有版权的小说正文，不该提交到仓库。
换机器时自己带一份，或者在团队内部另找地方同步。
