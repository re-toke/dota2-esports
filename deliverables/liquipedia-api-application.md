# Liquipedia API Key 申请指引

## 申请渠道（官方确认 · 2026-08-20 实测更新）

根据 Liquipedia 官方条款页（api-terms-of-use）与 2026-08-20 实际回邮确认：

| 渠道 | 地址 | 说明 |
|------|------|------|
| **首选 · 官网申请表单** | https://liquipedia.net/api | LPDB API 专页，**含申请表单提交入口**（form submission）+ 定价（含 free tier 免费档）。这是官方指引的正式通道 |
| **咨询 · Discord** | Liquipedia Discord **#api-help** 频道 | 官方回邮原文：「visit our #api-help channel on our Liquipedia Discord for further assistance」 |
| 邮件 `contact@liquipedia.net` | 通用联系邮箱 | **注意**：直接发邮件通常只会被回信重定向到上面的表单，不就地发 key。不要把它当首选通道 |

**结论**：LiquipediaDB API（v3）走 **官网表单申请 + 人工审批**，含免费档（free tier，对个人小程序足够：60 req/hour + 客户端 5min 缓存远低于上限）。审批通过后会获得 Dashboard 访问权限，在那里生成和管理 API key。审批周期通常 1-3 工作日。

---

## 申请邮件模板（直接复制发送）

**收件人**：`contact@liquipedia.net`

**主题**：
```
API Access Request - DOTA2 Esports Hub (WeChat Mini Program)
```

**正文**（把 `[你的邮箱]` 和 `[你的名字/昵称]` 替换成真实信息）：

```
Hello Liquipedia Team,

I'm writing to request access to the LiquipediaDB API (v3) for my project.

## Project Information

- **Application name**: DOTA2赛事通 (DOTA2 Esports Hub)
- **Application type**: WeChat Mini Program (微信小程序)
- **Target audience**: Chinese-speaking DOTA2 esports fans
- **Platform**: WeChat ecosystem (iOS / Android / Web, via WeChat client)
- **Website / Store page**: [If available, fill in; otherwise write "In development, not yet published"]

## Intended Use of Liquipedia Data

The mini program aggregates publicly available DOTA2 esports information to
display to Chinese users:

1. **Tournament schedules** — upcoming, live, and recently completed matches
   for major tournaments (The International, ESL, Riyadh Masters, etc.)
2. **Match results** — scores, BO formats, team matchups
3. **Tournament metadata** — dates, formats, participant teams

Specifically, I need the `match` table to fetch scheduled and live matches
filtered by `tournament` pagename (e.g., `The_International/2026`), since
the MediaWiki action API no longer exposes Matchlist bracket data in
wikitext form for 2026 tournaments.

## Technical Details

- **Data source**: LiquipediaDB API v3 (`https://api.liquipedia.net/api/v3`)
- **Wiki scope**: `dota2` only
- **Expected request volume**: < 60 requests / hour (well within your rate limit)
- **Caching strategy**: Results cached server-side for as long as reasonable
  (match data: 5 min; tournament metadata: 24 h), per your ToS
- **Attribution**: Liquipedia will be credited as the data source in the app's
  "About" page and wherever match data is displayed, per CC-BY-SA 3.0
- **User-Agent header**: `DOTA2-Esports-Hub/1.0 (WeChat Mini Program; contact: [你的邮箱])`
- **HTTP client**: Node.js `got`, gzip-enabled, connection-reuse

## Compliance Commitments

I have read and will fully comply with the Liquipedia API Terms of Use
(https://liquipedia.net/api-terms-of-use):

- Rate limit ≤ 60 requests / hour
- Cache results to avoid repeated identical requests
- Attribute Liquipedia as data source (CC-BY-SA 3.0)
- No automated access to non-API endpoints (HTML pages)
- Will not share the API key with third parties

## Contact

- **Name**: [你的名字/昵称]
- **Email**: [你的邮箱]
- **Discord** (optional): [如果有 Discord 账号可填，方便他们即时联系]

Thank you for considering this request. I'm happy to provide any additional
information you may need.

Best regards,
[你的名字/昵称]
```

---

## 发送后预期流程

1. **提交表单**：打开 https://liquipedia.net/api，填写 LPDB API 申请表单（填写项目信息、wiki 范围选 `dota2`、预计请求量等）并提交
2. **等待回复**：通常 1-3 个工作日（社区反馈不一，可能更快也可能更久）
3. **审批通过**：他们会回复一封邮件，里面包含：
   - Dashboard 访问链接（`https://api.liquipedia.net/dashboard` 或类似）
   - 你的账号激活方式
   - API key 生成指引
4. **登录 Dashboard**：创建账号 → 生成 API key → 复制保存
5. **配置云函数**：把 key 填入云开发控制台的环境变量 `LIQUIPEDIA_API_KEY`（代码框架已准备好，见下文）

---

## 如果邮件 7 天无回复

1. **Discord 跟进**：加入 https://liquipedia.net/discord，在 `#api` 或 `#help` 频道礼貌跟进
2. **补充信息**：如果他们要求更多细节（如应用截图、预计上线时间等），及时提供
3. **并行备选**：在等待期间可以先用「临时方案」（RECENT 数据正常 + LIVE/UPCOMING 显示「赛程暂不可用」提示）

---

## 临时方案（等待 key 期间的兜底）

代码框架已设计为**优雅降级**：
- 云函数环境变量 `LIQUIPEDIA_API_KEY` **未配置** → 自动回退到现有 wikitext 解析路径（对旧结构赛事仍有效）
- 云函数环境变量 `LIQUIPEDIA_API_KEY` **已配置** → v3 API 优先，失败时回退

所以你可以在**等待 key 的同时先部署代码框架**，key 下来后只需在云开发控制台填入环境变量即可激活，无需重新部署。
