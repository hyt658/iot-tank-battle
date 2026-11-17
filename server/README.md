# IoT Tank Battle 服务端

本目录实现开发计划的工程基础、连接管理，以及协议已明确的比赛状态机。使用 Python 3.11+、FastAPI 和 Uvicorn，游戏状态保存在单进程内存中。

目前可以联调身份注册、状态同步、心跳、开始比赛、倒计时和结算。驾驶转发、开火许可、命中扣血、弹药恢复及复活属于后续步骤，尚未实现。**reset 和比赛中途断线的规则保留明确占位，不能用本版本完成重置或断线恢复流程。**

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
    ├── policies.py         # 等待确认的 reset、比赛中断线规则占位
    ├── game.py             # 不依赖网络、可注入时间的比赛状态机
    ├── connections.py      # 单连接发送队列、发送超时和关闭顺序
    ├── arena.py            # 注册映射、串行调度、心跳和状态/事件投递
    └── main.py             # FastAPI 工厂、生命周期和三个 WebSocket 路由
```

当前开发工作区另有以下本地文件，均不提交，克隆仓库后不会自动出现：

- `tests/`：协议、状态机、连接队列、配置和真实 WebSocket 测试。
- `test-results/`：测试结果、覆盖率和启动验证日志。
- `local/`：中文总结与待确认事项。
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
- 比赛到时或内部击杀计数达到 5 时结算，击杀多者获胜，平局 `winner=null`。击杀数据目前仅有内部状态机入口，尚无命中处理链路，客户端不能直接修改分数。

## 尚待确认与后续范围

`app/policies.py` 中两个函数会明确抛出待确认异常：

1. `reset_match()`：协议的“数据清零”未明确玩家/连接是否保留、HP/弹药如何恢复，以及 reset 时是否发送 `game_end`。当前返回 `error`，不修改比赛数据。ended 后需要重启服务，暂不支持正常开始下一局。
2. `active_match_disconnect()`：countdown / running 中坦克或玩家断线后，是继续、暂停还是结束，协议未规定。当前清理失效连接、发送 `error`，并将状态机自动推进留在待实现分支；不新增协议外阶段，也不结算胜负。原阶段和截止时刻不会被重写，剩余时间仍按原截止时刻显示，可能降至 0。重连不会解除这个占位，需要确认规则并实现后才能恢复正常流程。

这些占位是当前版本的功能缺口，不应解释为已经确定的游戏规则。驾驶、射击和命中消息虽然有严格模型，仍会返回后续步骤尚未实现的 `error`；enable=false 时的 drive 按协议直接丢弃。

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
