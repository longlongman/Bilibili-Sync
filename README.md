# Bilibili Sync / VideoTogether

一个基于 Flask + Flask-SocketIO 的单房间一起看应用。

用户通过共享密码进入同一个房间后，可以在浏览器里：

- 加载 Bilibili 视频并同步播放、暂停、跳转
- 使用房间聊天实时发消息
- 通过 WebRTC 语音连麦

项目当前是无数据库、单房间、以内存为中心的实现，适合小范围自托管、局域网使用或继续开发演进。

## 当前能力

- 共享密码登录，无注册系统
- 将包含 `BV` 号的 Bilibili 链接规范化为可嵌入播放器地址
- 通过 Socket.IO 广播房间播放状态
- 使用 heartbeat 纠偏，降低客户端播放漂移
- 房间聊天支持历史消息下发、去重和限流
- 浏览器端 WebRTC 语音房，Socket.IO 负责信令转发
- 提供单元测试、集成测试和 Playwright E2E 测试

## 适用场景

- 几个人共用一个房间一起看 B 站视频
- 需要一个简单、可自部署的同步播放原型
- 想在 Flask + Socket.IO 基础上继续扩展房间、持久化、权限和观影体验

## 快速开始

### 1. 安装依赖

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

如果你要跑浏览器端 E2E 测试，再额外安装 Playwright 浏览器：

```bash
python -m playwright install
```

### 2. 启动应用

推荐从仓库根目录使用 `start.sh`：

```bash
APP_SHARED_PASSWORD=changeme USE_HTTPS=0 bash ./start.sh
```

这会：

- 进入 `backend/`
- 自动设置 `PYTHONPATH=backend/src`
- 使用 `gunicorn + gevent-websocket`
- 默认监听 `0.0.0.0:5050`

启动后访问：

```text
http://localhost:5050/login
```

### 3. 开发模式启动

如果你只想本地快速调试，也可以直接跑 Flask-SocketIO 开发服务器：

```bash
cd backend
export PYTHONPATH=src
export APP_SHARED_PASSWORD=changeme
python -m app
```

默认地址：

```text
http://localhost:5000/login
```

## 使用流程

1. 打开 `/login`，输入共享密码。
2. 粘贴一个包含 `BV` 号的 Bilibili 链接。
3. 点击 `Load Video` 加载嵌入播放器。
4. 使用 `Play / Pause / Seek` 控制播放，其他在线用户会同步到相同状态。
5. 在右侧聊天区发送消息，或点击 `Join Voice` 进入语音房。

## 运行方式说明

### `start.sh`

根目录的 `start.sh` 更接近部署入口，默认行为如下：

- 默认端口是 `5050`
- 默认 `SOCKETIO_ASYNC_MODE=gevent`
- 默认 `WORKERS=1`
- 如果存在 `backend/ssl/cert.pem` 和 `backend/ssl/key.pem`，且 `USE_HTTPS=1`，会启用自签名 HTTPS
- 如果存在 `backend/.voice.env`，会自动加载其中的语音相关环境变量

例如启用脚本默认的 HTTPS：

```bash
APP_SHARED_PASSWORD=changeme bash ./start.sh
```

如果浏览器提示证书不受信任，这是因为仓库内证书是自签名证书。

### 直接运行 Python

`python -m app` 适合本地开发，默认端口是 `5000`。  
如果你要写自动化测试或调试前端逻辑，通常这种方式更直接。

## 环境变量

### 应用配置

- `APP_SHARED_PASSWORD`: 登录密码，默认 `changeme`
- `APP_SECRET_KEY`: Flask session 密钥，默认 `dev-secret-key`
- `APP_HOST`: 监听地址，默认 `0.0.0.0`
- `APP_PORT`: 监听端口。`python -m app` 默认 `5000`，`start.sh` 默认 `5050`
- `APP_LOG_LEVEL`: 日志级别，默认 `INFO`
- `SOCKETIO_ASYNC_MODE`: Socket.IO 异步模式，默认 `gevent`
- `SOCKETIO_MESSAGE_QUEUE`: 可选消息队列地址，用于多实例 Socket.IO 广播

### 语音配置

- `APP_WEBRTC_ICE_SERVERS_JSON`: WebRTC ICE server 列表，JSON 数组格式
- `APP_WEBRTC_ICE_TRANSPORT_POLICY`: `all` 或 `relay`

默认 ICE servers 是两个 Google STUN：

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  { "urls": "stun:stun1.l.google.com:19302" }
]
```

`APP_WEBRTC_ICE_SERVERS_JSON` 示例：

```bash
export APP_WEBRTC_ICE_SERVERS_JSON='[{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]'
export APP_WEBRTC_ICE_TRANSPORT_POLICY=relay
```

### `start.sh` 额外变量

- `USE_DEV_SERVER=1`: 改为执行 `python -m app`
- `USE_HTTPS=0`: 禁用脚本中的 HTTPS 模式
- `WORKERS`: gunicorn worker 数量，默认 `1`
- `WORKER_CONNECTIONS`: gevent worker 连接数，默认 `1000`

## 项目结构

```text
.
├── backend/
│   ├── src/
│   │   ├── app/          # Flask app、配置、认证、HTTP 路由
│   │   ├── sync/         # 播放同步、聊天、语音、Socket.IO 事件
│   │   └── video/        # Bilibili 链接校验与日志
│   ├── tests/            # unit / integration / e2e
│   ├── requirements.txt
│   └── Makefile
├── frontend/
│   └── src/
│       ├── static/       # JS / CSS
│       └── templates/    # Jinja2 页面模板
├── specs/                # 需求、设计、计划与验收文档
└── start.sh              # 推荐启动脚本
```

## HTTP 接口

- `GET /login`: 登录页
- `POST /login`: 密码登录
- `POST /logout`: 退出登录
- `POST /video`: 提交 Bilibili 链接并更新房间视频
- `GET /api/chat/history?limit=50`: 拉取最近聊天记录

`/video` 请求示例：

```json
{
  "url": "https://www.bilibili.com/video/BV1xx411c7mD"
}
```

服务端会把它规范化成：

```text
https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0
```

## Socket.IO 事件

### 播放同步

- `state`: 服务端向客户端下发当前房间播放快照
- `control`: 客户端上报 `play` / `pause` / `seek`
- `heartbeat`: 客户端周期性上报播放观察值，服务端在漂移较大时返回纠偏状态

### 聊天

- `chat:history`: 新连接用户收到最近历史消息
- `chat:send`: 发送聊天消息
- `chat:message`: 广播单条聊天消息

聊天是纯内存实现：

- 最多保留最近 `200` 条消息
- 历史接口和连接时下发最多 `50` 条
- 默认限流为每人最少间隔 `1` 秒，每分钟最多 `10` 条

### 语音

- `voice:join`: 进入语音房
- `voice:leave`: 离开语音房
- `voice:user_joined`: 有人加入语音房
- `voice:user_left`: 有人离开语音房
- `voice:signal`: WebRTC offer/answer/ICE 候选转发

## 测试

优先从仓库根目录执行下面这些命令。

### 代码检查

```bash
ruff check backend/src backend/tests
mypy backend/src
```

### 单元测试与集成测试

```bash
pytest backend/tests -q
```

### E2E 测试

先启动应用，再执行：

```bash
python -m playwright install
export RUN_E2E=1
export APP_SHARED_PASSWORD=changeme
export APP_URL=http://localhost:5000
pytest backend/tests/e2e/test_sync_two_clients.py
pytest backend/tests/e2e/test_chat_live.py
pytest backend/tests/e2e/test_chat_history.py
pytest backend/tests/e2e/test_chat_unread_indicator.py
```

如果你使用的是 `start.sh` 默认端口或 HTTPS，记得把 `APP_URL` 改成对应地址。

## 部署与扩展建议

- 当前是单房间设计，所有已登录用户共享同一份播放状态
- 播放状态、聊天历史和语音成员列表都保存在内存里，进程重启后会清空
- `SOCKETIO_MESSAGE_QUEUE` 只能解决 Socket.IO 广播，不会自动把播放状态变成多进程共享
- 如果要安全地做多房间或多实例部署，至少需要补上共享状态存储，例如 Redis 或数据库
- 公开部署前应替换自签名证书，并设置强密码与可靠的 `APP_SECRET_KEY`

## 相关文档

- `specs/001-bilibili-sync-playback/`
- `specs/001-add-room-chat/`
- `backend/tests/e2e/README.md`

如果你准备继续开发，这几个目录能最快说明现有功能边界和测试预期。
