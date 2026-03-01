/**
 * 同時接続数制限プロキシ
 *
 * 問題: Claude CLI 7セッションが同時に数百の接続を開く
 *       → VPNの不正利用検知に引っかかる
 *
 * 解決: このプロキシで同時接続数を制限
 *       → 「一瞬で数千件」を防止
 *
 * 動作:
 *   - Anthropic APIへの同時接続を最大10件に制限
 *   - 超過分はキューに入れて順番待ち
 *   - 接続が終了したら次のリクエストを処理
 *
 * 使用方法:
 *   node connection_limiter_proxy.js
 *   set HTTPS_PROXY=http://127.0.0.1:8888
 *   claude
 */

const http = require('http');
const net = require('net');

// グローバルエラーハンドラ（クラッシュ防止）
process.on('uncaughtException', (err) => {
    // 接続リセット等の一般的なエラーは無視
    if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(err.code)) {
        return;
    }
    console.error('[FATAL]', err.message);
});

process.on('unhandledRejection', (reason) => {
    // 無視
});

const CONFIG = {
    port: 8888,
    // ホストごとの最大同時接続数
    maxConcurrentPerHost: 1000,
    // 全体の最大同時接続数
    maxConcurrentTotal: 1000,
    // 統計表示間隔（ミリ秒）
    statsInterval: 5000,
};

// ホストごとのアクティブ接続数
const activePerHost = new Map();
// ホストごとの待機キュー
const waitingQueue = new Map();
// 全体のアクティブ接続数
let totalActive = 0;
// ホストごとの最後の失敗時刻
const lastFailure = new Map();
// 失敗後のクールダウン（ミリ秒）
const FAILURE_COOLDOWN_MS = 100;

// 統計
const stats = {
    totalRequests: 0,
    immediateConnections: 0,
    queuedByLimit: 0,      // 同時接続制限によるキュー
    queuedByCooldown: 0,   // 失敗クールダウンによるキュー
    blocked: 0,            // ブロックされた接続
    peakConcurrent: 0,
    peakQueue: 0,
};

// ブロックするホスト（DNS解決不可など）
// 切り替え: true=ブロック有効, false=ブロック無効
const ENABLE_BLOCK = true;

const BLOCKED_HOSTS = [
    'statsig.anthropic.com',
];

function getHostKey(hostname) {
    // Anthropic関連は同一グループとして扱う
    if (hostname.includes('anthropic')) {
        return 'anthropic';
    }
    return hostname;
}

function isBlocked(hostname) {
    if (!ENABLE_BLOCK) return false;
    return BLOCKED_HOSTS.some(h => hostname.includes(h));
}

function tryConnect(hostname, port, clientSocket, head) {
    // ブロックリストチェック
    if (isBlocked(hostname)) {
        stats.blocked++;
        clientSocket.write('HTTP/1.1 502 Blocked by proxy\r\n\r\n');
        clientSocket.end();
        return;
    }

    const key = getHostKey(hostname);

    if (!activePerHost.has(key)) {
        activePerHost.set(key, 0);
        waitingQueue.set(key, []);
    }

    const active = activePerHost.get(key);
    const queue = waitingQueue.get(key);

    // 失敗クールダウン中かチェック
    const lastFail = lastFailure.get(key) || 0;
    const now = Date.now();
    if (now - lastFail < FAILURE_COOLDOWN_MS) {
        // クールダウン中はキューに入れて遅延
        stats.queuedByCooldown++;
        queue.push({ hostname, port, clientSocket, head });
        setTimeout(() => processQueue(key), FAILURE_COOLDOWN_MS);
        return;
    }

    // 制限チェック
    if (active >= CONFIG.maxConcurrentPerHost || totalActive >= CONFIG.maxConcurrentTotal) {
        stats.queuedByLimit++;
        const queueSize = queue.length + 1;
        if (queueSize > stats.peakQueue) stats.peakQueue = queueSize;

        // QUEUEログは表示しない（統計で確認可能）
        queue.push({ hostname, port, clientSocket, head });
        return;
    }

    // 接続実行
    executeConnect(key, hostname, port, clientSocket, head);
}

function executeConnect(key, hostname, port, clientSocket, head) {
    const currentActive = activePerHost.get(key) + 1;
    activePerHost.set(key, currentActive);
    totalActive++;

    if (totalActive > stats.peakConcurrent) {
        stats.peakConcurrent = totalActive;
    }

    stats.immediateConnections++;
    // CONNECTログは表示しない（統計で確認可能）

    const serverSocket = net.connect(port, hostname, () => {
        try {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) {
                serverSocket.write(head);
            }
            serverSocket.pipe(clientSocket);
            clientSocket.pipe(serverSocket);
        } catch (e) {
            // 接続が既に閉じている場合は無視
        }
    });

    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;

        try {
            serverSocket.unpipe(clientSocket);
            clientSocket.unpipe(serverSocket);
            serverSocket.destroy();
            clientSocket.destroy();
        } catch (e) {
            // エラーは無視
        }

        // アクティブ数を減らす
        const newActive = Math.max(0, activePerHost.get(key) - 1);
        activePerHost.set(key, newActive);
        totalActive = Math.max(0, totalActive - 1);

        // CLOSEログは表示しない（統計で確認可能）

        // キューから次のリクエストを処理
        processQueue(key);
    };

    serverSocket.on('end', cleanup);
    serverSocket.on('error', () => {
        // 失敗時刻を記録（クールダウン用）
        lastFailure.set(key, Date.now());
        cleanup();
    });
    serverSocket.on('close', cleanup);

    clientSocket.on('end', cleanup);
    clientSocket.on('error', cleanup);
    clientSocket.on('close', cleanup);
}

function processQueue(key) {
    const queue = waitingQueue.get(key);
    if (!queue || queue.length === 0) return;

    const active = activePerHost.get(key);
    if (active >= CONFIG.maxConcurrentPerHost || totalActive >= CONFIG.maxConcurrentTotal) {
        return;
    }

    const next = queue.shift();
    // DEQUEUEログは表示しない（統計で確認可能）
    executeConnect(key, next.hostname, next.port, next.clientSocket, next.head);
}

// HTTPプロキシサーバー
const server = http.createServer((req, res) => {
    if (req.url === '/stats') {
        let queueTotal = 0;
        waitingQueue.forEach((q) => queueTotal += q.length);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            active: totalActive,
            queued: queueTotal,
            peak: stats.peakConcurrent,
            totalRequests: stats.totalRequests,
        }));
        return;
    }
    if (req.url === '/hosts') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(hostnameLog, null, 2));
        return;
    }
    res.writeHead(400);
    res.end('This proxy only supports CONNECT method for HTTPS');
});

// ホスト名ログ（直近N件を保持、/hosts で取得可能）
const HOSTNAME_LOG_MAX = 200;
const hostnameLog = [];

server.on('connect', (req, clientSocket, head) => {
    stats.totalRequests++;
    const [hostname, portStr] = req.url.split(':');
    const port = parseInt(portStr) || 443;

    // ホスト名をタイムスタンプ付きで記録
    hostnameLog.push({ ts: new Date().toISOString(), host: hostname, port });
    if (hostnameLog.length > HOSTNAME_LOG_MAX) hostnameLog.shift();

    tryConnect(hostname, port, clientSocket, head);
});

// 統計表示
setInterval(() => {
    let queueTotal = 0;
    waitingQueue.forEach((q) => queueTotal += q.length);

    console.log('\n' + '='.repeat(50));
    console.log('Statistics');
    console.log('='.repeat(50));
    console.log(`Total requests:        ${stats.totalRequests}`);
    console.log(`Immediate connections: ${stats.immediateConnections}`);
    console.log(`Queued (limit):        ${stats.queuedByLimit}`);
    console.log(`Queued (cooldown):     ${stats.queuedByCooldown}`);
    console.log(`Blocked:               ${stats.blocked}`);
    console.log(`Currently active:      ${totalActive}`);
    console.log(`Currently queued:      ${queueTotal}`);
    console.log(`Peak concurrent:       ${stats.peakConcurrent}`);
    console.log(`Peak queue size:       ${stats.peakQueue}`);

    // メモリ使用量
    const mem = process.memoryUsage();
    console.log(`Memory (heap):         ${Math.round(mem.heapUsed / 1024 / 1024)} MB`);

    // ホストごとの状態
    console.log('\nPer-host status:');
    activePerHost.forEach((active, key) => {
        const queue = waitingQueue.get(key);
        const qLen = queue ? queue.length : 0;
        if (active > 0 || qLen > 0) {
            console.log(`  ${key}: active=${active}, queued=${qLen}`);
        }
    });
    console.log('='.repeat(50) + '\n');
}, CONFIG.statsInterval);

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log('Proxy is already running on port ' + CONFIG.port);
        console.log('This window can be closed.');
        process.exit(0);
    }
    throw err;
});

server.listen(CONFIG.port, '127.0.0.1', () => {
    console.log('='.repeat(50));
    console.log('Connection Limiter Proxy for Claude Code CLI');
    console.log('='.repeat(50));
    console.log(`Listening on: http://127.0.0.1:${CONFIG.port}`);
    console.log(`Max concurrent per host: ${CONFIG.maxConcurrentPerHost}`);
    console.log(`Max concurrent total:    ${CONFIG.maxConcurrentTotal}`);
    console.log('');
    console.log('This proxy prevents "burst" connections that trigger');
    console.log('VPN abuse detection by limiting concurrent connections.');
    console.log('');
    console.log('Usage (run in each terminal before starting Claude):');
    console.log('  set HTTPS_PROXY=http://127.0.0.1:8888');
    console.log('  set HTTP_PROXY=http://127.0.0.1:8888');
    console.log('  claude');
    console.log('='.repeat(50));
    console.log('');
});
