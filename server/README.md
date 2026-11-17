# IoT Tank Battle 服务端

本目录实现开发计划第 1–5 步的工程基础、连接管理、比赛状态机、驾驶转发、开火许可和射击/命中/击杀链路。使用 Python 3.11+、FastAPI 和 Uvicorn，游戏状态保存在单进程内存中。

为支持连续对战，同时接入基础复活、保护期和弹药恢复。此前 reset 和活动比赛断线的占位已替换为可运行的简单策略，详见下文“待确认规则与当前处理”。所有 Wi-Fi 游戏消息仍使用原协议的三个 WebSocket 端点，无新增消息类型或必需字段。

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
    ├── connections.py      # 发送队列、驾驶合并/过期、发送回执和关闭顺序
    ├── arena.py            # 注册、心跳、指令路由、串行处理和事件投递
    └── main.py             # FastAPI 工厂、生命周期和三个 WebSocket 路由
```

当前开发工作区另有以下本地文件，均不提交，克隆仓库后不会自动出现：

- `tests/`：协议、状态机、射击/命中、连接队列、真实 WebSocket 对战及前端解析器兼容测试。
- `test-results/`：测试结果、覆盖率和启动验证日志。
- `local/`：中文总结与待确认事项；当前报告为 `第四五步总结报告.txt`，第一阶段报告仅供回看。
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

树莓派 / Linux：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock -e .
.venv/bin/python -m app
```

无需激活虚拟环境，启动命令会读取 `app/config.toml`，默认监听 `0.0.0.0:8000`。使用 Ctrl+C 停止服务。环境激活后也可使用 `tank-server` 启动。

必须使用单 worker。多个 worker 或多个服务进程之间没有共享游戏状态。重启进程会重新建立初始 lobby，不保存上一局数据。本版本不提供业务 HTTP API、网页静态托管、数据库或账号系统。

## 网络配置

按当前开发要求，先沿用 SSID **`iot-tank-arena`** 和树莓派地址 **`192.168.2.1`**；这是对原协议网络默认值的本次明确调整。

修改 **`app/config.toml`** 的 `[network]` 部分，然后重启服务：

| 配置项 | 当前值 | 作用 |
| --- | --- | --- |
| `ssid` | `iot-tank-arena` | 记录、输出场地 Wi-Fi 名称，不会自动创建或修改系统热点。 |
| `arena_host` | `192.168.2.1` | 记录、输出客户端应连接的地址，不会给树莓派网卡设置 IP。 |
| `bind_host` | `0.0.0.0` | 服务实际监听的本机地址，`0.0.0.0` 表示所有本机 IPv4 接口。 |
| `port` | `8000` | 服务实际监听端口。 |

热点名称和网卡 IP 仍需在树莓派系统中配置，客户端地址也需要同步调整。可通过环境变量 `TANK_SERVER_CONFIG` 指定另一个 TOML 文件；未指定时始终读取包内 `app/config.toml`，不依赖启动时的当前目录。

| 客户端 | 当前连接地址 | 连接后的第一条消息 |
| --- | --- | --- |
| 坦克 1 / 2 | `ws://192.168.2.1:8000/ws/tank` | `{"type":"hello","tank_id":1}`，另一台使用编号 2 |
| 玩家 | `ws://192.168.2.1:8000/ws/player` | `{"type":"hello","tank_id":1,"name":"Yutao"}` |
| 计分 / 观战页 | `ws://192.168.2.1:8000/ws/spectator` | `{"type":"hello"}` |

本机调试可把地址换成 `127.0.0.1`。前端需关闭“模拟演练”，在连接设置中填写上述服务器地址。客户端必须响应服务器每秒发送的 JSON `ping`，原样返回 `ts` 的 `pong`；不能只依赖 WebSocket 控制帧心跳。连续 3 秒没有任何入站消息时，服务端关闭连接。

## 已实现的行为

- 按角色严格校验 hello 和后续消息；整数不接受布尔值、小数或数字字符串，字段和权限不符合协议时返回 `error`。
- hello 成功直接发送对应 `state`，没有额外确认消息；hello 失败先发送 `error` 再关闭连接。已经注册的连接发生普通操作错误时保持连接。
- 同 ID 坦克的新连接替换旧连接；旧连接退出不能将新连接标记为离线。玩家同时独占一台坦克，允许多个观战连接。
- 断线时移除失效连接的活动绑定，坦克显示 `online=false`，无人控制时显示 `player=null`。没有实现身份令牌、名额预留或自动恢复玩家身份。
- 网页在连接、数据变化和每 200 ms 收到完整状态；坦克在连接及 enable 变化时收到最小状态。各连接的输出队列和发送超时相互隔离。
- 计分页发送 `{"type":"game","action":"start"}` 时检查 lobby、两台坦克在线和双方玩家就绪；通过后倒计时 3 秒，再进入 180 秒的 running。
- enable 严格按阶段计算；进入 running / ended 时，在线坦克分别收到 `game_start` / `game_end`。
- 玩家 drive 只转发给其绑定坦克，字段值保持不变；enable=false 时直接丢弃。健康链路按输入频率转发，输入不变也可按 20 Hz 持续发送。失焦停车指令同样正常转发。
- 每个坦克连接只保留最新一条待发送 drive，本地排队达到 300 ms 的指令不重放；禁用、reset 和玩家断线时清理相应待发驾驶指令。坦克端仍须实现协议规定的 300 ms 无 drive 自动停车。
- fire 校验在线、enable、1 秒冷却及正式比赛弹药；成功许可先预扣 1 发，再向坦克发送带有独立循环编号 0–15 的 fire。练习模式不检查或消耗弹药。
- 射击只有在 WebSocket 写入成功后才可用于命中校验；尚未送达、失败或过期的许可不能造成命中。排队失败、发送失败和取消会退还同一局、同一生命中预扣的弹药，最多恢复到 10。
- hit 的目标由已注册的坦克连接确定。校验阶段、实际发送记录、1 秒窗口、去重、存活和复活保护；不因发射者随后死亡或断线而否定已经发出的有效子弹。每次合法格式的命中判定，以及可识别为 hit 的格式错误，都写入日志。
- 有效正式命中扣 1 HP；非致命命中向目标发送 hurt、向射手发送 hit_confirm，向网页广播 hit 及完整 state。
- HP 到 0 时仅结算一次击杀：目标死亡、弹药归 0、deaths 加 1，射手 kills 加 1；发送 death、enable=false、hit_confirm、网页 kill 和 state。致命一发不再额外发送 hurt / 网页 hit。
- 死亡 5 秒后满血满弹复活，具有 2 秒保护；每台活坦克每 3 秒恢复 1 发弹药，上限 10。
- 比赛到时或有效击杀达到 5 时立即结算，击杀多者获胜，平局 `winner=null`。结束后不再自动复活或恢复弹药，等待 reset。客户端不能直接修改分数。

## 待确认规则与当前处理

以下是协议未完全明确、按本次授权采用的简单处理，后续可根据项目要求调整，当前均可运行：

| 事项 | 当前处理 | 主要代码位置 |
| --- | --- | --- |
| 命中窗口边界 | 从成功写入 WebSocket 起算，`0 <= age_ms <= 1000` 有效，1001 ms 失效。 | `game.py::hit` |
| 无效 hit 是否消耗子弹记录 | 只有有效命中才消耗；保护期、自击、死亡等拒绝均不消耗，但仍受原 1 秒窗口限制。 | `game.py::hit` |
| 练习命中反馈 | 发送 hurt、hit_confirm 和网页 hit，HP、弹药及击杀/死亡统计不变；同一发仍只反馈一次。 | `game.py::hit`、`arena.py::_handle_hit` |
| 发送失败与冷却 | 未成功发送或排队满 1 秒的许可作废；退还符合条件的弹药，但仍保留本次许可的 1 秒冷却及已经分配的序号，避免快速重用 4 位编号。成功写入后冷却从该写入时刻起算。失败可能产生编号跳号。 | `game.py::_reconcile_deliveries`、`connections.py` |
| 断线对比赛的影响 | 倒计时和比赛继续，分数和生命数据保留，不暂停、不自动判负；失效玩家绑定释放，允许重新 hello 接管。离线时复活和弹药计时继续。 | `arena.py::_detach`、`game.py::advance` |
| reset 恢复范围 | 保留当前在线连接及玩家绑定；HP=5、弹药=10、alive=true，击杀/死亡清零，winner=null；取消复活、保护和旧射击记录，返回 lobby。 | `game.py::reset` |
| reset 与序号/冷却 | 不重置进程内的射击序号与真实冷却，防止迟到的旧命中错误关联新子弹；清理尚未发送的控制指令。 | `game.py::_fresh_round`、`arena.py::_dispatch` |
| 手动 reset 事件 | countdown/running 时发送 game_end；lobby/ended 时不重复发送。 | `game.py::reset` |
| 弹药恢复周期 | 每台坦克分别从比赛开始或复活时刻起，每 3 秒恢复 1 发；满弹不积攒配额，死亡期间不恢复，复活补满并重新计时。 | `game.py::_advance_lives` |

协议没有发射确认或红外应答，服务端能确认的是 WebSocket 写入成功，不能据此证明物理 IR 已发射；实体红外链路仍需实机验证。语义无效的 hit 只记录拒绝日志，不广播反馈；格式/角色错误仍返回 error。

后续仍需确认最终游戏规则、前端静态托管和树莓派自启动方式，并完成真实硬件、局域网延迟及长时间运行验收。

## 本地开发验证

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m ruff check app
.\.venv\Scripts\python.exe -m ruff format --check app
```

当前工作区保留了本地测试时，可继续执行：

```powershell
.\.venv\Scripts\python.exe -m pytest -q --basetemp=test-results/tmp --junitxml=test-results/junit.xml --cov=app --cov-branch --cov-report=term-missing --cov-report=json:test-results/coverage.json
```

测试、结果、报告与 AGENTS.md 按要求不进入提交。远端克隆没有这些本地测试文件，不能把“没有测试可运行”视为验证通过。树莓派部署、热点和 ESP32 实机行为仍需在对应设备上验证。
