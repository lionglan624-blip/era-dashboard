# Idea: iPhone/Mobile Browser Access

## Concept

Feature Dashboard を iPhone の Safari/Chrome からアクセスできるようにする。外出先から FC/Run 実行・監視が可能に。

## Access Methods

### A. LAN内（自宅WiFi）- 最小構成

```
iPhone (WiFi) → PC (192.168.x.x:5173)
```

**PC側の変更**:
1. Vite を `0.0.0.0` でバインド（vite.config.js: `server.host: '0.0.0.0'`）
2. Express も同様（backend: `app.listen(3001, '0.0.0.0')`）
3. Windows Firewall でポート 5173, 3001 許可

**iPhone側**: インストール不要、ブラウザのみ

### B. 外出先（ngrok）- 推奨

```
iPhone (4G/外出WiFi) → ngrok → PC:5173
```

**PC側の変更**:
1. ngrok インストール: `winget install ngrok`
2. トンネル起動: `ngrok http 5173`
3. 生成URL（例: `https://xxxx.ngrok-free.app`）でアクセス

**iPhone側**: インストール不要、ブラウザのみ

### C. VPN（Tailscale）- セキュア

```
iPhone (Tailscale App) → Tailscale Network → PC:5173
```

**両端にTailscaleインストール必要**

## UI Changes Required

### Responsive CSS

```css
@media (max-width: 600px) {
  .app-header {
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px;
  }

  .header-info {
    flex-wrap: wrap;
    justify-content: center;
  }

  .tile-grid {
    grid-template-columns: 1fr;
  }

  .btn-action {
    padding: 12px 16px;
    min-height: 44px;  /* iOS tap target */
    font-size: 14px;
  }

  .execution-panel {
    height: 80vh;
  }

  .execution-tabs {
    flex-wrap: wrap;
  }

  .exec-tab {
    padding: 10px 14px;
  }

  /* Terminal button hidden on mobile (wt.exe is PC only) */
  .btn-terminal {
    display: none;
  }
}
```

### Touch-Friendly Adjustments

- ボタン最小サイズ 44x44px（iOS HIG推奨）
- タップ領域の余白確保
- ホバー効果を `:active` に変更

## Mobile Capabilities

| Feature | Works | Notes |
|---------|:-----:|-------|
| Feature一覧 | ✅ | |
| ステータス確認 | ✅ | WebSocket同期 |
| Run/FL/FC実行 | ✅ | |
| ログ監視 | ✅ | stream-json |
| Phase表示 | ✅ | |
| AskUserQuestion応答 | ❌ | stdin問題（未解決） |
| Terminalボタン | ❌ | wt.exe PC専用 |
| プロセス停止 | ✅ | |

## Security Considerations

外部公開時は以下を追加:
- Basic認証 or トークン認証
- HTTPS（ngrok/Cloudflareは自動）
- 操作ログ

## Use Case

> 外出中にFCを複数実行開始 → ログ監視 → 帰宅後にFLで仕上げ

## Implementation Priority

1. レスポンシブCSS追加（1-2h）
2. Vite/Express バインド設定
3. LAN内でテスト
4. ngrok設定（外出先対応）
5. （オプション）Basic認証追加

---

## Proxy Configuration

### Current Setup

- **Proxy Address**: `127.0.0.1:8888`
- **Process**: `node "C:\Users\siihe\Proton Drive\doomsism\My files\connection_limiter_proxy.js"`
- **Purpose**: VPN大量リクエスト違反回避用の接続数制限プロキシ

### Dashboard Proxy Support

```bash
# Option 1: Environment variable at startup
set HTTPS_PROXY=http://127.0.0.1:8888 && npm run dev

# Option 2: .env file
echo HTTPS_PROXY=http://127.0.0.1:8888 > tools/feature-dashboard/.env
```

### Daemon/Service Options (for proxy itself)

| Method | Pros | Cons |
|--------|------|------|
| **pm2** | Auto-restart, logs, Node-native | Requires pm2-installer for Windows |
| **nssm** | Windows Service, starts on boot | Manual setup |
| **Task Scheduler** | OS built-in | Less convenient restart |

**Recommended**: pm2

```bash
npm install -g pm2
pm2 start "C:\Users\siihe\Proton Drive\doomsism\My files\connection_limiter_proxy.js" --name proxy
pm2 save
```
