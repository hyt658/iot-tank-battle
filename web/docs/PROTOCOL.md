# 通信协议

组内统一用。要改就先在群里说一声，再改这份文件。

## 1. 整体怎么通信

```text
控制页（浏览器）──┐
                ├── 服务器 ── 坦克（ESP32）
计分页（浏览器）──┘
```

- 所有 Wi-Fi 消息都经过服务器，网页和坦克不直接通信。
- 这里没有 GET、POST 那种接口。每个客户端启动后连上服务器，连接一直保持，双方随时可以给对方发消息。
- 每条消息都是一段 JSON 文本。`type` 表示这是哪种消息，可以把它当成接口名。

浏览器里收发消息的写法：

```js
const ws = new WebSocket("ws://10.42.0.1:8000/ws/player");

// Send one message
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", tank_id: 1, name: "Yutao" }));
};

// Handle each incoming message by its type
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "state") {
    // Update the page
  }
};
```

## 2. 连接地址

树莓派开 2.4 GHz 热点，SSID 是 `tank-arena`，大家都连这个 Wi-Fi。

| 客户端 | 地址 |
|---|---|
| 坦克 | `ws://10.42.0.1:8000/ws/tank` |
| 控制页 | `ws://10.42.0.1:8000/ws/player` |
| 计分页 | `ws://10.42.0.1:8000/ws/spectator` |

## 3. 所有消息一览

**所有连接都有：**

| 消息 | 谁发 | 谁收 | 什么时候发 |
|---|---|---|---|
| `hello` | 坦克、控制页、计分页 | 服务器 | 连上后的第一条消息 |
| `ping` | 服务器 | 坦克、控制页、计分页 | 每秒一次 |
| `pong` | 坦克、控制页、计分页 | 服务器 | 收到 `ping` 后立刻回 |
| `error` | 服务器 | 坦克、控制页、计分页 | 操作失败时 |

**坦克连接（`/ws/tank`）：**

| 消息 | 谁发 | 谁收 | 什么时候发 |
|---|---|---|---|
| `drive` | 服务器 | 坦克 | 收到控制页的 `drive` 后转发 |
| `fire` | 服务器 | 坦克 | 开火检查通过后 |
| `hit` | 坦克 | 服务器 | 收到对方的 IR 信号时 |
| `state` | 服务器 | 坦克 | 连接成功时，以及坦克的状态发生变化时 |
| `event` | 服务器 | 坦克 | 发生和这台坦克有关的事时 |

**网页连接（`/ws/player`、`/ws/spectator`）：**

| 消息 | 谁发 | 谁收 | 什么时候发 |
|---|---|---|---|
| `drive` | 控制页 | 服务器 | 每秒 20 次 |
| `fire` | 控制页 | 服务器 | 玩家按开火键时 |
| `state` | 服务器 | 控制页、计分页 | 连接成功时、每 200 ms、数据变化时 |
| `event` | 服务器 | 控制页、计分页 | 有命中或击杀时 |
| `game` | 计分页 | 服务器 | 点开始或重置按钮时 |

## 4. 每条消息的格式

### 4.1 所有连接都有的消息

#### `hello`：告诉服务器我是谁

```json
{"type":"hello","tank_id":1}
{"type":"hello","tank_id":1,"name":"Yutao"}
{"type":"hello"}
```

三行分别是坦克、控制页和计分页发的。

| 字段 | 类型 | 说明 |
|---|---|---|
| `tank_id` | 整数 | `1` 或 `2`。坦克填自己的编号，控制页填要控制的坦克，计分页不填 |
| `name` | 字符串 | 玩家名字，只有控制页填 |

成功后，坦克和网页都会收到各自的 `state`。

失败时服务器发 `error` 并断开连接，比如 `tank_id` 不存在，或这台坦克已经有人控制。

同一台坦克重连时，新连接顶掉旧连接。

#### `ping` 和 `pong`：检查连接是否还在

```json
{"type":"ping","ts":123456}
{"type":"pong","ts":123456}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `ts` | 整数 | 服务器填的时间值，客户端不用理解，原样带回 |

3 秒没收到对方的消息就算断线。客户端断线后每秒重连一次。

#### `error`：告诉客户端操作失败了

```json
{"type":"error","message":"没有弹药"}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `message` | 字符串 | 失败原因，直接显示或打印 |

### 4.2 控制坦克的消息（控制页 → 服务器 → 坦克）

`drive` 和 `fire` 两条连接上都有，所以放在一起说明。

#### `drive`：控制履带和炮塔

```json
{"type":"drive","left":60,"right":-60,"turret":-15}
```

控制页发给服务器，服务器原样转发给坦克。坦克 `state` 里的 `enable` 为 `false` 时，服务器直接丢弃。

| 字段 | 类型 | 说明 |
|---|---|---|
| `left` | 整数 | 左履带速度，`-100` 到 `100`，正数前进，负数后退 |
| `right` | 整数 | 右履带速度，范围同上 |
| `turret` | 整数 | 炮塔目标角度，`-90` 到 `90`，`0` 朝前，负数偏左，正数偏右 |

| 动作 | `left` | `right` |
|---|---|---|
| 前进 | `60` | `60` |
| 后退 | `-60` | `-60` |
| 原地右转 | `60` | `-60` |
| 停车 | `0` | `0` |

控制页要做到：

- 输入没变也要固定每秒发 20 次。
- 窗口失焦时马上发一次 `left` 和 `right` 都为 `0` 的 `drive`，防止按键松开的事件丢失。
- 收到的 `state` 里 `status` 变成 `running` 时，把炮塔角度设回 `0`。炮塔角度只由控制页决定，坦克不会自己回正，否则下一条 `drive` 又会把它转回去。

坦克要做到：

- 收到后更新电机和舵机。
- 300 ms 没收到 `drive` 或断线时，立刻停车。

#### `fire`：开火

控制页发给服务器，没有其他字段：

```json
{"type":"fire"}
```

服务器按以下条件检查：

- 坦克在线，而且坦克 `state` 里的 `enable` 为 `true`。
- 距离上次开火至少 1 秒。
- 弹药大于 0。练习模式不检查这一条。

不满足就回 `error`。通过后，服务器把弹药减 1，再发给坦克：

```json
{"type":"fire","shot":3}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `shot` | 整数 | 子弹编号，`0` 到 `15`，由服务器分配。每台坦克单独计数，到 `15` 后回到 `0` |

坦克收到后，把自己的 `tank_id` 和 `shot` 编进 IR 信号发射出去。

### 4.3 坦克连接上的消息

#### `hit`：报告自己被打中

```json
{"type":"hit","shooter":2,"shot":7}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `shooter` | 整数 | 从 IR 信号解出的开火坦克编号 |
| `shot` | 整数 | 从 IR 信号解出的子弹编号 |

被打中的是发送这条消息的坦克，服务器从连接就能知道，所以消息里不用写。

同一发子弹只报一次，自己打的不报。

#### `state`（坦克）：坦克现在的状态

```json
{"type":"state","enable":true}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `enable` | 布尔值 | `true`：正常执行 `drive` 和 `fire`。`false`：立刻停车，忽略 `drive` 和 `fire`，但照常回 `pong` 和报 `hit` |

连接成功时发一次，之后有字段变化时再发一份完整的。坦克只看最新的一份。

坦克开机和重连后，收到第一份 `state` 之前按 `enable` 为 `false` 处理。

`enable` 由服务器根据比赛阶段和坦克是否活着决定（见第 6 节），坦克不自己推算。

#### `event`（坦克）：告诉坦克发生了和它有关的事

```json
{"type":"event","kind":"hurt"}
```

| `kind` 的值 | 含义 |
|---|---|
| `hurt` | 自己被打中了 |
| `death` | 自己被击毁了 |
| `hit_confirm` | 自己打中了别人，击毁对方的那一发也发这个 |
| `respawn` | 自己复活了 |
| `game_start` | 比赛开始了 |
| `game_end` | 比赛结束了 |

服务器只告诉坦克发生了什么，怎么反应（比如响哪段声音）由坦克自己决定。坦克遇到不认识的 `kind` 会直接忽略，所以以后可以放心加新的。

### 4.4 网页连接上的消息

#### `state`（网页）：当前完整的比赛数据

网页直接用它刷新界面，不用自己计算血量和弹药。

```json
{
  "type": "state",
  "status": "running",
  "time_left_ms": 142000,
  "winner": null,
  "tanks": [
    {"id":1,"player":"Yutao","online":true,"alive":true,"hp":3,"ammo":6,"kills":2,"deaths":1,"respawn_ms":0},
    {"id":2,"player":"Jianqi","online":true,"alive":false,"hp":0,"ammo":0,"kills":1,"deaths":2,"respawn_ms":3200}
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | 字符串 | 比赛阶段：`lobby`、`countdown`、`running`、`ended` |
| `time_left_ms` | 整数 | 当前阶段还剩多少毫秒，`lobby` 和 `ended` 时为 `0` |
| `winner` | 整数或 `null` | 获胜坦克的编号，比赛没结束或平局时为 `null` |
| `tanks` | 数组 | 每台坦克一项 |

`tanks` 里每一项的字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 整数 | 坦克编号 |
| `player` | 字符串或 `null` | 玩家名字，没人控制时为 `null` |
| `online` | 布尔值 | 坦克是否在线 |
| `alive` | 布尔值 | 坦克是否活着 |
| `hp` | 整数 | 当前血量，`0` 到 `5` |
| `ammo` | 整数 | 当前弹药，`0` 到 `10` |
| `kills` | 整数 | 击杀数 |
| `deaths` | 整数 | 死亡数 |
| `respawn_ms` | 整数 | 还有多少毫秒复活，活着时为 `0` |

#### `event`（网页）：显示击杀提示

```json
{"type":"event","kind":"hit","shooter":1,"target":2,"hp":3}
{"type":"event","kind":"kill","shooter":1,"target":2}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | 字符串 | `hit` 表示命中，`kill` 表示击杀 |
| `shooter` | 整数 | 开火的坦克 |
| `target` | 整数 | 被打中的坦克 |
| `hp` | 整数 | 目标剩余血量，只有 `hit` 才有 |

#### `game`：开始或重置比赛

```json
{"type":"game","action":"start"}
{"type":"game","action":"reset"}
```

| `action` 的值 | 含义 |
|---|---|
| `start` | 开始比赛。必须在 `lobby` 阶段，两台坦克都在线且都有玩家，否则回 `error` |
| `reset` | 结束当前比赛，回到 `lobby`，数据清零 |

## 5. 一局比赛的消息过程

**连接：**

```text
坦克1 → 服务器    {"type":"hello","tank_id":1}
服务器 → 坦克1    {"type":"state","enable":true}
控制页 → 服务器   {"type":"hello","tank_id":1,"name":"Yutao"}
服务器 → 控制页   {"type":"state","status":"lobby", ...}
```

**开始比赛：**

```text
计分页 → 服务器   {"type":"game","action":"start"}
服务器 → 坦克     {"type":"state","enable":false}
服务器 → 网页     {"type":"state","status":"countdown","time_left_ms":3000, ...}

3 秒后：
服务器 → 坦克     {"type":"state","enable":true}
服务器 → 坦克     {"type":"event","kind":"game_start"}
服务器 → 网页     {"type":"state","status":"running", ...}
```

**开车：**

```text
控制页 → 服务器   {"type":"drive","left":60,"right":60,"turret":0}
服务器 → 坦克1    {"type":"drive","left":60,"right":60,"turret":0}
```

**坦克 1 打中坦克 2：**

```text
控制页 → 服务器   {"type":"fire"}
服务器 → 坦克1    {"type":"fire","shot":3}
坦克1 → 坦克2     红外信号（不经过 Wi-Fi）
坦克2 → 服务器    {"type":"hit","shooter":1,"shot":3}
服务器 → 坦克2    {"type":"event","kind":"hurt"}
服务器 → 坦克1    {"type":"event","kind":"hit_confirm"}
服务器 → 网页     {"type":"event","kind":"hit","shooter":1,"target":2,"hp":3}
服务器 → 网页     {"type":"state", ...}
```

**坦克 2 被击毁并复活：**

```text
服务器 → 坦克2    {"type":"event","kind":"death"}
服务器 → 坦克2    {"type":"state","enable":false}
服务器 → 坦克1    {"type":"event","kind":"hit_confirm"}
服务器 → 网页     {"type":"event","kind":"kill","shooter":1,"target":2}
服务器 → 网页     {"type":"state", ...}

5 秒后：
服务器 → 坦克2    {"type":"state","enable":true}
服务器 → 坦克2    {"type":"event","kind":"respawn"}
服务器 → 网页     {"type":"state", ...}
```

## 6. 比赛阶段

| `status` | 坦克的 `enable` | 说明 |
|---|---|---|
| `lobby` | `true` | 练习模式，可以开车和开火，不扣血也不耗弹 |
| `countdown` | `false` | 倒计时 3 秒 |
| `running` | 活着 `true`，死了 `false` | 正式比赛 |
| `ended` | `false` | 显示结果，等待 `reset` |

## 7. 命中判定

服务器收到 `hit` 后，下面的条件都满足才算有效，每次判定结果都写进日志：

- 比赛在 `lobby` 或 `running` 阶段。
- 这发子弹在 1 秒内确实发射过，而且还没算过命中。
- 目标活着，不是刚复活的 2 秒保护期。

## 8. IR 编码

用标准 NEC 格式，38 kHz 载波，每发子弹连发 3 帧，帧间隔 108 ms。

| 字节 | 内容 |
|---|---|
| 第 1 字节 | `0x54` |
| 第 2 字节 | `0xAB` |
| 第 3 字节 | `(shooter << 4) | shot` |
| 第 4 字节 | 第 3 字节按位取反 |

例子：坦克 1 的第 3 发是 `54 AB 13 EC`。不同的库打印 NEC 值时位序可能相反，也可能显示成 `0x2AD5C837`。

## 9. 游戏数值

先按这个来，测试时再调。

- 血量 5，每次命中扣 1。
- 弹药 10，每 3 秒回 1 发，复活时补满。
- 开火间隔 1 秒。
- 死亡 5 秒后原地复活。
- 比赛 3 分钟，或有人先到 5 杀就结束。击杀多的赢，相同算平局。
