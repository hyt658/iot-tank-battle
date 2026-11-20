# IoT Tank Battle 服务端

服务端按 [新版协议 plan.md](../../plan.md) 处理 WebSocket 连接、比赛规则和前端静态托管。使用 Python 3.11+、FastAPI 和 Uvicorn，游戏状态保存在单进程内存中。

## 目录结构

```text
server/
├── .gitignore              # 排除本地环境、测试、结果、报告和 AGENTS.md
├── pyproject.toml          # 包声明、依赖范围、启动入口和开发工具配置
├── requirements.lock       # 已验证的运行依赖版本，不包含测试工具
├── README.md
└── app/
    ├── __init__.py         # Python 包标识
    ├── __main__.py         # python -m app / tank-server 启动入口
    ├── config.toml         # 网络默认值、监听地址、端口和运行参数
    ├── config.py           # 加载并严格校验 TOML 配置
    ├── constants.py        # 协议规定的阶段、心跳和比赛数值
    ├── protocol.py         # JSON 消息模型、字段范围和入站角色校验
    ├── errors.py           # 可转换为 error 消息的预期异常
    ├── delivery.py         # 本地发送结果元数据，不进入协议消息
    ├── game.py             # 比赛、射击记录、命中/击杀、复活与弹药规则
    ├── connections.py      # 有序输出队列、超时、心跳时间戳和发送回执
    ├── arena.py            # 连接替换、延迟日志、指令路由和比赛广播
    ├── frontend.py         # 静态文件托管、单页应用回退和 HTTP 路径隔离
    └── main.py             # FastAPI 工厂、URL 登记和路由挂载
```

当前开发工作区另有以下本地文件，均不提交，克隆仓库后不会自动出现：

- `tests/`：协议、状态机、计时边界、广播、慢连接隔离及回环 WebSocket/HTTP 测试。
- `test-results/`：测试结果、覆盖率和启动验证日志。
- `local/` 存放中文总结与待确认事项，本次报告为 `新版协议迁移报告.txt`。
- `AGENTS.md`：本地开发指引。
- `.venv/`：本地 Python 隔离环境。

## 安装与运行

以下命令均在 `server/` 目录执行。需要预装 Python 3.11 或更高版本及 venv 支持；Windows 若没有 `py` 命令，可用相应 Python 可执行文件的完整路径替代。

Windows PowerShell：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock -e .
.\.venv\Scripts\python.exe -m app
```

Linux：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock -e .
.venv/bin/python -m app
```

无需激活虚拟环境，启动命令会读取 `app/config.toml`，默认监听 `0.0.0.0:8000`。使用 Ctrl+C 停止服务。环境激活后也可使用 `tank-server` 启动。

请使用单 worker，确保所有连接共享同一份内存状态。重启进程会回到初始 `lobby`，协议操作由 WebSocket 处理。

## 前端静态托管

在含有新版前端源码的工作区中，从 `web/` 运行 `npm ci` 和 `npm run build`，生成 `web/dist/`。启动后，浏览器从 `http://192.168.2.1:8000/` 打开应用，本机可使用 `http://127.0.0.1:8000/`。前端自身决定玩家页、控制台的 URL 和 404 页面。

服务端按仓库路径定位 `web/dist`。HTTP `GET`、`HEAD` 优先返回实际文件，其他页面路径回退到 `index.html`。`/ws` 和 `/ws/` 下的 HTTP 请求返回 404，WebSocket 升级走独立路由。构建产物未就绪时，页面请求返回英文 503 提示，WebSocket 仍可用于联调。产物就绪后刷新页面即可。

## 网络配置

场地网络使用 SSID **`iot-tank-arena`**，服务器地址为 **`192.168.2.1:8000`**。

修改 **`app/config.toml`** 的 `[network]` 部分，然后重启服务：

| 配置项 | 当前值 | 作用 |
| --- | --- | --- |
| `ssid` | `iot-tank-arena` | 记录、输出场地 Wi-Fi 名称，不会自动创建或修改系统热点。 |
| `arena_host` | `192.168.2.1` | 记录并输出客户端应连接的服务器地址。 |
| `bind_host` | `0.0.0.0` | 服务实际监听的本机地址，`0.0.0.0` 表示所有本机 IPv4 接口。 |
| `port` | `8000` | 服务实际监听端口。 |

热点和网卡 IP 由操作系统设置，客户端使用同一网络地址。可通过环境变量 `TANK_SERVER_CONFIG` 指定另一个 TOML 文件，默认读取包内 `app/config.toml`。

| 客户端 | 当前连接地址 | 服务器首包 |
| --- | --- | --- |
| 坦克 | `ws://192.168.2.1:8000/ws/tank/{tank_id}` | `{"type":"state","enable":true}`，`enable` 按当前比赛状态计算 |
| 玩家 | `ws://192.168.2.1:8000/ws/player/{tank_id}?name=Pilot%20One` | 完整网页 `state` |
| 控制台 | `ws://192.168.2.1:8000/ws/control` | 完整网页 `state` |

连接成功即按 URL 登记并发送首包，客户端可以直接等待 `state`。`tank_id` 是 `1` 或 `2`，玩家名经过 URL 编码。坦克和玩家分别按角色和编号保留最新连接，控制台允许同时连入多个。地址无效关闭码为 `4000`，旧连接被替换时为 `4001`，关闭帧携带英文原因。网页收到这两个码后由客户端显示原因并停止自动重连，坦克仍按协议重连。

服务器每秒发 JSON `ping`，客户端以 `pong` 原样回传 `ts`。服务端写出时给 `ts` 赋单调时钟毫秒值，并用收到有效回传的时间计算每条连接的往返延迟，在 INFO 日志记录 `rtt_ms`。连续 3 秒无入站消息时以 `1001` 关闭连接。

## 已实现的行为

- 有效 JSON 对象带有未知 `type` 时静默忽略。已知消息按角色和字段校验，格式错误或操作被拒绝时返回英文 `error`。
- 断线时只清除该连接仍拥有的绑定，坦克离线时显示 `online=false`，玩家无人接管时显示 `player=null`。替换玩家时取消旧连接尚未发送的控制指令。
- 网页在连接、数据变化和每 200 ms 收到完整状态；坦克在连接及 enable 变化时收到最小状态。各连接的输出队列和发送超时相互隔离。
- 只有控制台能发送 `{"type":"start"}` 和 `{"type":"reset"}`。开局要求处于 `lobby` 且两台坦克和玩家就绪，进入倒计时即清零本局数据，3 秒后进入 180 秒的正式比赛。任意阶段都能重置回 `lobby`。
- 坦克 `state` 只含 `type` 和 `enable`，开局和结束由 `enable` 变化体现。网页 `state` 的每台坦克包含 `protected_ms`，表示剩余保护毫秒数，期满及非保护状态为 0。
- 玩家 drive 只转发给其绑定坦克，字段值保持不变；enable=false 时直接丢弃。健康链路按输入频率转发，输入不变也可按 20 Hz 持续发送。失焦停车指令同样正常转发。
- 每个坦克连接只保留最新一条待发送 drive，本地排队达到 300 ms 的指令不重放；禁用、reset 和玩家断线时清理相应待发驾驶指令。坦克端仍须实现协议规定的 300 ms 无 drive 自动停车。
- fire 校验在线、enable、1 秒冷却及正式比赛弹药；成功许可先预扣 1 发，再向坦克发送带有独立循环编号 0–15 的 fire。练习模式不检查或消耗弹药。
- 射击只有在 WebSocket 写入成功后才可用于命中校验；尚未送达、失败或过期的许可不能造成命中。排队失败、发送失败和取消会退还同一局、同一生命中预扣的弹药，最多恢复到 10。
- hit 的目标由已注册的坦克连接确定。校验阶段、实际发送记录、1 秒窗口、去重、存活和复活保护；不因发射者随后死亡或断线而否定已经发出的有效子弹。每次合法格式的命中判定，以及可识别为 hit 的格式错误，都写入日志。
- 非致命有效命中向目标发送 `{"type":"hurt"}`，向网页送 `hit`。正式赛扣 1 HP，练习只提供反馈。网页的 `hit` 携带 `shooter` 和 `target`，HP 取自随后收到的 `state`。
- HP 到 0 后结算一次击杀和死亡，目标弹药归 0，收到 `{"type":"death"}` 和 `enable=false`。网页只收到该发的 `kill` 和完整状态。
- 死亡 5 秒后满血满弹复活，具有 3 秒保护，坦克收到 `enable=true` 和 `{"type":"respawn"}`。正式比赛中每台活坦克每 3 秒恢复 1 发弹药，上限 10。
- 比赛到时或有效击杀达到 5 时立即结算，击杀多者获胜，平局 `winner=null`。结束后不再自动复活或恢复弹药，等待 reset。客户端不能直接修改分数。

## 计时、广播和事件投递

- 使用单调时钟和单个调度循环处理截止时刻，不为每次死亡或恢复弹药创建独立后台任务。多次轮询不会重复复活或重复补弹；reset 和结束比赛会清理复活、补弹及保护期限。
- 弹药每经过完整 3 秒周期恢复 1 发，落后多个周期时合并计算，上限仍为 10，满弹不积攒额外配额。死亡期间不恢复，复活补满并重新计时。
- 调度延迟时，从实际复活时刻起授予完整 3 秒保护，并重启该坦克的补弹周期。复活与比赛结束同时到期时优先结束。
- 网页在登记成功、可见数据变化以及固定 200 ms 节拍收到完整快照。调度落后时发送当前快照，后续恢复原节拍。实际到达时间受调度和网络影响。
- 同一连接中，尚未写出的连续状态合并为最新完整状态；事件作为顺序边界，后面的状态不能越过前面的事件。坦克只接收最小 enable 状态，正常情况下字段不变不重复发送；旧排队状态被取消时按需重新同步。
- 同一坦克连接保持 `death → enable=false`、`enable=true → respawn` 的顺序，网页保持 `hit/kill → 完整 state`。所有玩家和控制台接收网页命中和击杀反馈，坦克反馈只给相关目标。
- reset 或开始新局会清除未发送的旧局状态和事件。写出前校验坦克反馈的局次、生命和阶段。异步开火失败只通知仍有控制权的原请求者。
- 各连接独立发送，慢观众的状态会合并，当前局仍有效的事件按序排队。可靠消息队列满或写入超时只关闭对应连接，不阻塞其他玩家驾驶。

## 待确认规则与当前处理

以下是协议未完全明确的规则及当前默认处理，后续可根据项目要求调整：

| 事项 | 当前处理 | 主要代码位置 |
| --- | --- | --- |
| URL 校验 | 路径编号只接受 `1` 或 `2`。玩家需提供一个非空 `name`，解码后去掉首尾空白，其他查询项不参与身份识别。 | `main.py` |
| 已知类型校验 | 未知类型忽略，已知但方向、角色或字段不符的消息返回 `error`。`drive` 数值继续使用整数。 | `protocol.py` |
| 命中窗口边界 | 从成功写入 WebSocket 起算，`0 <= age_ms <= 1000` 有效，1001 ms 失效。 | `game.py::hit` |
| 无效 hit 是否消耗子弹记录 | 只有有效命中才消耗；保护期、自击、死亡等拒绝均不消耗，但仍受原 1 秒窗口限制。 | `game.py::hit` |
| 发送失败与冷却 | 未成功发送或排队满 1 秒的许可作废；退还符合条件的弹药，但仍保留本次许可的 1 秒冷却及已经分配的序号，避免快速重用 4 位编号。成功写入后冷却从该写入时刻起算。失败可能产生编号跳号。 | `game.py::_reconcile_deliveries`、`connections.py` |
| 断线对比赛的影响 | 比赛、复活和补弹计时继续，玩家名额释放，可通过原 URL 重新接管。 | `arena.py::_detach`、`game.py::advance` |
| 开局和 reset 清零范围 | 保留现有连接、玩家名字、射击序号和冷却，恢复满血满弹，清零击杀、死亡、计时器及旧射击记录。连续序号降低迟到 hit 被误认作新一发的风险。 | `game.py::_fresh_round`、`arena.py::_dispatch` |
| 弹药恢复周期 | 每台坦克分别从比赛开始或实际复活时刻起，每 3 秒恢复 1 发；满弹不积攒配额，死亡期间不恢复，复活补满并重新计时。 | `game.py::_advance_lives` |
| 延迟复活的保护期 | 从实际处理复活的时刻起算完整 3 秒，比赛时间仍按原截止时刻计算。 | `game.py::_advance_lives` |
| 事件补发和过时反馈 | 事件用于当前在线反馈，没有确认/重试/离线历史回放；过时的坦克生命反馈和旧局事件不重放。重连依靠最新完整 state 恢复界面。 | `arena.py::_send_tank_event`、`connections.py::discard_game_output` |

协议没有发射确认或红外应答，服务端能确认的是 WebSocket 写入成功，不能据此证明物理 IR 已发射；实体红外链路仍需实机验证。语义无效的 hit 只记录拒绝日志，不广播反馈；格式/角色错误仍返回 error。

清理规则针对尚未写出的队列消息，已经进入网络发送的帧无法撤回；同一连接的后续最新状态仍按顺序到达。事件没有应用层确认，不能保证跨断线恰好投递一次。

实际构建和整场联调需要新版前端及坦克固件。回环 HTTP 测试使用临时构建样例验证静态文件、页面刷新、`/ws` 路由隔离及缺少产物时的行为。

## 本地开发验证

代码、注释、异常、日志、控制台输出及协议消息的内置文案统一使用英文；README 和报告保持中文。

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m ruff check app
.\.venv\Scripts\python.exe -m ruff format --check app
```

当前工作区保留了本地测试时，可继续执行：

```powershell
New-Item -ItemType Directory -Force -Path 'test-results/plan-migration' | Out-Null
.\.venv\Scripts\python.exe -m pytest -q --basetemp=test-results/plan-migration/tmp --junitxml=test-results/plan-migration/junit.xml --cov=app --cov-branch --cov-report=term-missing --cov-report=json:test-results/plan-migration/coverage.json
```

测试、结果、报告与 AGENTS.md 按要求不进入提交。远端克隆没有这些本地测试文件，不能把“没有测试可运行”视为验证通过。树莓派部署、热点和 ESP32 实机行为仍需在对应设备上验证。
