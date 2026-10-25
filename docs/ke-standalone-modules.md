# KE 脱机版（standalone）模块密钥接口

本接口是 `/api/v1/ke/*` 的向后兼容扩展：旧 RoBrowser KE 不发送新字段，响应里也不会
出现 `network` bundle，鉴权、额度、构建校验与 license 内容保持不变。

## 账号权益

- `module:core`：现有核心模块，未变。
- `module:standalone`：脱机版模块。只有拥有该权益的账号才能在 bind 时请求
  `network` 密钥；license 的 `features` 会包含 `standalone`，`key_versions` 会多一个
  `network` 版本。没有该权益的账号请求 `network` 返回
  `403 KE_NOT_ENTITLED`。

管理员在现有权益调整页把资源填成 `module:standalone` 即可，语义与 `module:core` 相同。

## 登录前领取模块密钥（脱机版推荐）

network 模块必须先解密才能登录，而 bind 需要角色身份，因此脱机外壳在登录前调用：

```http
POST /api/v1/ke/modules/keys
Authorization: Bearer ke1_...
Content-Type: application/json

{
  "instance_id": "uuid-v4",
  "modules": ["core", "network"],
  "ke_pub": "<x25519 公钥 base64url>"
}
```

成功响应：

```json
{
  "key_bundles": {
    "core":    { "ephemeral_public": "...", "nonce": "...", "ciphertext": "...", "tag": "..." },
    "network": { "ephemeral_public": "...", "nonce": "...", "ciphertext": "...", "tag": "..." }
  }
}
```

- 只依赖 Bearer 与 `instance_id`/`ke_pub`，不创建实例、不依赖角色身份。
- `core` 需要 `module:core`；`network` 需要 `module:standalone`，否则 403 `KE_NOT_ENTITLED`。
- 服务端未配置对应密钥时返回 503 `KE_UNAVAILABLE`。
- 每账号每小时最多 30 次；未知/重复/空 `modules` 返回 400。

## bind 请求（可选路径）

```http
POST /api/v1/ke/instances/bind
Authorization: Bearer ke1_...
Content-Type: application/json

{
  "instance_id": "uuid-v4",
  "aid": 1, "cid": 2, "nid": 3,
  "char_name": "...", "map_name": "...",
  "build_id": "...", "build_hash": "<standalone core 密文 sha256>",
  "need_wasm_key": true,
  "need_modules": ["network"],
  "ke_pub": "<x25519 公钥 base64url>"
}
```

- `need_modules` 只接受白名单 `network`；未知模块、重复模块、非数组返回
  `400 KE_BAD_REQUEST`。
- `need_modules` 必须与 `need_wasm_key: true` 一起使用。
- start 也接受同名字段。脱机外壳通常使用上面的 `/modules/keys`；bind 路径保留给
  已有角色身份、需要重新领取模块密钥的客户端。

## bind 响应（可选路径）

```json
{
  "instance_id": "uuid-v4",
  "key_bundles": {
    "core":    { "ephemeral_public": "...", "nonce": "...", "ciphertext": "...", "tag": "..." },
    "network": { "ephemeral_public": "...", "nonce": "...", "ciphertext": "...", "tag": "..." }
  }
}
```

- `core` 与现有行为完全一致。
- `network` 使用 `KE_NETWORK_KEY` 包裹，HKDF info 为 `ltsd-ke-network-v1`，
  salt/AAD 为 `instance_id`；解包后得到 32 字节 AES-256-GCM 密钥，用于解密
  `network.wasm.enc`（AAD 为 `build_id`）。
- 服务端未配置 `KE_NETWORK_KEY` 时返回 `503 KE_UNAVAILABLE`，且不会写库。

## license

拥有 `module:standalone` 且服务端配置了 network 密钥时：

```json
{
  "features": ["core", "standalone"],
  "key_versions": { "core": 1, "network": 2 }
}
```

旧客户端只读取 `core`，额外的 `network` 条目不会影响验签或授权。

## 构建登记

脱机包的登记 payload 在原有 7 个字段上增加：

```json
{
  "network_sha256": "<network.wasm.enc sha256>",
  "network_key_version": 2,
  "standalone_package_id": "<standalone manifest packageId>"
}
```

三个字段必须同时出现；服务端按 `kind = standalone` 入库，并要求
`network_key_version` 与线上 `KE_NETWORK_KEY_VERSION` 一致。web 构建不发送这三个字段，
仍按 `kind = web` 处理，audience 与旧版本逐字一致。
