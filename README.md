# dsh-go-adb-link · ADB 自动连接

DSH Go 原生插件：自动找到手机上的 ADB TCP 端口（Stellar/Shizuku 的 TCP 通道、
`adb tcpip`），用本机 adb 连上并保持，之后在 DSH 的 bash 里直接 `adb shell …`。
*Native dsh-go plugin: finds the phone's ADB TCP port and keeps adb connected.*

- 输入框上方状态条：`ADB 已连接 · 3455` / `ADB 未连接` / `ADB 待授权`
- 点状态条打开面板：状态、端口、设备、adb 客户端、自动重连，按钮 `连接 / 扫描端口 / 断开 / 复制命令`
- 引擎启动时自动重连；掉线后自动重试；手机重启后端口变了会后台重扫（10 分钟最多一次）
- **连接成功后向 AI 注入一段提示**：需要系统级能力（appops/权限、安装卸载、读取受保护数据、截图、模拟输入、进程/电量查询等）且 adb 更省事时，AI 会**主动**用 adb，而不是绕路或先问一句
- adb 客户端缺失时（例如运行时升级重置了 `/usr`）点「连接」会 `apt-get install -y adb` 自动补回

只适用于 **DSH Go 手机版（本机引擎）**：它要能从手机自己的 Ubuntu 环境里连到本机 adbd。

## 安装

- **市场**：DSH Go `设置 › 插件 › 插件市场` 搜索「ADB 自动连接」，安装到本机
- **npm**（在手机上本机环境执行）：

  ```sh
  dsh plugin --profile web add dsh-go-adb-link
  ```

- **本地目录**（开发）：

  ```sh
  dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/dsh-go-adb-link"
  ```

装完状态条立即出现在输入框上方；`lib/` 代码改动需要到 App 的「引擎」页重启引擎。

## 首次授权（只需一次）

第一次连接时手机会弹出「允许 USB 调试吗」。请点**允许**，并**勾选「始终允许使用这台计算机进行调试」**。
勾了之后重连不再弹窗，插件才能全自动；没勾的话每次重连都要再点一次。

## 端口不是 3455 也能用吗

- **同一个手机换了端口**：可以。点「连接」会全端口扫描（1–65535），发 ADB 握手找 adbd，
  不看端口号；扫描只认 `CNXN`/`AUTH` 应答，并过滤 TCP 自连造成的误报。
- **另一个手机打开了 adb**：插件跑在哪台手机的环境里就找哪台，不会去连别的设备的局域网端口。
- **只支持经典 ADB over TCP**（`adb tcpip`、Stellar 的 TCP 功能）。Android 11+ 原生
  「无线调试」是 TLS 配对端口，纯 ADB 握手探测不到。

自动重连先试记住的端口和 `3455`、`5555`；都不通且之前授权过，会在后台重扫。

## 数据与安全

- 运行记忆写在 `$DSH_HOME/dsh-go/adb-link/state.json`（端口、是否授权、是否自动重连），
  不在插件包内，卸载/升级不会带走或误发。
- 插件会执行本机的 `adb` 程序；缺 adb 时会调用 `apt-get install -y adb`。
- 不读取剪贴板、输入框、对话内容；只连 `127.0.0.1` 上识别出的 adbd。
- 本机 adb server（`127.0.0.1:5037`）与 bash 共享，所以插件连上后普通 `adb` 命令也能用。

## 卸载

```sh
dsh plugin --profile web remove dsh-go-adb-link
```

也可以直接在 App 的插件详情里卸载。

## 更新日志

- **1.2.3**：连接成功后注入「主动使用 adb」的系统提示（系统级操作用 adb，不先问用户）；
  保留原有的自动查找端口、自动重连与面板。
- 0.1.0：首个版本，状态条 + 面板 + 自动连接。

## License

MIT
